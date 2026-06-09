// @ts-nocheck
// alibaba-bridge: Alibaba.com (ICBU) Open Platform API bridge for V2
// platform registration + sync. Mirrors qoo10-bridge structure.
//
// Plan ref: plans/alibaba-deep-lemon.md §2 (Phase B — real ICBU mapping).
//
// Docs used (operator's C:\dev\api-refs\marketplaces\alibaba):
//   markdown/000059 calling-parameters, 000060 signature-algorithm,
//   000061 http-request-sample, 000145 v2 how-to-create-a-product-listing,
//   api/api-004 auth.token.create, api/api-011 product.listing.v2,
//   product.status.get.v2, product.search.v2, category.get.v2,
//   category.attribute.get.v2, api/api-001 photobank.upload.
//
// Gateway: https://openapi-api.alibaba.com/rest{apiPath}
// Signing (000060/000061): sort all params except `sign` (and byte[] params)
//   by ASCII; concat key+value; prepend apiPath; HMAC-SHA256(appSecret); HEX
//   uppercase. sign_method value = "sha256".
//
// Kill-switch: ALIBABA_BRIDGE_ENABLED must be 'true' AND ALIBABA_APP_KEY/SECRET
// present before any live call fires.

import { AUTH_CORS, requireAuthenticatedUser } from '../_shared/auth.ts';

const ALIBABA_GATEWAY_URL = (Deno as any).env.get('ALIBABA_GATEWAY_URL') || 'https://openapi-api.alibaba.com/rest';
const ALIBABA_APP_KEY = (Deno as any).env.get('ALIBABA_APP_KEY') || '';
const ALIBABA_APP_SECRET = (Deno as any).env.get('ALIBABA_APP_SECRET') || '';
const ALIBABA_ACCESS_TOKEN = (Deno as any).env.get('ALIBABA_ACCESS_TOKEN') || '';
const ALIBABA_BRIDGE_ENABLED = String((Deno as any).env.get('ALIBABA_BRIDGE_ENABLED') || '').toLowerCase() === 'true';

const CORS: Record<string, string> = { ...AUTH_CORS, 'Access-Control-Max-Age': '3600' };

function jsonResp(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}
function norm(value: unknown): string { return String(value ?? '').trim(); }

// ---------------------------------------------------------------------------
// TOP signing (000060). Excludes `sign` and any key listed in excludeKeys
// (byte[] params, e.g. photobank image_bytes) from the signed string.
// ---------------------------------------------------------------------------
async function hmacSha256HexUpper(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function signTop(apiPath: string, params: Record<string, string>, excludeKeys: Set<string> = new Set()): Promise<string> {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && !excludeKeys.has(k) && params[k] != null && params[k] !== '')
    .sort();
  const concat = keys.map((k) => `${k}${params[k]}`).join('');
  const message = `${apiPath}${concat}`;
  const sign = await hmacSha256HexUpper(ALIBABA_APP_SECRET, message);
  // TEMP DEBUG (remove once auth works): never logs the secret value (only its
  // length + an HMAC fingerprint), and REDACTS access_token from the base string
  // so no live per-seller token is ever written to logs.
  try {
    const fp = (await hmacSha256HexUpper(ALIBABA_APP_SECRET, 'fingerprint')).slice(0, 12);
    const safeMessage = `${apiPath}` + keys.map((k) => `${k}${k === 'access_token' ? '<redacted>' : params[k]}`).join('');
    console.log(JSON.stringify({ dbg: 'alibaba_sign', apiPath, keys, base_redacted: safeMessage, sign, secret_len: ALIBABA_APP_SECRET.length, secret_fp: fp }));
  } catch (_) { /* ignore debug errors */ }
  return sign;
}

function notReady(): Response | null {
  if (!ALIBABA_BRIDGE_ENABLED) {
    return jsonResp({ ok: false, docs_required: true, error: 'alibaba_bridge_disabled', detail: 'Set ALIBABA_BRIDGE_ENABLED=true after configuring App Key/Secret + access_token.' }, 503);
  }
  if (!ALIBABA_APP_KEY || !ALIBABA_APP_SECRET) {
    return jsonResp({ ok: false, error: 'alibaba_credentials_missing', detail: 'ALIBABA_APP_KEY / ALIBABA_APP_SECRET not set.' }, 500);
  }
  return null;
}

// Generic TOP call for text params (form-urlencoded). needsToken=true injects
// access_token. Returns the parsed gateway JSON (or { _http } on transport err).
async function topRequest(apiPath: string, bizParams: Record<string, string>, opts: { needsToken?: boolean } = {}): Promise<{ status: number; raw: any }> {
  const sys: Record<string, string> = {
    app_key: ALIBABA_APP_KEY,
    timestamp: String(Date.now()),
    sign_method: 'sha256',
  };
  if (opts.needsToken !== false) sys.access_token = ALIBABA_ACCESS_TOKEN;
  const params: Record<string, string> = { ...sys, ...bizParams };
  params.sign = await signTop(apiPath, params);
  const body = new URLSearchParams(params);
  const res = await fetch(`${ALIBABA_GATEWAY_URL}${apiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  });
  const text = await res.text();
  let raw: any = null;
  try { raw = JSON.parse(text); } catch { raw = { raw_text: text }; }
  return { status: res.status, raw };
}

// ---------------------------------------------------------------------------
// product_info builder (000145 + product.listing.v2 schema).
// 1st cut: TIERED price (single tier), Customization unless a shipping
// template is supplied (then RTS-capable). External public image URLs are
// passed straight through (V2 auto-uploads non-alicdn URLs).
// ---------------------------------------------------------------------------
function buildProductInfo(b: Record<string, any>) {
  const images: string[] = (Array.isArray(b.images) ? b.images : []).map((u: unknown) => norm(u)).filter(Boolean).slice(0, 6);
  const moq = Math.max(1, Math.floor(Number(b.moq) || 1));
  const priceUsd = Number(b.price_usd);
  const keywords = norm(b.keywords);
  const attributes = Array.isArray(b.attributes)
    ? b.attributes.map((a: any) => ({ attribute_name: norm(a.attribute_name || a.name), attribute_value: norm(a.attribute_value || a.value) }))
        .filter((a: any) => a.attribute_name && a.attribute_value)
    : [];

  const basic_info: Record<string, any> = {
    title: norm(b.title).slice(0, 128),
    language: 'en_US',
    product_image: images.map((u) => ({ image_url: u })),
  };
  if (norm(b.description)) basic_info.description = norm(b.description);
  if (keywords) basic_info.keywords = keywords;
  if (norm(b.model_number)) basic_info.model_number = norm(b.model_number);
  if (norm(b.brand_name)) basic_info.brand_name = norm(b.brand_name);

  const category_info: Record<string, any> = {};
  if (norm(b.category_id)) category_info.category_id = Number(b.category_id);
  if (norm(b.category_name)) category_info.category_name = norm(b.category_name);
  if (attributes.length) category_info.attributes = attributes;

  const trade_info: Record<string, any> = {
    price: { price_type: 'TIERED', currency: 'USD', tiered_price: [{ quantity: moq, price: priceUsd.toFixed(2) }] },
    moq,
    unit: norm(b.unit) || 'Piece',
  };
  if (b.inventory != null && norm(b.inventory)) trade_info.inventory = Math.max(0, Math.floor(Number(b.inventory) || 0));

  const product_info: Record<string, any> = { basic_info, trade_info };
  if (Object.keys(category_info).length) product_info.category_info = category_info;

  // RTS path: only when a shipping template is supplied (000145 RTS specs).
  if (norm(b.shipping_template_id)) {
    const weight = Number(b.weight);
    const leadTime = Math.max(1, Math.floor(Number(b.lead_time) || 7));
    const logistics_info: Record<string, any> = {
      shipping_template_id: norm(b.shipping_template_id),
      tiered_lead_time: [{ quantity: moq, lead_time: leadTime }],
    };
    if (Number.isFinite(weight) && weight > 0) logistics_info.weight = weight.toFixed(3);
    if (b.dimension && typeof b.dimension === 'object') logistics_info.dimension = b.dimension;
    product_info.logistics_info = logistics_info;
  }

  // Enable keyword AI when no keywords were provided (000145 requirement).
  product_info.ai_optimization_config = { keyword_optimization_enabled: !keywords };
  return product_info;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
async function handleHealthz(): Promise<Response> {
  return jsonResp({
    ok: true,
    service: 'alibaba-bridge',
    version: 3,
    bridge_enabled: ALIBABA_BRIDGE_ENABLED,
    app_key_configured: Boolean(ALIBABA_APP_KEY),
    secret_configured: Boolean(ALIBABA_APP_SECRET),
    access_token_configured: Boolean(ALIBABA_ACCESS_TOKEN),
    gateway: ALIBABA_GATEWAY_URL,
  });
}

// OAuth code -> token exchange (api-004). No access_token needed for this call.
// Operator does seller authorization, gets `code`, calls this once, stores the
// returned access_token/refresh_token as secrets.
async function handleAuthToken(req: Request): Promise<Response> {
  const guard = notReady(); if (guard) return guard;
  const url = new URL(req.url);
  const code = norm(url.searchParams.get('code')) || norm((await req.json().catch(() => ({})))?.code);
  if (!code) return jsonResp({ ok: false, error: 'code required (OAuth authorization code)' }, 400);
  const { status, raw } = await topRequest('/auth/token/create', { code }, { needsToken: false });
  const token = norm(raw?.access_token);
  if (!token) return jsonResp({ ok: false, error: 'auth_token_failed', status, raw }, 502);
  return jsonResp({ ok: true, access_token: token, refresh_token: raw?.refresh_token || null, expires_in: raw?.expires_in || null, account_id: raw?.account_id || null, country: raw?.country || null, raw });
}

async function handleCategory(req: Request): Promise<Response> {
  const guard = notReady(); if (guard) return guard;
  const parent = norm(new URL(req.url).searchParams.get('parent_category_id'));
  const biz: Record<string, string> = {};
  if (parent) biz.parent_category_id = parent;
  const { status, raw } = await topRequest('/alibaba/icbu/category/get/v2', biz);
  if (String(raw?.success) !== 'true') return jsonResp({ ok: false, error: norm(raw?.message) || 'category_get_failed', msg_code: raw?.msg_code, status, raw }, 502);
  return jsonResp({ ok: true, categories: raw?.data || [], raw });
}

async function handleCategoryAttributes(req: Request): Promise<Response> {
  const guard = notReady(); if (guard) return guard;
  const categoryId = norm(new URL(req.url).searchParams.get('category_id'));
  if (!categoryId) return jsonResp({ ok: false, error: 'category_id required' }, 400);
  const { status, raw } = await topRequest('/alibaba/icbu/category/attribute/get/v2', { category_id: categoryId });
  if (String(raw?.success) !== 'true') return jsonResp({ ok: false, error: norm(raw?.message) || 'category_attr_failed', msg_code: raw?.msg_code, status, raw }, 502);
  return jsonResp({ ok: true, category_attributes: raw?.data?.category_attributes || [], sale_attributes: raw?.data?.sale_attributes || [], raw });
}

async function handleCreateListing(req: Request): Promise<Response> {
  const guard = notReady(); if (guard) return guard;
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== 'object') return jsonResp({ ok: false, error: 'JSON body required' }, 400);
  if (!norm(b.title)) return jsonResp({ ok: false, error: 'title required' }, 400);
  if (!Array.isArray(b.images) || b.images.filter(Boolean).length === 0) return jsonResp({ ok: false, error: 'images[] required' }, 400);
  if (!(Number(b.price_usd) > 0)) return jsonResp({ ok: false, error: 'price_usd > 0 required' }, 400);

  const product_info = buildProductInfo(b);
  const { status, raw } = await topRequest('/alibaba/icbu/product/listing/v2', { product_info: JSON.stringify(product_info) });

  const result = raw?.result || {};
  const success = String(result?.success) === 'true';
  if (!success) {
    return jsonResp({ ok: false, error: norm(result?.message) || 'listing_failed', msg_code: norm(result?.msg_code), trace_id: result?.trace_id, status, raw }, 502);
  }
  const productId = norm(result?.data);
  if (!productId) return jsonResp({ ok: false, error: 'listing_no_product_id', status, raw }, 502);
  // Listing accepted; final status resolves async (20-60s) via /status.
  return jsonResp({ ok: true, product_id: productId, status: 'pending', trace_id: result?.trace_id, raw });
}

async function handleStatus(req: Request): Promise<Response> {
  const guard = notReady(); if (guard) return guard;
  const url = new URL(req.url);
  const productId = norm(url.searchParams.get('product_id'));
  const sku = norm(url.searchParams.get('sku'));

  // Prefer direct status by product_id (product.status.get.v2).
  if (productId) {
    const { status, raw } = await topRequest('/alibaba/icbu/product/status/get/v2', { product_id: productId });
    const result = raw?.result || {};
    if (String(result?.success) !== 'true' || !result?.data) {
      return jsonResp({ ok: false, error: norm(result?.message) || 'status_failed', msg_code: norm(result?.msg_code), status, raw }, 502);
    }
    return jsonResp({ ok: true, product_id: productId, status: norm(result.data.status), status_desc: norm(result.data.status_desc), raw });
  }

  // Otherwise look up by SKU/model_number (product.search.v2).
  if (sku) {
    const { status, raw } = await topRequest('/alibaba/icbu/product/search/v2', { sku_code: sku, page_index: '1', page_size: '20' });
    if (String(raw?.success) !== 'true') return jsonResp({ ok: false, error: norm(raw?.message) || 'search_failed', msg_code: norm(raw?.msg_code), status, raw }, 502);
    const list = Array.isArray(raw?.product_info) ? raw.product_info : [];
    const hit = list.find((p: any) => norm(p?.basic_info?.product_id)) || null;
    if (!hit) return jsonResp({ ok: false, error: 'product_not_found', msg_code: 'B_PRODUCT_NOT_FOUND', raw }, 404);
    const pid = norm(hit.basic_info.product_id);
    // search returns status (online/offline/deleted) + audit_status (approved/pending/rejected).
    return jsonResp({ ok: true, product_id: pid, status: norm(hit.basic_info.status), audit_status: norm(hit.basic_info.audit_status), raw: hit });
  }

  return jsonResp({ ok: false, error: 'product_id or sku query param required' }, 400);
}

// photobank.upload (api-001). Optional — only needed for non-public/local
// images; V2 listing auto-uploads public https URLs. Fetches the image bytes
// from image_url and posts them as multipart (image_bytes excluded from sign).
async function handlePhotobankUpload(req: Request): Promise<Response> {
  const guard = notReady(); if (guard) return guard;
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== 'object') return jsonResp({ ok: false, error: 'JSON body required' }, 400);
  const imageUrl = norm(b.image_url);
  if (!imageUrl) return jsonResp({ ok: false, error: 'image_url required' }, 400);

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) return jsonResp({ ok: false, error: `image_fetch_failed (${imgRes.status})` }, 502);
  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  if (bytes.byteLength > 5 * 1024 * 1024) return jsonResp({ ok: false, error: 'SIZE_TOO_LARGE', detail: 'max 5MB per image' }, 400);
  const fileName = norm(b.file_name) || (imageUrl.split('/').pop() || 'image').slice(0, 64);

  // Sign text params only (image_bytes is byte[] → excluded from signing).
  const apiPath = '/alibaba/icbu/photobank/upload';
  const textParams: Record<string, string> = {
    app_key: ALIBABA_APP_KEY,
    timestamp: String(Date.now()),
    sign_method: 'sha256',
    access_token: ALIBABA_ACCESS_TOKEN,
    file_name: fileName,
  };
  if (norm(b.group_id)) textParams.group_id = norm(b.group_id);
  const sign = await signTop(apiPath, textParams);

  const form = new FormData();
  for (const [k, v] of Object.entries(textParams)) form.append(k, v);
  form.append('sign', sign);
  form.append('image_bytes', new Blob([bytes]), fileName);

  const res = await fetch(`${ALIBABA_GATEWAY_URL}${apiPath}`, { method: 'POST', body: form });
  const raw = await res.json().catch(() => ({}));
  const ro = raw?.result?.response_object;
  const photobankUrl = norm(ro?.photobank_url);
  if (!photobankUrl) {
    return jsonResp({ ok: false, error: norm(raw?.result?.error_msg) || 'photobank_upload_failed', error_code: norm(raw?.result?.error_code), raw }, 502);
  }
  return jsonResp({ ok: true, photobank_url: photobankUrl, file_id: norm(ro?.file_id), raw });
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const action = url.pathname.split('/').filter(Boolean).pop() || '';

  if (action === 'healthz' && req.method === 'GET') return await handleHealthz();

  const authResult = await requireAuthenticatedUser(req);
  if (authResult.response) return authResult.response;

  try {
    if (action === 'auth-token') return await handleAuthToken(req);
    if (action === 'category' && req.method === 'GET') return await handleCategory(req);
    if (action === 'category-attributes' && req.method === 'GET') return await handleCategoryAttributes(req);
    if (action === 'create-listing' && req.method === 'POST') return await handleCreateListing(req);
    if (action === 'status' && req.method === 'GET') return await handleStatus(req);
    if (action === 'photobank-upload' && req.method === 'POST') return await handlePhotobankUpload(req);
    return jsonResp({ ok: false, error: `unknown action: ${action} (${req.method})` }, 404);
  } catch (e: any) {
    console.error('[alibaba-bridge] error', e);
    return jsonResp({ ok: false, error: String(e?.message || e) }, 500);
  }
}

Deno.serve(handleRequest);
