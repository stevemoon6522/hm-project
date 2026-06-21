import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CRON_SECRET =
  Deno.env.get("SD_AUTOMATION_CRON_SECRET") ||
  Deno.env.get("STARONE_CRON_SECRET") ||
  Deno.env.get("CRON_SECRET") ||
  "";
const SD_TELEGRAM_BOT_TOKEN = Deno.env.get("SD_TELEGRAM_BOT_TOKEN") || "";
const SD_TELEGRAM_CHAT_ID = Deno.env.get("SD_TELEGRAM_CHAT_ID") || "";
const ALERT_BOT_URL = Deno.env.get("ALERT_BOT_URL") || "";
const ALERT_HMAC_SECRET = Deno.env.get("ALERT_HMAC_SECRET") || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResp(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function cronAuthorized(req: Request): boolean {
  if (!CRON_SECRET) return false;
  const headerSecret = req.headers.get("x-cron-secret") || "";
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return headerSecret === CRON_SECRET || bearer === CRON_SECRET;
}

function n(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isTransientFailure(row: any): boolean {
  const haystack = [
    row?.error_msg,
    row?.response?.error,
    row?.response?.message,
    row?.response?.result?.message,
    row?.response?.result?.error,
  ].map((v) => String(v || "").toLowerCase()).join(" ");
  if (!haystack.trim()) return false;
  return /timeout|timed out|network|fetch|temporar|rate|429|too many|503|502|504|token|auth|expired|connection|econn|reset/.test(haystack);
}

async function sendTelegram(text: string) {
  if (!SD_TELEGRAM_BOT_TOKEN || !SD_TELEGRAM_CHAT_ID) {
    return { sent: false, reason: "telegram_not_configured" };
  }
  const resp = await fetch(`https://api.telegram.org/bot${SD_TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: SD_TELEGRAM_CHAT_ID, text }),
  });
  if (!resp.ok) {
    return { sent: false, reason: "telegram_send_failed", status: resp.status, body: await resp.text().catch(() => "") };
  }
  return { sent: true };
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
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendAlertBot(payload: Record<string, unknown>) {
  if (!ALERT_HMAC_SECRET) {
    return { sent: false, reason: "alert_bot_not_configured" };
  }
  const raw = JSON.stringify(payload);
  const sig = await hmacSha256Hex(ALERT_HMAC_SECRET, raw);
  const urls = Array.from(new Set([
    ALERT_BOT_URL,
    `${SUPABASE_URL}/functions/v1/alert-bot`,
  ].filter(Boolean)));
  let last: Record<string, unknown> = { sent: false, reason: "alert_bot_url_missing" };
  for (const url of urls) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Alert-Signature": sig,
      },
      body: raw,
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok && body?.sent !== false) {
      return { sent: true, via: "alert-bot", url, body };
    }
    last = { sent: false, reason: body?.reason || body?.error || "alert_bot_send_failed", status: resp.status, url, body };
  }
  return last;
}

async function sendDigest(summary: Record<string, unknown>, text: string) {
  const direct = await sendTelegram(text);
  if (direct.sent) return { ...direct, via: "telegram-direct" };
  const alert = await sendAlertBot({
    entity_type: "sd_daily_digest",
    error_code: "SD_DAILY_DIGEST",
    error_msg: text,
    ...summary,
  });
  return alert.sent ? alert : { sent: false, direct, alert };
}

async function countRows(supabase: any, table: string, build: (q: any) => any) {
  const q = build(supabase.from(table).select("id", { count: "exact", head: true }));
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

async function buildDailyDigest(supabase: any) {
  const [pendingSources, preOrder, readyStock, failed, retryErrors] = await Promise.all([
    countRows(supabase, "source_records", (q) => q.eq("source_type", "staronemall").eq("status", "pending_review")),
    countRows(supabase, "products", (q) => q.eq("lifecycle_state", "pre_order")),
    countRows(supabase, "products", (q) => q.eq("lifecycle_state", "ready_stock")),
    countRows(supabase, "shopee_mutation_log", (q) => q.eq("actor", "v2-wizard").eq("status", "error")),
    countRows(supabase, "sd_automation_retry_log", (q) => q.eq("status", "error").gte("created_at", new Date(Date.now() - 86400000).toISOString())),
  ]);
  const summary = {
    pending_staronemall_sources: pendingSources,
    pre_order_products: preOrder,
    ready_stock_products: readyStock,
    failed_mutations: failed,
    retry_errors_24h: retryErrors,
  };
  const text = [
    "[sd] Daily automation summary",
    `StarOneMall registration candidates: ${pendingSources}`,
    `PRE ORDER: ${preOrder}`,
    `READY STOCK: ${readyStock}`,
    `Failed mutation logs: ${failed}`,
    `Retry errors in 24h: ${retryErrors}`,
    "Price/cost change detection is excluded",
  ].join("\n");
  return { summary, text };
}

async function retryTransientFailures(supabase: any, limit = 10) {
  const { data: rows, error } = await supabase
    .from("shopee_mutation_log")
    .select("id,run_id,action,region,request_payload,response,error_msg,created_at")
    .eq("actor", "v2-wizard")
    .eq("status", "error")
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw error;

  const candidates = (rows || []).filter(isTransientFailure);
  const retried: any[] = [];
  const skipped: any[] = [];
  for (const row of candidates) {
    if (retried.length >= limit) break;
    const { data: priorRows, error: priorErr } = await supabase
      .from("sd_automation_retry_log")
      .select("id,created_at,status")
      .eq("source_log_id", row.id)
      .order("created_at", { ascending: false })
      .limit(5);
    if (priorErr) throw priorErr;
    const prior = priorRows || [];
    const lastAt = prior[0]?.created_at ? new Date(prior[0].created_at).getTime() : 0;
    if (prior.length >= 2 || (lastAt && Date.now() - lastAt < 6 * 3600000)) {
      skipped.push({ id: row.id, reason: "retry_limit_or_cooldown" });
      continue;
    }

    const resp = await fetch(`${SUPABASE_URL}/functions/v1/shopee-bridge?action=v2_resume_failed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({
        log_ids: [row.id],
        resume_run_id: `auto-retry-${new Date().toISOString()}`,
        operator_id: "sd-automation-cron",
      }),
    });
    const body = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
    const ok = resp.ok && body?.ok !== false;
    const insert = {
      source_log_id: row.id,
      action: row.action || "unknown",
      run_id: row.run_id || null,
      attempt_no: prior.length + 1,
      status: ok ? "ok" : "error",
      response: body,
      error_msg: ok ? null : String(body?.error || body?.message || `HTTP ${resp.status}`),
    };
    const { error: insErr } = await supabase.from("sd_automation_retry_log").insert(insert);
    if (insErr) throw insErr;
    retried.push({ id: row.id, ok, response: body });
  }
  return { candidates: candidates.length, retried, skipped };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return jsonResp(405, { ok: false, error: "method_not_allowed" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return jsonResp(500, { ok: false, error: "supabase_env_missing" });
  if (!cronAuthorized(req)) return jsonResp(401, { ok: false, error: "unauthorized" });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const body = await req.json().catch(() => ({}));
  const mode = String(body.mode || "all");
  const out: Record<string, unknown> = { ok: true, mode };

  if (mode === "all" || mode === "retry_failed") {
    out.retry = await retryTransientFailures(supabase, n(body.limit) || 10);
  }
  if (mode === "all" || mode === "daily_digest") {
    const digest = await buildDailyDigest(supabase);
    out.digest = digest.summary;
    out.telegram = await sendDigest(digest.summary, digest.text);
  }
  return jsonResp(200, out);
});
