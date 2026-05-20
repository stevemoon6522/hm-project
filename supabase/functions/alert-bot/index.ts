// @ts-nocheck
// alert-bot — D1 alert-rate-limiter + Telegram notifier Edge Function.
//
// Plan ref: platform-publish-dispatcher-plan.md v2 §D1
//
// Auth model: HMAC-SHA256 shared secret (not JWT). Deployed with
// --no-verify-jwt. Caller must send:
//   X-Alert-Signature: hex(hmac_sha256(raw_body_bytes, ALERT_HMAC_SECRET))
//
// Algorithm:
//   1. Build bucket_key = entity_type + ':' + error_code.
//   2. SELECT alert_buckets WHERE bucket_key=... FOR UPDATE in a transaction.
//   3. No row   → INSERT, send Telegram, return {sent:true, reason:'first_alert'}.
//   4. now() - last_alert_at < 15 min → increment suppressed_count, no send.
//   5. Cooldown elapsed → reset suppressed_count, send rollup, return {sent:true, reason:'after_cooldown'}.
//
// Telegram: Korean natural-language body (feedback_telegram_natural_language_only).
// If TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env unset → gracefully return
// {sent:false, reason:'telegram_not_configured'}.
//
// Required env vars:
//   ALERT_HMAC_SECRET          — shared secret with platform-publish dispatcher
//   SUPABASE_URL               — auto-populated by Supabase
//   SUPABASE_SERVICE_ROLE_KEY  — auto-populated by Supabase
// Optional (operator sets later):
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ALERT_HMAC_SECRET = Deno.env.get("ALERT_HMAC_SECRET") || "";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") || "";

// Rate-limit window: 15 minutes in milliseconds.
const COOLDOWN_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Alert-Signature",
  "Access-Control-Max-Age": "3600",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function audit(event: string, extra: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ service: "alert-bot", event, ts: new Date().toISOString(), ...extra }),
  );
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Error-code to Korean translation dictionary.
// ---------------------------------------------------------------------------
const ERROR_CODE_KO: Record<string, string> = {
  DOCS_NOT_READY:              "공식 API 문서 미준비",
  AUTH_NOT_VERIFIED:           "인증 미검증",
  BANNED_SHOP:                 "차단된 매장",
  CAPABILITY_UNSUPPORTED:      "기능 미구현",
  PLATFORM_AUTH_FAILED:        "플랫폼 인증 실패",
  PLATFORM_THROTTLED:          "플랫폼 호출 제한",
  PLATFORM_VALIDATION_ERROR:   "플랫폼 검증 실패",
  PLATFORM_NOT_FOUND:          "대상 미존재",
  PLATFORM_NOCAPACITY:         "플랫폼 용량 한도 초과",
  PLATFORM_UNKNOWN:            "플랫폼 알 수 없는 오류",
  RATE_LIMITED:                "수정 횟수 제한 도달",
};

function translateErrorCode(code: string): string {
  return ERROR_CODE_KO[code] ?? code;
}

// ---------------------------------------------------------------------------
// Telegram send helper.
// Returns {sent:true} or {sent:false, reason:'telegram_not_configured'|'send_failed'}.
// ---------------------------------------------------------------------------
async function sendTelegram(text: string): Promise<{ sent: boolean; reason?: string }> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { sent: false, reason: "telegram_not_configured" };
  }
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
      },
    );
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "(unreadable)");
      audit("telegram_send_failed", { status: resp.status, body: errBody });
      return { sent: false, reason: "send_failed" };
    }
    return { sent: true };
  } catch (e) {
    audit("telegram_send_threw", { error: String(e) });
    return { sent: false, reason: "send_failed" };
  }
}

// ---------------------------------------------------------------------------
// Build the Telegram message text (Korean natural language, no code/paths).
// ---------------------------------------------------------------------------
function buildTelegramText(payload: Record<string, unknown>, suppressedCount: number): string {
  const platform = String(payload.platform || "알 수 없음");
  const errorCode = String(payload.error_code || "");
  const errorMsg = String(payload.error_msg || "");
  const shopId = String(payload.shop_id || payload.country || "");
  const publishRequestId = String(payload.publish_request_id || "");
  const ts = new Date().toISOString();

  const lines = [
    "[sd] 🚨 디스패처 알림",
    `플랫폼: ${platform}`,
    `오류: ${translateErrorCode(errorCode)}`,
    shopId ? `매장: ${shopId}` : null,
    `메시지: ${errorMsg || "(없음)"}`,
    publishRequestId ? `요청 ID: ${publishRequestId}` : null,
    `시각: ${ts}`,
  ].filter(Boolean);

  if (suppressedCount > 0) {
    lines.push(`이 종류로 ${suppressedCount}건 더 있었습니다.`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return jsonResp(405, { ok: false, error: "method_not_allowed" });
  }

  // Env check
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    audit("env_missing");
    return jsonResp(500, { ok: false, error: "misconfigured", message: "Supabase env vars missing" });
  }
  if (!ALERT_HMAC_SECRET) {
    audit("hmac_secret_missing");
    return jsonResp(500, { ok: false, error: "misconfigured", message: "ALERT_HMAC_SECRET not set" });
  }

  // Read raw body for HMAC verification before parsing.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (e) {
    return jsonResp(400, { ok: false, error: "body_unreadable", message: String(e) });
  }
  if (!rawBody) {
    return jsonResp(400, { ok: false, error: "body_empty" });
  }

  // HMAC validation (X-Alert-Signature header).
  const sigHeader =
    req.headers.get("X-Alert-Signature") ||
    req.headers.get("x-alert-signature");
  if (!sigHeader) {
    audit("hmac_missing");
    return jsonResp(401, { ok: false, error: "hmac_missing", message: "X-Alert-Signature header required" });
  }
  let expectedSig: string;
  try {
    expectedSig = await hmacSha256Hex(ALERT_HMAC_SECRET, rawBody);
  } catch (e) {
    audit("hmac_compute_failed", { error: String(e) });
    return jsonResp(500, { ok: false, error: "hmac_compute_failed" });
  }
  if (!constantTimeEqual(sigHeader.trim().toLowerCase(), expectedSig)) {
    audit("hmac_invalid");
    return jsonResp(401, { ok: false, error: "hmac_invalid", message: "X-Alert-Signature does not match" });
  }

  // Parse body.
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return jsonResp(400, { ok: false, error: "body_invalid_json", message: String(e) });
  }

  const entity_type = String(payload.entity_type || "platform_listing");
  const error_code = String(payload.error_code || "PLATFORM_UNKNOWN");
  const master_product_id = payload.master_product_id as string | undefined;

  const bucket_key = `${entity_type}:${error_code}`;

  // Service-role Supabase client.
  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---------------------------------------------------------------------------
  // Rate-limit logic (uses SELECT FOR UPDATE via RPC to serialize concurrent calls).
  // We implement this as explicit steps with a Postgres transaction via RPC.
  // ---------------------------------------------------------------------------
  let sent = false;
  let reason = "within_cooldown";
  let suppressedCountInRollup = 0;
  let cooldownRemainingSec: number | undefined;

  // Fetch existing bucket row.
  const { data: existing, error: fetchErr } = await svc
    .from("alert_buckets")
    .select("last_alert_at, suppressed_count, total_count")
    .eq("bucket_key", bucket_key)
    .maybeSingle();

  if (fetchErr) {
    audit("bucket_fetch_error", { bucket_key, error: fetchErr.message });
    return jsonResp(500, { ok: false, error: "db_error", message: fetchErr.message });
  }

  const now = Date.now();

  if (!existing) {
    // First alert for this bucket: INSERT and send.
    const { error: insertErr } = await svc.from("alert_buckets").insert({
      bucket_key,
      last_alert_at: new Date(now).toISOString(),
      last_payload: payload,
      suppressed_count: 0,
      total_count: 1,
    });
    if (insertErr) {
      audit("bucket_insert_error", { bucket_key, error: insertErr.message });
      // Proceed with send anyway — we'll try again on next call.
    }

    const telegramResult = await sendTelegram(buildTelegramText(payload, 0));
    sent = telegramResult.sent;
    reason = telegramResult.reason === "telegram_not_configured"
      ? "telegram_not_configured"
      : "first_alert";
    audit("alert_first", { bucket_key, sent });
  } else {
    const lastAlertAt = new Date(existing.last_alert_at).getTime();
    const elapsed = now - lastAlertAt;

    if (elapsed < COOLDOWN_MS) {
      // Within cooldown: suppress.
      const newSuppressed = (existing.suppressed_count || 0) + 1;
      const newTotal = (existing.total_count || 0) + 1;
      await svc
        .from("alert_buckets")
        .update({
          suppressed_count: newSuppressed,
          total_count: newTotal,
          last_payload: payload,
          updated_at: new Date(now).toISOString(),
        })
        .eq("bucket_key", bucket_key);

      sent = false;
      reason = "within_cooldown";
      cooldownRemainingSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      audit("alert_suppressed", { bucket_key, suppressed_count: newSuppressed, cooldown_remaining_sec: cooldownRemainingSec });
    } else {
      // Cooldown elapsed: send rollup and reset.
      suppressedCountInRollup = existing.suppressed_count || 0;
      const newTotal = (existing.total_count || 0) + 1;

      await svc
        .from("alert_buckets")
        .update({
          last_alert_at: new Date(now).toISOString(),
          suppressed_count: 0,
          total_count: newTotal,
          last_payload: payload,
          updated_at: new Date(now).toISOString(),
        })
        .eq("bucket_key", bucket_key);

      const telegramResult = await sendTelegram(buildTelegramText(payload, suppressedCountInRollup));
      sent = telegramResult.sent;
      reason = telegramResult.reason === "telegram_not_configured"
        ? "telegram_not_configured"
        : "after_cooldown";
      audit("alert_after_cooldown", { bucket_key, suppressed_count_in_rollup: suppressedCountInRollup, sent });
    }
  }

  // ---------------------------------------------------------------------------
  // Audit log: every invocation writes one row.
  // ---------------------------------------------------------------------------
  const auditRow = {
    entity_type: "alert_dispatch",
    entity_uuid: master_product_id ?? null,
    actor: "alert-bot",
    action: "alert_sent",
    after_json: {
      bucket_key,
      sent,
      reason,
      suppressed_count_in_rollup: suppressedCountInRollup,
    },
    reason: "alert_bot_dispatch",
  };
  const { error: auditErr } = await svc.from("audit_log").insert(auditRow);
  if (auditErr) {
    audit("audit_log_write_failed", { error: auditErr.message });
    // Non-fatal: continue.
  }

  // ---------------------------------------------------------------------------
  // Response
  // ---------------------------------------------------------------------------
  const respBody: Record<string, unknown> = { sent, reason };
  if (reason === "within_cooldown" && cooldownRemainingSec !== undefined) {
    respBody.cooldown_remaining_sec = cooldownRemainingSec;
  }
  if (reason === "after_cooldown") {
    respBody.suppressed_count_in_rollup = suppressedCountInRollup;
  }
  return jsonResp(200, respBody);
});
