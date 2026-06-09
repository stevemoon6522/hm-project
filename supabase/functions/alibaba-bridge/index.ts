// @ts-nocheck
// alibaba-bridge: Alibaba (ICBU / alibaba.com B2B) API bridge for V2
// platform registration + sync. Mirrors qoo10-bridge structure.
//
// Plan ref: plans/alibaba-deep-lemon.md §2.
//
// HARD CONSTRAINT (Codex P0 #1): no implementation against guessed API
// behavior — only what is documented in C:\dev\api-refs. The Alibaba ICBU
// docs (api-001 photobank.upload, api-011 product.listing.v2, api-011
// product.search.v2 / status.get.v2) are NOT in this repo yet. So this file
// ships the SAFE TRANSPORT SCAFFOLDING only:
//   - Alibaba Open Platform (TOP) request signing + HTTP plumbing
//   - request routing for /photobank-upload, /create-listing, /status, /healthz
// The ICBU-method-specific BUSINESS PARAMETER assembly is intentionally left as
// a structured docs_required guard (see callIcbu()). Phase B fills those in
// directly from the api-refs markdown and flips ALIBABA_BRIDGE_ENABLED=true.
//
// Doc-fill checklist when api-refs lands (see plan §"Phase B 체크리스트"):
//   [B] TOP gateway URL + sign_method (md5 vs hmac-sha256) confirmation
//   [B] alibaba.icbu.photobank.upload  param + response schema
//   [B] alibaba.icbu.product.listing.v2 request param map
//   [B] alibaba.icbu.product.status.get.v2 / product.search.v2 response map

import { AUTH_CORS, requireAuthenticatedUser } from '../_shared/auth.ts';

// ---------------------------------------------------------------------------
// Env / config. All optional — absent in Phase A so nothing can fire live.
// ---------------------------------------------------------------------------
const ALIBABA_GATEWAY_URL = (Deno as any).env.get('ALIBABA_GATEWAY_URL') || 'https://gw.open.1688.com/openapi'; // [B] confirm ICBU gateway
const ALIBABA_APP_KEY = (Deno as any).env.get('ALIBABA_APP_KEY') || '';
const ALIBABA_APP_SECRET = (Deno as any).env.get('ALIBABA_APP_SECRET') || '';
const ALIBABA_ACCESS_TOKEN = (Deno as any).env.get('ALIBABA_ACCESS_TOKEN') || ''; // per-seller OAuth token
// Master kill-switch: even with secrets set, no live ICBU call is made until an
// operator has verified the param mappings against api-refs and sets this true.
const ALIBABA_BRIDGE_ENABLED = String((Deno as any).env.get('ALIBABA_BRIDGE_ENABLED') || '').toLowerCase() === 'true';

const CORS: Record<string, string> = { ...AUTH_CORS, 'Access-Control-Max-Age': '3600' };

function jsonResp(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function norm(value: unknown): string {
  return String(value || '').trim();
}

function docsRequired(method: string, extra: Record<string, unknown> = {}): Response {
  // Surfaced by the adapter's classifyBridgeError() as DOCS_NOT_READY.
  return jsonResp({
    ok: false,
    docs_required: true,
    error: 'alibaba_docs_required',
    method,
    detail: `ICBU method '${method}' param mapping is not wired yet. Commit the api-refs markdown and fill callIcbu(), then set ALIBABA_BRIDGE_ENABLED=true.`,
    ...extra,
  }, 501);
}

// ---------------------------------------------------------------------------
// TOP request signing (Alibaba Open Platform standard).
// NOTE: this is the GENERIC TOP signing algorithm, not ICBU-specific guessed
// behavior. The exact sign_method is [B]-confirmed from docs; hmac-sha256 is
// the TOP default for the api/{namespace}/{method} REST gateway.
// ---------------------------------------------------------------------------
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Builds the canonical signed string per TOP: apiPath + sorted(k+v concat).
async function signTop(apiPath: string, params: Record<string, string>): Promise<string> {
  const keys = Object.keys(params).sort();
  const concat = keys.map((k) => `${k}${params[k]}`).join('');
  return hmacSha256Hex(ALIBABA_APP_SECRET, `${apiPath}${concat}`);
}

// Generic TOP transport. Returns the parsed gateway response. Guarded so it
// never fires without explicit operator enablement + credentials.
async function topRequest(namespace: string, method: string, version: string, bizParams: Record<string, string>): Promise<{ status: number; raw: any }> {
  if (!ALIBABA_BRIDGE_ENABLED) {
    return { status: 501, raw: { ok: false, docs_required: true, error: 'alibaba_bridge_disabled' } };
  }
  if (!ALIBABA_APP_KEY || !ALIBABA_APP_SECRET) {
    return { status: 500, raw: { ok: false, error: 'ALIBABA_APP_KEY/ALIBABA_APP_SECRET missing' } };
  }
  // api/{namespace}/{version}/{method}/{appKey} is the TOP REST path shape.
  const apiPath = `param2/${version}/${namespace}/${method}/${ALIBABA_APP_KEY}`;
  const sysParams: Record<string, string> = {
    _aop_timestamp: String(Date.now()),
    access_token: ALIBABA_ACCESS_TOKEN,
    ...bizParams,
  };
  const sign = await signTop(apiPath, sysParams);
  const body = new URLSearchParams({ ...sysParams, _aop_signature: sign });
  const res = await fetch(`${ALIBABA_GATEWAY_URL}/${apiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  });
  const text = await res.text();
  let raw: any = null;
  try { raw = JSON.parse(text); } catch { raw = { raw_text: text }; }
  return { status: res.status, raw };
}

// Single choke-point for ICBU business calls. In Phase A every method returns
// docsRequired() so no guessed request reaches Alibaba. Phase B replaces each
// branch body with the doc-confirmed bizParams + response mapping.
async function callIcbu(method: string, _input: Record<string, any>): Promise<Response> {
  switch (method) {
    case 'alibaba.icbu.photobank.upload':
      return docsRequired(method); // [B] api-001: image_bytes (<=5MB, max 6/product)
    case 'alibaba.icbu.product.listing.v2':
      return docsRequired(method); // [B] api-011 listing: subject/category/attributes/freight/sku/price
    case 'alibaba.icbu.product.status.get.v2':
      return docsRequired(method); // [B] api-011 search/status: product_id|sku -> status
    default:
      return jsonResp({ ok: false, error: `unknown ICBU method: ${method}` }, 400);
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
async function handleHealthz(): Promise<Response> {
  return jsonResp({
    ok: true,
    service: 'alibaba-bridge',
    version: 1,
    bridge_enabled: ALIBABA_BRIDGE_ENABLED,
    app_key_configured: Boolean(ALIBABA_APP_KEY),
    access_token_configured: Boolean(ALIBABA_ACCESS_TOKEN),
    gateway: ALIBABA_GATEWAY_URL,
    note: ALIBABA_BRIDGE_ENABLED ? 'live' : 'scaffold — ICBU methods return docs_required until api-refs is wired',
  });
}

async function handlePhotobankUpload(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return jsonResp({ ok: false, error: 'JSON body required' }, 400);
  if (!norm(body.image_url) && !norm(body.image_bytes)) {
    return jsonResp({ ok: false, error: 'image_url or image_bytes required' }, 400);
  }
  return callIcbu('alibaba.icbu.photobank.upload', body);
}

async function handleCreateListing(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return jsonResp({ ok: false, error: 'JSON body required' }, 400);
  // Defensive re-validation (the adapter already checks these).
  if (!norm(body.category_id)) return jsonResp({ ok: false, error: 'category_id required' }, 400);
  if (!norm(body.freight_template_id)) return jsonResp({ ok: false, error: 'freight_template_id required' }, 400);
  if (!norm(body.subject)) return jsonResp({ ok: false, error: 'subject required' }, 400);
  if (!Array.isArray(body.images) || body.images.length === 0) return jsonResp({ ok: false, error: 'images[] required' }, 400);
  return callIcbu('alibaba.icbu.product.listing.v2', body);
}

async function handleStatus(url: URL): Promise<Response> {
  const productId = norm(url.searchParams.get('product_id'));
  const sku = norm(url.searchParams.get('sku'));
  if (!productId && !sku) return jsonResp({ ok: false, error: 'product_id or sku query param required' }, 400);
  return callIcbu('alibaba.icbu.product.status.get.v2', { product_id: productId, sku });
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const action = url.pathname.split('/').filter(Boolean).pop() || '';

  if (action === 'healthz' && req.method === 'GET') return await handleHealthz();

  // All non-health routes require an authenticated user (matches other bridges).
  const authResult = await requireAuthenticatedUser(req);
  if (authResult.response) return authResult.response;

  try {
    if (action === 'photobank-upload' && req.method === 'POST') return await handlePhotobankUpload(req);
    if (action === 'create-listing' && req.method === 'POST') return await handleCreateListing(req);
    if (action === 'status' && req.method === 'GET') return await handleStatus(url);
    return jsonResp({ ok: false, error: `unknown action: ${action} (${req.method})` }, 404);
  } catch (e: any) {
    console.error('[alibaba-bridge] error', e);
    return jsonResp({ ok: false, error: String(e?.message || e) }, 500);
  }
}

Deno.serve(handleRequest);
