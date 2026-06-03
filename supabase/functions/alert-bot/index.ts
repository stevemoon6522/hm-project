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
//   2. HMAC validation.
//   3. If TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID unset → 503, no bucket touch.
//   4. Call evaluate_alert_bucket RPC (atomic SELECT FOR UPDATE inside Postgres).
//   5. If should_send=false → suppress, write audit_log, return within_cooldown.
//   6. If should_send=true → sendTelegram.
//        Success → write audit_log (sent:true), return ok.
//        Failure → call rollback_alert_bucket to restore prev state,
//                   write audit_log (sent:false), return telegram_send_failed.
//
// Audit_log is written only after HMAC validation passes (not on 401 paths).
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
  DOCS_NOT_READY:                    "공식 API 문서 미준비",
  AUTH_NOT_VERIFIED:                 "인증 미검증",
  BANNED_SHOP:                       "차단된 매장",
  CAPABILITY_UNSUPPORTED:            "기능 미구현",
  PLATFORM_AUTH_FAILED:              "플랫폼 인증 실패",
  PLATFORM_THROTTLED:                "플랫폼 호출 제한",
  PLATFORM_VALIDATION_ERROR:         "플랫폼 검증 실패",
  PLATFORM_NOT_FOUND:                "대상 미존재",
  PLATFORM_NOCAPACITY:               "플랫폼 용량 한도 초과",
  PLATFORM_UNKNOWN:                  "플랫폼 알 수 없는 오류",
  RATE_LIMITED:                      "수정 횟수 제한 도달",
  SKU_ASCII_ONLY:                    "SKU 영문 전용 위반",
  QOO10_CATEGORY_UNMAPPED:           "Qoo10 카테고리 미매핑",
  EBAY_CATEGORY_ID_MISSING:          "eBay 카테고리 ID 누락",
  OFFER_PUBLISH_OUT_OF_SCOPE:        "eBay 발행 범위 외",
  EBAY_ASPECT_SCHEMA_INVALID:        "eBay 속성 스키마 불일치",
  EBAY_ASPECT_VALUE_TOO_LONG:        "eBay 속성 값 길이 초과",
  ALIBABA_REQUIRED_ATTRS_MISSING:    "Alibaba 필수 속성 누락",
  ALIBABA_SHIPPING_TEMPLATE_MISSING: "Alibaba 배송 템플릿 누락",
  IDEMPOTENT_REPLAY:                 "중복 요청 재사용",
};

function translateErrorCode(code: string): string {
  return ERROR_CODE_KO[code] ?? code;
}

// ---------------------------------------------------------------------------
// Telegram send helper.
// Returns {sent:true} or {sent:false, reason:'send_failed', error:string}.
// ---------------------------------------------------------------------------
async function sendTelegram(
  text: string,
): Promise<{ sent: boolean; reason?: string; error?: string }> {
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
      return { sent: false, reason: "send_failed", error: `HTTP ${resp.status}: ${errBody}` };
    }
    return { sent: true };
  } catch (e) {
    audit("telegram_send_threw", { error: String(e) });
    return { sent: false, reason: "send_failed", error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Build the Telegram message text (Korean natural language, no code/paths).
// ---------------------------------------------------------------------------
function buildTelegramText(payload: Record<string, unknown>, suppressedCount: number): string {
  const entityType = String(payload.entity_type || "");
  if (entityType === "sd_daily_digest") {
    const pending = Number(payload.pending_staronemall_sources || 0);
    const preOrder = Number(payload.pre_order_products || 0);
    const readyStock = Number(payload.ready_stock_products || 0);
    const failed = Number(payload.failed_mutations || 0);
    const retryErrors = Number(payload.retry_errors_24h || 0);
    const lines = [
      "[sd] Daily automation summary",
      `🛒 StarOneMall registration candidates: ${pending}`,
      `⏳ PRE ORDER: ${preOrder}`,
      `✅ READY STOCK: ${readyStock}`,
      `⚠️ Failed mutation logs: ${failed}`,
      `🔁 Retry errors in 24h: ${retryErrors}`,
      "🚫 가격/원가 변경 감지는 제외됨",
    ];
    if (suppressedCount > 0) lines.push(`same bucket suppressed: ${suppressedCount}`);
    return lines.join("\n");
  }
  // Phase C — region-by-region summary for Shopee multi-region publish.
  if (entityType === "shopee_multi_region_publish") {
    const sku = String(payload.sku || "");
    const regionsRequested = Number(payload.regions_requested || 0);
    const regionsOk = Number(payload.regions_ok || 0);
    const regionsFailed = Number(payload.regions_failed || 0);
    const summary = Array.isArray(payload.summary) ? payload.summary as any[] : [];
    const okList = summary
      .filter((s) => s.status === "mapped")
      .map((s) => `${s.region}${s.shop_item_id ? ` (${s.shop_item_id})` : ""}`);
    const failList = summary
      .filter((s) => s.status !== "mapped")
      .map((s) => `${s.region}: ${s.error || "원인 미확인"}`);
    const lines = [
      regionsFailed === 0
        ? `[sd] ✅ Shopee 등록 성공 ${regionsOk}/${regionsRequested}`
        : regionsOk === 0
          ? `[sd] 🚨 Shopee 등록 실패 ${regionsFailed}/${regionsRequested}`
          : `[sd] ⚠️ Shopee 등록 일부 성공 ${regionsOk}/${regionsRequested}`,
      sku ? `상품: ${sku}` : null,
      okList.length ? `성공 지역: ${okList.join(", ")}` : null,
      failList.length ? `실패 지역:\n- ${failList.join("\n- ")}` : null,
    ].filter(Boolean);
    return lines.join("\n");
  }

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

  // ---------------------------------------------------------------------------
  // P0 #3 fix: check Telegram config BEFORE touching alert_buckets.
  // If the bot token is not yet configured, return 503 immediately.
  // This prevents the bucket from being poisoned during the operator-setup
  // period, so the first real alert after token is set is not suppressed.
  // ---------------------------------------------------------------------------
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    audit("telegram_not_configured");
    return jsonResp(503, { sent: false, reason: "telegram_not_configured" });
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

  const bucketKey = `${entity_type}:${error_code}`;

  // Service-role Supabase client.
  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---------------------------------------------------------------------------
  // P0 #1 fix: atomic bucket evaluation via SECURITY DEFINER RPC.
  // The RPC uses SELECT FOR UPDATE inside a Postgres transaction, serializing
  // concurrent calls on the same bucket_key so no two callers can both observe
  // "no row" or "cooldown elapsed" and both forward to Telegram.
  // ---------------------------------------------------------------------------
  const { data: evalRows, error: evalErr } = await svc.rpc("evaluate_alert_bucket", {
    p_bucket_key: bucketKey,
    p_payload: payload,
  });
  if (evalErr) {
    audit("evaluate_bucket_error", { bucket_key: bucketKey, error: evalErr.message });
    return jsonResp(500, { ok: false, error: "db_error", message: evalErr.message });
  }
  const evalResult = evalRows[0];
  const {
    should_send,
    suppressed_count_for_rollup,
    prev_last_alert_at,
    prev_suppressed_count,
  } = evalResult;

  // ---------------------------------------------------------------------------
  // Suppressed path: within cooldown window.
  // ---------------------------------------------------------------------------
  if (!should_send) {
    const lastAlertAt = prev_last_alert_at ? new Date(prev_last_alert_at).getTime() : Date.now();
    const cooldownRemainingSec = Math.max(
      0,
      Math.ceil((15 * 60 * 1000 - (Date.now() - lastAlertAt)) / 1000),
    );
    audit("alert_suppressed", { bucket_key: bucketKey, cooldown_remaining_sec: cooldownRemainingSec });

    // Write audit_log for suppressed event.
    await svc.from("audit_log").insert({
      entity_type: "alert_dispatch",
      entity_uuid: master_product_id ?? null,
      actor: "alert-bot",
      action: "alert_sent",
      after_json: { bucket_key: bucketKey, sent: false, reason: "within_cooldown" },
      reason: "alert_bot_dispatch",
    });

    return jsonResp(200, {
      sent: false,
      reason: "within_cooldown",
      cooldown_remaining_sec: cooldownRemainingSec,
    });
  }

  // ---------------------------------------------------------------------------
  // Send path: cooldown elapsed (or first alert).
  // P0 #2 fix: sendTelegram runs AFTER evaluate_alert_bucket has updated the
  // bucket. On failure we call rollback_alert_bucket to restore prev state so
  // the next 15-minute window is not silently eaten.
  // ---------------------------------------------------------------------------
  const telegramResult = await sendTelegram(
    buildTelegramText(payload, suppressed_count_for_rollup),
  );

  if (!telegramResult.sent) {
    // Rollback bucket to pre-evaluate state so the alert is not silently lost.
    audit("telegram_failed_rolling_back", {
      bucket_key: bucketKey,
      error: telegramResult.error,
    });
    await svc.rpc("rollback_alert_bucket", {
      p_bucket_key: bucketKey,
      p_prev_last_alert_at: prev_last_alert_at,
      p_prev_suppressed_count: prev_suppressed_count,
    });

    // Write audit_log for failed send.
    await svc.from("audit_log").insert({
      entity_type: "alert_dispatch",
      entity_uuid: master_product_id ?? null,
      actor: "alert-bot",
      action: "alert_sent",
      after_json: {
        bucket_key: bucketKey,
        sent: false,
        reason: "telegram_send_failed",
        error: telegramResult.error,
        rolled_back: true,
      },
      reason: "alert_bot_dispatch",
    });

    return jsonResp(200, {
      sent: false,
      reason: "telegram_send_failed",
      error: telegramResult.error,
    });
  }

  // Telegram send succeeded.
  const sendReason = prev_last_alert_at === null ? "first_alert" : "after_cooldown";
  audit("alert_sent", {
    bucket_key: bucketKey,
    reason: sendReason,
    suppressed_count_in_rollup: suppressed_count_for_rollup,
  });

  // Write audit_log for successful send.
  await svc.from("audit_log").insert({
    entity_type: "alert_dispatch",
    entity_uuid: master_product_id ?? null,
    actor: "alert-bot",
    action: "alert_sent",
    after_json: {
      bucket_key: bucketKey,
      sent: true,
      reason: sendReason,
      suppressed_count_in_rollup: suppressed_count_for_rollup,
    },
    reason: "alert_bot_dispatch",
  });

  return jsonResp(200, {
    sent: true,
    reason: sendReason,
    ...(suppressed_count_for_rollup > 0
      ? { suppressed_count_in_rollup: suppressed_count_for_rollup }
      : {}),
  });
});
