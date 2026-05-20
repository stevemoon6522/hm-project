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

  return jsonResp(200, {
    ok: true,
    id: data.id,
    crawl_run_id: data.crawl_run_id,
    status: data.status,
    fetched_at: data.fetched_at,
  });
});
