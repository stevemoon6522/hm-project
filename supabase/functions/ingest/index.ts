// @ts-nocheck
// ingest — private HMAC-protected entry point for crawl results.
//
// Step 1a (plan v2.2 §C.3): replaces the original "iau Railway → Supabase REST
// with service-role key" path. Codex P0 #8 flagged that as a credentials-leak
// risk (public-facing Railway app would have to hold the service-role key).
// This Edge Function ingests the same payload but:
//   - only accepts HMAC-SHA256 signed requests (shared secret env var)
//   - keeps the service-role key inside the Edge Function only
//   - rejects source_type='staronemall' so Railway can never accidentally
//     route StarOneMall traffic through a non-KR IP path (the dedicated
//     starone-crawl Edge Function in Step 1b is the only legitimate sender
//     for that source_type, and it inserts directly via service-role)
//
// Required env vars on deployment:
//   INGEST_HMAC_SECRET           - shared secret with the Railway shim
//   SUPABASE_URL                 - auto-populated by Supabase
//   SUPABASE_SERVICE_ROLE_KEY    - auto-populated by Supabase
//
// Request contract:
//   POST /ingest
//   Headers:
//     Content-Type: application/json
//     X-Ingest-Signature: hex(hmac_sha256(raw_body_bytes, INGEST_HMAC_SECRET))
//   Body (JSON):
//     {
//       source_type: 'yes24' | 'weverse' | 'manual' | 'csv_import',
//       source_external_id?: string,
//       source_url: string,
//       parser_version: string,
//       raw_payload: object,
//       observed_values: object,
//       crawl_run_id?: string  (uuid, generated if absent)
//     }
//
// Responses:
//   200 { ok: true, id: <uuid>, crawl_run_id }
//   400 { ok: false, error, message }
//   401 { ok: false, error: 'hmac_missing'|'hmac_invalid' }
//   403 { ok: false, error: 'source_type_rejected' }   for staronemall
//   500 server-side failures (insert failed, etc.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const INGEST_HMAC_SECRET = Deno.env.get("INGEST_HMAC_SECRET") || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-client-info, X-Ingest-Signature",
  "Access-Control-Max-Age": "3600",
};

const ALLOWED_SOURCE_TYPES = new Set([
  "yes24",
  "weverse",
  "manual",
  "csv_import",
]);
// staronemall is intentionally EXCLUDED from the Railway-shim path —
// it MUST come through the dedicated starone-crawl Edge Function (Step 1b)
// so the request originates from a Seoul-region (Korean) IP.
const REJECTED_SOURCE_TYPES = new Set(["staronemall"]);

// Codex P1 #3: sources that MUST carry a non-null source_external_id so the
// (source_type, source_external_id, parser_version) unique index actually
// catches replays. manual / csv_import may have null because they're
// operator-driven and dedupe is not expected.
const SOURCES_REQUIRING_EXTERNAL_ID = new Set(["yes24", "weverse"]);

// Codex P1 #2: hard cap on body bytes to prevent memory exhaustion. 2 MiB
// is way more than any legitimate crawl payload (typical: 5-50 KB).
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function jsonResp(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function audit(event, payload = {}) {
  console.log(
    JSON.stringify({
      service: "ingest",
      event,
      ts: new Date().toISOString(),
      ...payload,
    }),
  );
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isUuidLike(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return jsonResp(405, { ok: false, error: "method_not_allowed" });
  }

  // Env check
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    audit("env_missing");
    return jsonResp(500, {
      ok: false,
      error: "ingest_misconfigured",
      message: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env var missing",
    });
  }
  if (!INGEST_HMAC_SECRET) {
    audit("hmac_secret_missing");
    return jsonResp(500, {
      ok: false,
      error: "ingest_misconfigured",
      message: "INGEST_HMAC_SECRET env var missing",
    });
  }

  // Codex P1 #2: enforce body size limit BEFORE buffering everything in memory.
  // Check Content-Length first (fast path); if missing or untrusted, still
  // enforce after read.
  const contentLengthHeader = req.headers.get("Content-Length");
  const declaredLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    audit("payload_too_large_declared", { declared_length: declaredLength });
    return jsonResp(413, {
      ok: false,
      error: "payload_too_large",
      message: `body exceeds ${MAX_BODY_BYTES} bytes (declared ${declaredLength})`,
    });
  }

  // Read the raw body so we can HMAC-verify it BEFORE parsing.
  let rawBody;
  try {
    rawBody = await req.text();
  } catch (e) {
    return jsonResp(400, {
      ok: false,
      error: "body_unreadable",
      message: e instanceof Error ? e.message : String(e),
    });
  }
  if (!rawBody) {
    return jsonResp(400, { ok: false, error: "body_empty" });
  }
  // Recheck size after read (Content-Length can be absent or spoofed).
  // The TextEncoder gives byte length of the UTF-8 encoding, which is what
  // HMAC operates on.
  const actualBytes = new TextEncoder().encode(rawBody).byteLength;
  if (actualBytes > MAX_BODY_BYTES) {
    audit("payload_too_large_actual", { bytes: actualBytes });
    return jsonResp(413, {
      ok: false,
      error: "payload_too_large",
      message: `body exceeds ${MAX_BODY_BYTES} bytes (actual ${actualBytes})`,
    });
  }

  // HMAC verification.
  const sigHeader =
    req.headers.get("X-Ingest-Signature") ||
    req.headers.get("x-ingest-signature");
  if (!sigHeader) {
    audit("hmac_missing");
    return jsonResp(401, {
      ok: false,
      error: "hmac_missing",
      message: "X-Ingest-Signature header required",
    });
  }
  let expectedSig;
  try {
    expectedSig = await hmacSha256Hex(INGEST_HMAC_SECRET, rawBody);
  } catch (e) {
    audit("hmac_compute_failed", { reason: String(e) });
    return jsonResp(500, {
      ok: false,
      error: "hmac_compute_failed",
      message: "Could not compute HMAC",
    });
  }
  if (!constantTimeEqual(sigHeader.trim().toLowerCase(), expectedSig)) {
    audit("hmac_invalid");
    return jsonResp(401, {
      ok: false,
      error: "hmac_invalid",
      message: "X-Ingest-Signature does not match",
    });
  }

  // Parse + validate body.
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    return jsonResp(400, {
      ok: false,
      error: "body_invalid_json",
      message: e instanceof Error ? e.message : String(e),
    });
  }

  const source_type = String(body.source_type || "").trim();
  if (!source_type) {
    return jsonResp(400, {
      ok: false,
      error: "missing_source_type",
    });
  }
  if (REJECTED_SOURCE_TYPES.has(source_type)) {
    audit("source_type_rejected", { source_type });
    return jsonResp(403, {
      ok: false,
      error: "source_type_rejected",
      message:
        "staronemall must go through the starone-crawl Edge Function (Seoul region for KR IP); Railway shim is not allowed.",
    });
  }
  if (!ALLOWED_SOURCE_TYPES.has(source_type)) {
    return jsonResp(400, {
      ok: false,
      error: "unknown_source_type",
      message: `source_type='${source_type}' is not in allowlist`,
    });
  }

  const source_url = String(body.source_url || "").trim();
  if (!source_url) {
    return jsonResp(400, { ok: false, error: "missing_source_url" });
  }
  const parser_version = String(body.parser_version || "").trim();
  if (!parser_version) {
    return jsonResp(400, { ok: false, error: "missing_parser_version" });
  }
  const raw_payload = body.raw_payload;
  if (!raw_payload || typeof raw_payload !== "object") {
    return jsonResp(400, {
      ok: false,
      error: "missing_raw_payload",
      message: "raw_payload must be an object",
    });
  }
  const observed_values = body.observed_values;
  if (!observed_values || typeof observed_values !== "object") {
    return jsonResp(400, {
      ok: false,
      error: "missing_observed_values",
      message: "observed_values must be an object",
    });
  }
  const source_external_id =
    body.source_external_id != null
      ? String(body.source_external_id).trim() || null
      : null;
  // Codex P1 #3: dedupe relies on (source_type, source_external_id,
  // parser_version) — if any required source comes without an external_id,
  // we'd insert duplicates forever. Reject upfront with a clear error.
  if (
    SOURCES_REQUIRING_EXTERNAL_ID.has(source_type) &&
    !source_external_id
  ) {
    return jsonResp(400, {
      ok: false,
      error: "missing_source_external_id",
      message: `source_type='${source_type}' requires source_external_id (yes24 goodsNo, weverse product id, etc.) for replay dedupe.`,
    });
  }
  const crawl_run_id = isUuidLike(body.crawl_run_id)
    ? body.crawl_run_id
    : crypto.randomUUID();

  // Compute hash of the canonical raw_payload for dedupe/audit (NOT unique).
  let raw_payload_hash;
  try {
    raw_payload_hash = await sha256Hex(JSON.stringify(raw_payload));
  } catch (e) {
    return jsonResp(500, {
      ok: false,
      error: "hash_failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Insert. The (source_type, source_external_id, parser_version) unique
  // index handles "same crawl, same parser_version" idempotency — duplicate
  // inserts return the existing row's id.
  const insertPayload = {
    source_type,
    source_external_id,
    source_url,
    crawl_run_id,
    parser_version,
    raw_payload,
    raw_payload_hash,
    observed_values,
    confidence: Number.isFinite(body.confidence) ? body.confidence : 50,
    tier: Number.isFinite(body.tier) ? body.tier : 2,
    status: "pending_review",
  };

  const { data, error } = await supabase
    .from("source_records")
    .insert(insertPayload)
    .select("id, crawl_run_id, status, fetched_at")
    .single();

  if (error) {
    // Handle duplicate-key (already exists for same source_external_id +
    // parser_version) by returning the existing row's id.
    if (
      /duplicate key|source_records_external_uniq/i.test(error.message || "")
    ) {
      const { data: existing } = await supabase
        .from("source_records")
        .select("id, crawl_run_id, status, fetched_at")
        .eq("source_type", source_type)
        .eq("source_external_id", source_external_id)
        .eq("parser_version", parser_version)
        .maybeSingle();
      if (existing) {
        audit("dedupe_returned_existing", { id: existing.id, source_type });
        // Codex P1 #4: record dedupe hit in audit_log so operators can see
        // replay traffic at the DB level (not just function logs).
        await supabase.from("audit_log").insert({
          entity_type: "source_record",
          entity_uuid: existing.id,
          source_record_id: existing.id,
          actor: "system:ingest",
          action: "sync",
          reason: "dedupe_hit_replay",
          batch_id: crawl_run_id,
        }).then(({ error: auditErr }) => {
          if (auditErr) audit("audit_insert_failed_dedupe", { error: auditErr.message });
        });
        return jsonResp(200, {
          ok: true,
          id: existing.id,
          crawl_run_id: existing.crawl_run_id,
          status: existing.status,
          fetched_at: existing.fetched_at,
          deduped: true,
        });
      }
    }
    audit("insert_failed", { error: error.message });
    return jsonResp(500, {
      ok: false,
      error: "insert_failed",
      message: error.message,
    });
  }

  audit("inserted", {
    id: data.id,
    source_type,
    source_external_id,
    parser_version,
  });

  // Codex P1 #4: write audit_log row for the create event. Non-blocking —
  // a failed audit insert should NOT fail the ingest itself, so we await
  // but only log the error.
  await supabase.from("audit_log").insert({
    entity_type: "source_record",
    entity_uuid: data.id,
    source_record_id: data.id,
    actor: "system:ingest",
    action: "create",
    after_json: {
      source_type,
      source_external_id,
      parser_version,
      crawl_run_id,
    },
    batch_id: crawl_run_id,
  }).then(({ error: auditErr }) => {
    if (auditErr) audit("audit_insert_failed_create", { error: auditErr.message });
  });

  return jsonResp(200, {
    ok: true,
    id: data.id,
    crawl_run_id: data.crawl_run_id,
    status: data.status,
    fetched_at: data.fetched_at,
  });
});
