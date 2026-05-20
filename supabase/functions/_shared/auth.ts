// @ts-nocheck
// Shared session-JWT validator for Edge Functions in the [sd] V2 stack.
//
// Why: shopee-bridge / joom-bridge / sku-change-* historically accepted the
// public anon JWT, so any caller who knew the public URL could trigger
// real Shopee mutations (register, price update, etc). This module turns
// every mutating route into "must be signed in as a real Supabase user".
//
// Contract:
//   const auth = await requireAuthenticatedUser(req);
//   if (auth.response) return auth.response;   // 401, JSON body, CORS set
//   const user = auth.user;                    // safe to use
//
// Rejects:
//   - missing Authorization header
//   - non-Bearer scheme
//   - empty / malformed JWT
//   - JWT whose payload role is not 'authenticated' (this catches the anon key)
//   - JWT whose signature fails Supabase verification (handled by getUser)
//   - expired / revoked tokens (handled by getUser)
//
// Read-only routes that genuinely should remain public can skip this helper
// — but EVERY route that writes state MUST call it before any side effect.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

export const AUTH_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "3600",
};

function jsonError(status, error, message, extra = {}) {
  const body = { ok: false, error, message, ...extra };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...AUTH_CORS, "Content-Type": "application/json" },
  });
}

export function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Extract Bearer token from the request.
 * Returns the raw JWT string or null if absent / malformed.
 */
export function extractBearerToken(req) {
  const header =
    req.headers.get("Authorization") || req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token || null;
}

/**
 * The canonical guard. Returns either { user } (callable result) or
 * { response } (a fully-formed 401 Response the caller must return).
 */
export async function requireAuthenticatedUser(req) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return {
      response: jsonError(
        500,
        "auth_misconfigured",
        "SUPABASE_URL or SUPABASE_ANON_KEY env var not set on Edge Function"
      ),
    };
  }

  const token = extractBearerToken(req);
  if (!token) {
    return {
      response: jsonError(
        401,
        "auth_missing",
        "Authorization header missing or not 'Bearer <jwt>'"
      ),
    };
  }

  // First cheap check: payload role must be 'authenticated'.
  // The public anon key itself is a JWT with role='anon' — this catches it
  // without an extra network round-trip.
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return {
      response: jsonError(401, "auth_invalid", "JWT payload not decodable"),
    };
  }
  if (payload.role !== "authenticated") {
    return {
      response: jsonError(
        401,
        "auth_anon_rejected",
        `JWT role='${payload.role || "(missing)"}' is not allowed; please sign in`
      ),
    };
  }

  // Now do the real signature + expiry verification through Supabase auth.
  // getUser(token) returns the user if and only if the JWT is signed by this
  // project AND still valid; otherwise returns an error.
  let supabase;
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (e) {
    return {
      response: jsonError(
        500,
        "auth_client_init_failed",
        e instanceof Error ? e.message : String(e)
      ),
    };
  }

  // Wrap getUser in try/catch so transient network/auth backend errors are
  // surfaced as a deterministic 401 JSON response with CORS headers — not as
  // an uncaught exception that escapes the caller's enclosing try block.
  let data;
  let error;
  try {
    const res = await supabase.auth.getUser(token);
    data = res.data;
    error = res.error;
  } catch (e) {
    return {
      response: jsonError(
        401,
        "auth_verify_threw",
        e instanceof Error ? e.message : String(e)
      ),
    };
  }
  if (error || !data?.user) {
    return {
      response: jsonError(
        401,
        "auth_verify_failed",
        error?.message || "JWT validation failed"
      ),
    };
  }

  return {
    user: {
      id: data.user.id,
      email: data.user.email || null,
      role: payload.role, // 'authenticated'
      raw_app_metadata: data.user.app_metadata || {},
      raw_user_metadata: data.user.user_metadata || {},
    },
  };
}

export { jsonError };
