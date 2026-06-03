// Shopee Bridge v44: v2 register variants — buildGlobalModels seller_stock migration + per-model weight/image fields + register_cbsc failure state machine (§6-1) + idempotency_token as request_id.
// v42: harden StarOneMall image proxy/upload_image validation and generated-upload idempotency.
// v41: /health reports the hosted deployment version from DENO_DEPLOYMENT_ID.
// v40: GlobalProduct registration uses add_global_item -> init_tier_variation/add_global_model -> create_publish_task -> get_publish_task_result.
// v39: KRSC/CBSC merchant flow ??merchantApiCall reads `region='_MERCHANT'` row first (main_account OAuth token). Auto-refresh with merchant_id principal. Shop-token fallback retained.
// v38: CBSC merchant token via main_account_id (was merchant_id) ??Shopee CBSC OAuth scope. merchantApiCall tries issued merchant token first, shop-token fallback. New /try_main_account_refresh debug endpoint.
// v37: CBSC global_product flow. merchantApiCall now uses shop access_token + merchant_id signing (bypasses broken issueMerchantToken). New endpoints: /add_global_item, /create_publish_task, /publish_task_result, /register_cbsc.
// v36: rewrite add_item payload per Shopee SDK source-of-truth ??seller_stock TOP-LEVEL (no location_id), logistic_info (was logistics) with logistic_name+is_free, original_price TOP-LEVEL (no price_info wrapper), image.image_id_list (was image_url_list), attribute_list:[]. Accepts body.image_id (preferred) or image_url.
// v35: add /channels, /categories, /raw_call debug endpoints; logistics field fallback (logistic_id|logistics_channel_id|channel_id); add_item supports stock_variant body field to try alternative seller_stock shapes.
// v34: add_item ??seller_stock now wraps location_id (was rejected by SG); echo `sent` payload on error for easier debugging.
// v33: add_item now sends days_to_ship + pre_order + brand + dimension + wholesale (Shopee v2 required fields).
// v28: use Shopee cursor offset for global item pagination.
// v20: added /proxy_image, POST /upload_image (base64), /add_item for product registration.
// v19: /list_items expands has_model items via get_model_list, returning per-model rows.
// Also: /update_price accepts model_id in price_list, /update_stock supports model-level stock.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { requireAuthenticatedUser } from "../_shared/auth.ts";

// Read-only actions that genuinely do not need a signed-in user.
// Everything not in this set is treated as a mutating route and MUST pass
// requireAuthenticatedUser before running.
//
// Notable EXCLUSIONS (intentionally gated):
//   - token_health / token-health: accepts run_refresh=1 → mutates tokens
//   - v2_failed_mutations: returns private mutation payloads / responses
//   - try_refresh_variants: explicit token refresh
//   - raw_call: forwards arbitrary Shopee API calls
const PUBLIC_ACTIONS: ReadonlySet<string> = new Set([
  "health",
  "tokens",
  "token_probe",
  "shop_info",
  "categories",
  "attributes",
  "brands",
  "channels",
  "shop_item_dts_limit",
  "global_categories",
  "global_brands",
  "global_attributes",
  "item_info",
  "list_items",
  "published_list",
  "shop_model_list",
  "global_items",
  "global_item_info",
  "global_item_dts_limit",
  "global_model_list",
  "proxy_image",
  "publish_task_result",
  "publishable_shop",
  "shop_publishable_status",
  "merchant_shops",
]);

const SANDBOX_HOST = 'openplatform.sandbox.test-stable.shopee.sg';
const LIVE_HOST = 'partner.shopeemobile.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
  'Access-Control-Max-Age': '3600',
};

// @ts-ignore
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const ENV_PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID") || "";
const ENV_PARTNER_KEY = Deno.env.get("SHOPEE_PARTNER_KEY") || "";
// CBSC main account ID ??Shopee CB Mall / KRSC group. Same across all 10 region shops in our setup.
const MAIN_ACCOUNT_ID = Number(Deno.env.get("SHOPEE_MAIN_ACCOUNT_ID") || "1842717");
const SOURCE_VERSION = 43;
const DENO_DEPLOYMENT_ID = Deno.env.get("DENO_DEPLOYMENT_ID") || "";
const DEPLOYMENT_VERSION_MATCH = DENO_DEPLOYMENT_ID.match(/_(\d+)$/);
const DEPLOYMENT_VERSION = DEPLOYMENT_VERSION_MATCH ? Number(DEPLOYMENT_VERSION_MATCH[1]) : null;
const HEALTH_VERSION = DEPLOYMENT_VERSION ?? SOURCE_VERSION;
const OPERATING_REGIONS = ['SG', 'BR', 'MY', 'PH', 'TH', 'TW'];
const OPERATING_REGION_SET = new Set(OPERATING_REGIONS);
const DEFAULT_REFRESH_THRESHOLD_SEC = 7200;
const DEFAULT_REFRESH_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1000;
const PROXY_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const UPLOAD_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const UPLOAD_IMAGE_MIN_DIMENSION = 300;
const UPLOAD_IMAGE_MAX_DIMENSION = 4096;
const GENERATED_UPLOAD_CACHE_TTL_MS = 30 * 60 * 1000;
const IMAGE_PROXY_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};
const PROXY_ALLOWED_HOSTS = new Set([
  'staronemall.com',
  'www.staronemall.com',
  'staronemall2.wisacdn.com',
  'cf.shopee.sg',
  'cf.shopee.tw',
  'cf.shopee.ph',
  'cf.shopee.com.my',
  'cf.shopee.co.th',
  'cf.shopee.com.br',
]);
const PROXY_ALLOWED_SUFFIXES = [
  '.wisacdn.com',
  '.shopeesz.com',
];

async function getApp() {
  const { data } = await supabase.from('shopee_app').select('*').eq('id', 1).single();
  if (!data) throw new Error('shopee_app no');
  return {
    ...data,
    partner_id: ENV_PARTNER_ID ? Number(ENV_PARTNER_ID) : data.partner_id,
    partner_key: ENV_PARTNER_KEY || data.partner_key,
  };
}
function host(s: boolean): string { return s ? SANDBOX_HOST : LIVE_HOST; }
async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function audit(event: string, payload: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ service: 'shopee-bridge', event, ts: new Date().toISOString(), ...payload }));
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function parsePositiveInt(value: string | null, fallback: number, min = 1, max = 86400): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseTargetRegions(raw: string | null): string[] {
  if (!raw) return OPERATING_REGIONS;
  const wanted = raw
    .split(',')
    .map(v => v.trim().toUpperCase())
    .filter(Boolean);
  const allowed = new Set(OPERATING_REGIONS);
  const deduped = [...new Set(wanted.filter(v => allowed.has(v)))];
  return deduped.length ? deduped : OPERATING_REGIONS;
}

function normalizeRegion(value: unknown): string | null {
  const region = String(value || 'SG').trim().toUpperCase();
  return OPERATING_REGION_SET.has(region) ? region : null;
}

function imageProxyError(error: string, status = 400, extra: Record<string, unknown> = {}) {
  return jsonResp({ ok: false, error, ...extra }, status);
}

function normalizeHostname(hostname: string): string {
  return String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isAllowedProxyHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (PROXY_ALLOWED_HOSTS.has(host)) return true;
  return PROXY_ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(ip: string): boolean {
  const value = normalizeHostname(ip);
  if (!value.includes(':')) return false;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe80:') ||
    value.startsWith('fec0:') ||
    value.startsWith('ff')
  );
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIpv4(host);
  if (host.includes(':')) return isPrivateIpv6(host);
  return false;
}

async function assertPublicProxyTarget(upstream: URL) {
  const hostname = normalizeHostname(upstream.hostname);
  if (!isAllowedProxyHost(hostname)) {
    return { ok: false, status: 403, error: 'proxy_host_not_allowed' };
  }
  if (isPrivateOrLocalHost(hostname)) {
    return { ok: false, status: 403, error: 'proxy_private_host_blocked' };
  }
  try {
    const aRecords = await Deno.resolveDns(hostname, 'A');
    if (aRecords.some((ip) => isPrivateIpv4(ip))) {
      return { ok: false, status: 403, error: 'proxy_private_dns_blocked' };
    }
  } catch (_) {
    // Some edge runtimes do not expose DNS resolution consistently; host allowlist still applies.
  }
  try {
    const aaaaRecords = await Deno.resolveDns(hostname, 'AAAA');
    if (aaaaRecords.some((ip) => isPrivateIpv6(ip))) {
      return { ok: false, status: 403, error: 'proxy_private_dns_blocked' };
    }
  } catch (_) {
    // Some allowed CDN hosts publish A-only records.
  }
  return { ok: true };
}

function isSvgLike(contentType: string, bytes?: Uint8Array): boolean {
  if (/svg/i.test(contentType)) return true;
  if (!bytes || bytes.length === 0) return false;
  const head = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 256))).trimStart();
  return /^<\?xml/i.test(head) || /^<svg[\s>]/i.test(head);
}

function isSupportedImageContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase().split(';')[0].trim();
  return ct.startsWith('image/') && ct !== 'image/svg+xml';
}

function isTransientRefreshErrorMessage(message: string): boolean {
  return /system_error|service_unavailable|temporar|server_error|internal_error|timeout|network|fetch failed|too_many_request|rate_limit|HTTP 5\d\d/i.test(message);
}

function isPermanentRefreshErrorMessage(message: string): boolean {
  return /refresh token|refresh_token|wrong|invalid_refresh|error_user_refresh_token|unauthori[sz]ed|access_denied|shop_banned|banned|revoked|frozen|principal mismatch|merchant_id.*wrong|shop_id.*wrong|error_auth/i.test(message);
}

async function refreshWithRetry(label: string, fn: () => Promise<any>, maxAttempts: number, baseDelayMs: number) {
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return { ok: true, value: await fn(), attempts: attempt, error: null, transient: false, permanent: false };
    } catch (e: any) {
      lastError = String(e?.message || e);
      const transient = isTransientRefreshErrorMessage(lastError);
      if (!transient || attempt >= maxAttempts) {
        return {
          ok: false,
          value: null,
          attempts: attempt,
          error: lastError,
          transient,
          permanent: isPermanentRefreshErrorMessage(lastError),
        };
      }
      audit('token_refresh_retry', { label, attempt, max_attempts: maxAttempts, error: lastError });
      await sleep(baseDelayMs * Math.pow(2, attempt - 1));
    }
  }
  return {
    ok: false,
    value: null,
    attempts: maxAttempts,
    error: lastError || 'refresh failed',
    transient: isTransientRefreshErrorMessage(lastError),
    permanent: isPermanentRefreshErrorMessage(lastError),
  };
}

function fp(v: string | null | undefined): string {
  if (!v) return '';
  let h = 0;
  for (let i = 0; i < v.length; i++) h = ((h << 5) - h + v.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).slice(0, 8);
}

async function getRegionShopRow(region: string, shopId: string | number) {
  const { data } = await supabase
    .from('shopee_shops')
    .select('shop_id, region, merchant_id, status')
    .eq('shop_id', String(shopId))
    .maybeSingle();
  if (!data) throw new Error(`principal missing in shopee_shops for region=${region}, shop_id=${shopId}`);
  if (String(data.region || '') !== String(region)) {
    throw new Error(`principal mismatch region/shop: token_region=${region} shops_region=${data.region} shop_id=${shopId}`);
  }
  if (data.status === 'banned') {
    throw new Error(`shop banned: region=${region} shop_id=${shopId}`);
  }
  return data;
}

async function probeShopToken(app: any, accessToken: string, shopId: number | string) {
  const path = '/api/v2/shop/get_shop_info';
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}${accessToken}${shopId}`);
  const query = new URLSearchParams({
    partner_id: String(app.partner_id),
    timestamp: String(ts),
    sign,
    access_token: accessToken,
    shop_id: String(shopId),
  });
  try {
    const r = await fetch(`https://${host(app.is_sandbox)}${path}?${query}`);
    const j = await r.json();
    return {
      ok: !j?.error,
      http_status: r.status,
      error: j?.error || null,
      message: j?.message || null,
      request_id: j?.request_id || null,
      region: j?.region || null,
      shop_name: j?.shop_name || null,
    };
  } catch (e: any) {
    return { ok: false, http_status: 0, error: 'probe_failed', message: String(e?.message || e), request_id: null };
  }
}

async function persistShopToken(region: string, row: any, token: any, expiresAt: number) {
  if (!token?.access_token || !token?.refresh_token) {
    throw new Error(`token refresh payload incomplete for region=${region}`);
  }
  const shopRow = await getRegionShopRow(region, row.shop_id);
  if (shopRow.merchant_id && row.merchant_id && Number(shopRow.merchant_id) !== Number(row.merchant_id)) {
    throw new Error(`principal mismatch merchant_id for region=${region}, shop_id=${row.shop_id}`);
  }

  await supabase.from('shopee_tokens').update({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: expiresAt,
  }).eq('region', region);

  if (row?.shop_id) {
    await supabase.from('shopee_shops').update({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: new Date(expiresAt * 1000).toISOString(),
    }).eq('shop_id', String(row.shop_id));
  }
  audit('shop_token_persist_ok', {
    region,
    shop_id: row?.shop_id || null,
    merchant_id: row?.merchant_id || null,
    expire_in: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
    access_fp: fp(token.access_token),
    refresh_fp: fp(token.refresh_token),
  });
}

async function refreshMerchantToken(region: string) {
  const { data } = await supabase.from('shopee_tokens').select('*').eq('region', region).single();
  if (!data) throw new Error(`token no: ${region}`);
  if (!data.merchant_id) throw new Error(`merchant_id missing for region ${region}`);
  const app = await getApp();
  const path = '/api/v2/auth/access_token/get';
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}`);
  const url = `https://${host(app.is_sandbox)}${path}?partner_id=${app.partner_id}&timestamp=${ts}&sign=${sign}`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: data.refresh_token, partner_id: app.partner_id, merchant_id: data.merchant_id }) });
  const j = await r.json();
  if (j.error) {
    audit('merchant_refresh_fail', { region, error: j.error, message: j.message || null });
    throw new Error(`merchant refresh: ${j.error} ${j.message || ''} | full: ${JSON.stringify(j)}`);
  }
  if (!j.refresh_token) {
    audit('merchant_refresh_fail', { region, error: 'missing_refresh_token', message: 'refresh_access_token response did not return refresh_token' });
    throw new Error(`merchant refresh: missing refresh_token in response for region=${region}`);
  }
  const newExpiry = Math.floor(Date.now() / 1000) + (j.expire_in || 14400);
  // Merchant tokens are not valid for shop/product APIs. Keep shopee_tokens shop-scoped.
  audit('merchant_refresh_ok', {
    region,
    merchant_id: data.merchant_id,
    shop_id: data.shop_id,
    expire_in: Math.max(0, newExpiry - Math.floor(Date.now() / 1000)),
    access_fp: fp(j.access_token),
    refresh_fp: fp(j.refresh_token),
  });
  return { access_token: j.access_token, merchant_id: data.merchant_id, shop_id: data.shop_id, expires_at: newExpiry, raw: j };
}

async function canCallShopInfo(app: any, accessToken: string, shopId: number | string): Promise<boolean> {
  const path = '/api/v2/shop/get_shop_info';
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}${accessToken}${shopId}`);
  const url = `https://${host(app.is_sandbox)}${path}?partner_id=${app.partner_id}&timestamp=${ts}&sign=${sign}&access_token=${encodeURIComponent(accessToken)}&shop_id=${shopId}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    return !j?.error;
  } catch {
    return false;
  }
}

async function forceRefreshShopToken(region: string) {
  const { data } = await supabase.from('shopee_tokens').select('*').eq('region', region).single();
  if (!data) throw new Error(`token no: ${region}`);
  const app = await getApp();
  const path = '/api/v2/auth/access_token/get';
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}`);
  const url = `https://${host(app.is_sandbox)}${path}?partner_id=${app.partner_id}&timestamp=${ts}&sign=${sign}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: data.refresh_token, partner_id: app.partner_id, shop_id: data.shop_id }),
  });
  const j = await r.json();
  if (j.error) {
    audit('shop_refresh_fail', { region, shop_id: data.shop_id, error: j.error, message: j.message || null });
    throw new Error(`shop refresh: ${j.error} ${j.message || ''}`);
  }
  if (!j.refresh_token) {
    audit('shop_refresh_fail', { region, shop_id: data.shop_id, error: 'missing_refresh_token', message: 'refresh_access_token response did not return refresh_token' });
    throw new Error(`shop refresh: missing refresh_token in response for region=${region}`);
  }
  const newExpiry = Math.floor(Date.now() / 1000) + (j.expire_in || 14400);
  await persistShopToken(region, data, j, newExpiry);
  const probe = await probeShopToken(app, j.access_token, data.shop_id);
  if (!probe.ok) {
    audit('shop_refresh_probe_fail', { region, shop_id: data.shop_id, error: probe.error || null, message: probe.message || null });
    throw new Error(`shop refresh returned token rejected by shop API: ${probe.error || 'unknown'} ${probe.message || ''}`.trim());
  }
  audit('shop_refresh_ok', {
    region,
    shop_id: data.shop_id,
    merchant_id: data.merchant_id,
    expire_in: Math.max(0, newExpiry - Math.floor(Date.now() / 1000)),
    probe_region: probe.region || null,
  });
  return { access_token: j.access_token, merchant_id: data.merchant_id, shop_id: data.shop_id, expires_at: newExpiry, raw: j };
}

// CBSC merchant token: refresh with main_account_id (Shopee CB Mall convention).
// Tries main_account_id first, then merchant_id as fallback.
async function issueMerchantToken(region: string) {
  const { data } = await supabase.from('shopee_tokens').select('*').eq('region', region).single();
  if (!data) throw new Error(`token no: ${region}`);
  const app = await getApp();
  const path = '/api/v2/auth/access_token/get';
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}`);
  const url = `https://${host(app.is_sandbox)}${path}?partner_id=${app.partner_id}&timestamp=${ts}&sign=${sign}`;

  // Variant A: main_account_id (CBSC primary)
  const bodyA: any = { refresh_token: data.refresh_token, partner_id: app.partner_id, main_account_id: MAIN_ACCOUNT_ID };
  const rA = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyA) });
  const jA = await rA.json();
  if (!jA.error && jA.access_token) {
    return { access_token: jA.access_token, merchant_id: jA.merchant_id || data.merchant_id, main_account_id: MAIN_ACCOUNT_ID, scope: 'main_account', raw: jA };
  }

  // Variant B: merchant_id
  if (data.merchant_id) {
    const bodyB: any = { refresh_token: data.refresh_token, partner_id: app.partner_id, merchant_id: data.merchant_id };
    const rB = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyB) });
    const jB = await rB.json();
    if (!jB.error && jB.access_token) {
      return { access_token: jB.access_token, merchant_id: data.merchant_id, scope: 'merchant', raw: jB };
    }
    throw new Error(`issue merchant token: variant_A=${jA.error || ''} ${jA.message || ''} | variant_B=${jB.error || ''} ${jB.message || ''}`);
  }
  throw new Error(`issue merchant token: variant_A=${jA.error || ''} ${jA.message || ''}`);
}

async function getValidToken(region: string, mode: 'shop' | 'merchant' = 'shop') {
  const { data } = await supabase.from('shopee_tokens').select('*').eq('region', region).single();
  if (!data) throw new Error(`token no: ${region}`);
  const now = Math.floor(Date.now() / 1000);
  if (data.expires_at && now < data.expires_at - 60) return { access_token: data.access_token, shop_id: data.shop_id, merchant_id: data.merchant_id, expires_at: data.expires_at };
  if (mode === 'merchant' && data.merchant_id) {
    const r = await refreshMerchantToken(region);
    return r;
  }
  const app = await getApp();
  const path = '/api/v2/auth/access_token/get';
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}`);
  const url = `https://${host(app.is_sandbox)}${path}?partner_id=${app.partner_id}&timestamp=${ts}&sign=${sign}`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: data.refresh_token, partner_id: app.partner_id, shop_id: data.shop_id }) });
  const j = await r.json();
  if (!j.error && j.access_token) {
    const newExpiry = Math.floor(Date.now() / 1000) + (j.expire_in || 14400);
    await persistShopToken(region, data, j, newExpiry);
    const probe = await probeShopToken(app, j.access_token, data.shop_id);
    if (!probe.ok) {
      throw new Error(`refresh: returned token rejected by shop API: ${probe.error || 'unknown'} ${probe.message || ''}`.trim());
    }
    return { access_token: j.access_token, shop_id: data.shop_id, merchant_id: data.merchant_id, expires_at: newExpiry };
  }

  throw new Error(`refresh: ${j.error || 'unknown'} ${j.message || ''}`);
}

function isInvalidAccessToken(r: any): boolean {
  return /invalid_access_token|invalid_acceess_token/i.test(`${r?.error || ''} ${r?.message || ''}`);
}

async function shopApiCall(region: string, path: string, opts: any = {}) {
  const app = await getApp();
  const callWithToken = async (t: any) => {
    const ts = Math.floor(Date.now() / 1000);
    const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}${t.access_token}${t.shop_id}`);
    const baseQuery: Record<string, string> = { partner_id: String(app.partner_id), timestamp: String(ts), access_token: t.access_token, shop_id: String(t.shop_id), sign };
    if (opts.query) for (const [k, v] of Object.entries(opts.query)) baseQuery[k] = String(v);
    const url = `https://${host(app.is_sandbox)}${path}?${new URLSearchParams(baseQuery)}`;
    const r = await fetch(url, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
    return { http_status: r.status, ...(await r.json()) };
  };

  const first = await callWithToken(await getValidToken(region, 'shop'));
  if (!isInvalidAccessToken(first)) return first;

  try {
    const refreshed = await forceRefreshShopToken(region);
    const second = await callWithToken(refreshed);
    if (!second.error) return { ...second, retried_after_shop_refresh: true };
    return { ...second, retried_after_shop_refresh: true, first_error: first.error };
  } catch (e: any) {
    return { ...first, auth_stage: 'stored_token_invalid_refresh_failed', refresh_error: String(e?.message || e) };
  }
}

// Refresh the _MERCHANT row's access_token using merchant_id principal.
async function refreshMerchantRowTokenStrict(): Promise<{ access_token: string; merchant_id: number; expires_at: number }> {
  const { data } = await supabase.from('shopee_tokens').select('*').eq('region', '_MERCHANT').single();
  if (!data || !data.refresh_token || !data.merchant_id) throw new Error('merchant row token missing');
  const app = await getApp();
  const path = '/api/v2/auth/access_token/get';
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}`);
  const url = `https://${host(app.is_sandbox)}${path}?partner_id=${app.partner_id}&timestamp=${ts}&sign=${sign}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: data.refresh_token, partner_id: app.partner_id, merchant_id: data.merchant_id }),
  });
  const j = await r.json();
  if (j.error || !j.access_token) {
    audit('merchant_row_refresh_fail', { error: j.error, message: j.message });
    throw new Error(`merchant row refresh: ${j.error || 'missing_access_token'} ${j.message || ''}`.trim());
  }
  const newExpiry = Math.floor(Date.now() / 1000) + (j.expire_in || 14400);
  await supabase.from('shopee_tokens').update({
    access_token: j.access_token,
    refresh_token: j.refresh_token || data.refresh_token,
    expires_at: newExpiry,
  }).eq('region', '_MERCHANT');
  audit('merchant_row_refresh_ok', { merchant_id: data.merchant_id, expire_in: j.expire_in });
  return { access_token: j.access_token, merchant_id: data.merchant_id, expires_at: newExpiry };
}

async function refreshMerchantRowToken(): Promise<{ access_token: string; merchant_id: number; expires_at?: number } | null> {
  try {
    return await refreshMerchantRowTokenStrict();
  } catch (e: any) {
    audit('merchant_row_refresh_unavailable', { error: String(e?.message || e) });
    return null;
  }
}

// Get valid merchant token from _MERCHANT row, refreshing if needed.
async function getValidMerchantToken(): Promise<{ access_token: string; merchant_id: number; expires_at?: number } | null> {
  const { data } = await supabase.from('shopee_tokens').select('*').eq('region', '_MERCHANT').single();
  if (!data || !data.access_token || !data.merchant_id) return null;
  const now = Math.floor(Date.now() / 1000);
  if (data.expires_at && now < data.expires_at - 60) {
    return { access_token: data.access_token, merchant_id: data.merchant_id, expires_at: data.expires_at };
  }
  return await refreshMerchantRowToken();
}

async function probeMerchantToken(app: any, accessToken: string, merchantId: number | string) {
  const path = '/api/v2/global_product/get_category';
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}${accessToken}${merchantId}`);
  const query = new URLSearchParams({
    partner_id: String(app.partner_id),
    timestamp: String(ts),
    sign,
    access_token: accessToken,
    merchant_id: String(merchantId),
    language: 'en',
  });
  try {
    const r = await fetch(`https://${host(app.is_sandbox)}${path}?${query}`);
    const j = await r.json();
    return {
      ok: !j?.error,
      http_status: r.status,
      error: j?.error || null,
      message: j?.message || null,
      request_id: j?.request_id || null,
      category_count: Array.isArray(j?.response?.category_list) ? j.response.category_list.length : null,
    };
  } catch (e: any) {
    return { ok: false, http_status: 0, error: 'merchant_probe_failed', message: String(e?.message || e), request_id: null };
  }
}

async function merchantApiCall(region: string, path: string, opts: any = {}) {
  const app = await getApp();
  const callWithToken = async (t: { access_token: string; merchant_id?: number | null }) => {
    if (!t.merchant_id) throw new Error(`merchant_id missing`);
    const ts = Math.floor(Date.now() / 1000);
    const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}${t.access_token}${t.merchant_id}`);
    const baseQuery: Record<string, string> = {
      partner_id: String(app.partner_id),
      timestamp: String(ts),
      access_token: t.access_token,
      merchant_id: String(t.merchant_id),
      sign,
    };
    if (opts.query) for (const [k, v] of Object.entries(opts.query)) baseQuery[k] = String(v);
    const url = `https://${host(app.is_sandbox)}${path}?${new URLSearchParams(baseQuery)}`;
    const r = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { http_status: r.status, ...(await r.json()) };
  };

  // Step 1: prefer _MERCHANT row (KRSC main_account OAuth token).
  const merchTok = await getValidMerchantToken();
  if (merchTok) {
    const r1 = await callWithToken(merchTok);
    if (!r1.error) return { ...r1, token_path: '_MERCHANT_row' };
    if (isInvalidAccessToken(r1)) {
      const refreshed = await refreshMerchantRowToken();
      if (refreshed) {
        const r2 = await callWithToken(refreshed);
        if (!r2.error) return { ...r2, token_path: '_MERCHANT_row_refreshed' };
        return { ...r2, token_path: '_MERCHANT_row_refreshed', stage: 'after_refresh' };
      }
    }
    if (!isInvalidAccessToken(r1)) return { ...r1, token_path: '_MERCHANT_row' };
  }

  // Step 2: if the KRSC source row is not present yet, try CBSC main_account_id issuance from the region token.
  let issuedErr: string | null = null;
  try {
    const issued = await issueMerchantToken(region);
    const r3 = await callWithToken({ access_token: issued.access_token, merchant_id: issued.merchant_id });
    if (!r3.error) return { ...r3, token_path: 'issued_merchant', scope: (issued as any).scope };
    issuedErr = `${r3.error || ''} ${r3.message || ''}`.trim();
    if (!isInvalidAccessToken(r3)) return { ...r3, token_path: 'issued_merchant', scope: (issued as any).scope };
  } catch (e: any) {
    issuedErr = String(e?.message || e);
  }

  // Step 3: fallback to shop token signed with merchant_id (works only for SOME endpoints; CBSC/KRSC global_product needs merchant auth).
  try {
    const t = await getValidToken(region, 'shop');
    const r3 = await callWithToken({ access_token: t.access_token, merchant_id: t.merchant_id });
    if (!r3.error) return { ...r3, token_path: 'shop_fallback' };
    return { ...r3, token_path: 'shop_fallback', has_merchant_row: !!merchTok, issued_error: issuedErr };
  } catch (e: any) {
    return { error: 'merchant_call_failed', message: String(e?.message || e), has_merchant_row: !!merchTok, issued_error: issuedErr };
  }
}

const V2_WIZARD_ACTOR = 'v2-wizard';
const V2_ROLLBACK_POLICY = 'no_auto_rollback_resume_only';
const V2_DEGRADED_APPROVAL = 'APPROVE_V2_DEGRADED_MUTATION';
const V2_MUTATION_ACTIONS = new Set([
  'update_global_item',
  'update_global_model',
  'update_global_price',
  'update_shop_days_to_ship',
  'update_shop_item_name',
  'set_global_sync_fields',
  'set_price_sync_on',
]);

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc: Record<string, any>, key) => {
      if (value[key] !== undefined) acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function stringArray(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry: any) => {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry === 'object') {
        return String(entry.image_id || entry.imageId || entry.id || entry.image_url || '').trim();
      }
      return '';
    })
    .filter((entry: string) => entry.length > 0);
}

function firstGlobalItemFromInfo(result: any, globalItemId: number) {
  const list = result?.response?.global_item_list || result?.global_item_list || [];
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.find((item: any) => Number(item?.global_item_id) === Number(globalItemId)) || list[0] || null;
}

function globalItemImageIds(item: any): string[] {
  const image = item?.image || {};
  const candidates = [
    image.image_id_list,
    image.image_url_list,
    item?.image_id_list,
    item?.image_url_list,
    Array.isArray(image) ? image : null,
  ];
  for (const candidate of candidates) {
    const ids = stringArray(candidate);
    if (ids.length) return ids;
  }
  return [];
}

async function hydrateUpdateGlobalItemPayload(region: string, requestPayload: any) {
  const payload = canonicalize(requestPayload);
  if (payload.image?.image_id_list?.length) return payload;
  const globalItemId = Number(payload.global_item_id || 0);
  if (!Number.isFinite(globalItemId) || globalItemId <= 0) return payload;
  const result = await merchantApiCall(region, '/api/v2/global_product/get_global_item_info', {
    query: { global_item_id_list: String(globalItemId) },
  });
  const item = firstGlobalItemFromInfo(result, globalItemId);
  const imageIds = globalItemImageIds(item);
  if (imageIds.length) payload.image = { image_id_list: imageIds };
  return payload;
}

async function sha256Hex(value: unknown): Promise<string> {
  const text = typeof value === 'string' ? value : JSON.stringify(canonicalize(value));
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function decodeBase64Image(raw: string) {
  const input = String(raw || '').trim();
  if (!input) return { ok: false, error: 'image_base64 required' };
  const dataUrlMatch = input.match(/^data:([^;,]+);base64,(.+)$/i);
  const mimeHint = (dataUrlMatch?.[1] || '').toLowerCase();
  if (mimeHint && (/svg/i.test(mimeHint) || !/^image\/(jpeg|jpg|png)$/.test(mimeHint))) {
    return { ok: false, error: 'unsupported_image_type' };
  }
  const b64 = dataUrlMatch ? dataUrlMatch[2] : input.replace(/^data:[^;]+;base64,/i, '');
  const compact = b64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return { ok: false, error: 'invalid_base64' };
  if (Math.floor(compact.length * 3 / 4) > UPLOAD_IMAGE_MAX_BYTES) return { ok: false, error: 'image_too_large' };
  let binaryStr = '';
  try {
    binaryStr = atob(compact);
  } catch (_) {
    return { ok: false, error: 'invalid_base64' };
  }
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  if (bytes.byteLength > UPLOAD_IMAGE_MAX_BYTES) return { ok: false, error: 'image_too_large' };
  return { ok: true, bytes, mimeHint };
}

function parsePngDimensions(bytes: Uint8Array) {
  if (bytes.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((v, i) => bytes[i] === v)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20), mime: 'image/png' };
}

function parseJpegDimensions(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 4 >= bytes.length) break;
    const length = (bytes[offset + 2] << 8) + bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) break;
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof && offset + 8 < bytes.length) {
      const height = (bytes[offset + 5] << 8) + bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) + bytes[offset + 8];
      return { width, height, mime: 'image/jpeg' };
    }
    offset += 2 + length;
  }
  return null;
}

function inspectUploadImage(bytes: Uint8Array, mimeHint = '') {
  if (isSvgLike(mimeHint, bytes)) return { ok: false, error: 'svg_not_allowed' };
  const dims = parsePngDimensions(bytes) || parseJpegDimensions(bytes);
  if (!dims) return { ok: false, error: 'unsupported_image_signature' };
  if (
    dims.width < UPLOAD_IMAGE_MIN_DIMENSION ||
    dims.height < UPLOAD_IMAGE_MIN_DIMENSION ||
    dims.width > UPLOAD_IMAGE_MAX_DIMENSION ||
    dims.height > UPLOAD_IMAGE_MAX_DIMENSION
  ) {
    return { ok: false, error: 'image_dimensions_out_of_range', width: dims.width, height: dims.height };
  }
  return { ok: true, ...dims };
}

function extractPerImageErrors(uploadJson: any) {
  const rows = Array.isArray(uploadJson?.response?.image_info_list) ? uploadJson.response.image_info_list : [];
  return rows
    .filter((row: any) => row?.error)
    .map((row: any) => ({ id: row?.id ?? null, error: row?.error || '', message: row?.message || '' }));
}

function extractUploadImageInfo(uploadJson: any, region: string) {
  const firstListInfo = Array.isArray(uploadJson?.response?.image_info_list)
    ? uploadJson.response.image_info_list.find((row: any) => !row?.error)?.image_info
    : null;
  const info = uploadJson?.response?.image_info || firstListInfo || uploadJson?.response || {};
  const list = info.image_url_list || uploadJson?.response?.image_url_list || [];
  const matched = Array.isArray(list) ? list.find((e: any) => String(e.image_url_region || '').toUpperCase() === region) : null;
  const image_url = matched?.image_url || matched?.url
    || (Array.isArray(list) ? (list[0]?.image_url || list[0]?.url) : '')
    || uploadJson?.response?.image_url || '';
  const image_id = info.image_id || uploadJson?.response?.image_id || '';
  return { image_id, image_url, request_id: uploadJson?.request_id || null };
}

function shouldFallbackToShopSignedUpload(uploadJson: any) {
  const text = `${uploadJson?.error || ''} ${uploadJson?.message || ''}`.toLowerCase();
  return /access_token|shop_id|permission|auth|sign/.test(text);
}

async function fetchShopeeUpload(app: any, path: string, query: URLSearchParams, bytes: Uint8Array, mime: string, body: any, authShape: string) {
  const uploadUrl = `https://${host(app.is_sandbox)}${path}?${query}`;
  const formData = new FormData();
  formData.append('image', new Blob([bytes], { type: mime }), mime === 'image/png' ? 'product.png' : 'product.jpg');
  formData.append('scene', String(body.scene || 'normal'));
  if (body.ratio) formData.append('ratio', String(body.ratio));
  const started = Date.now();
  const uploadResp = await fetch(uploadUrl, { method: 'POST', body: formData });
  const uploadJson = await uploadResp.json().catch(() => ({ error: 'invalid_json_response', message: 'Shopee returned non-JSON response' }));
  return { http_status: uploadResp.status, duration_ms: Date.now() - started, auth_shape: authShape, ...uploadJson };
}

async function uploadShopeeMediaImage(region: string, bytes: Uint8Array, mime: string, body: any) {
  const app = await getApp();
  const path = '/api/v2/media_space/upload_image';
  const ts = Math.floor(Date.now() / 1000);
  const partnerSign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}`);
  const partnerQuery = new URLSearchParams({
    partner_id: String(app.partner_id),
    timestamp: String(ts),
    sign: partnerSign,
  });
  const partnerResult = await fetchShopeeUpload(app, path, partnerQuery, bytes, mime, body, 'partner_public');
  if (!partnerResult.error || !shouldFallbackToShopSignedUpload(partnerResult)) return partnerResult;

  const t = await getValidToken(region, 'shop');
  const shopTs = Math.floor(Date.now() / 1000);
  const shopSign = await hmac(app.partner_key, `${app.partner_id}${path}${shopTs}${t.access_token}${t.shop_id}`);
  const shopQuery = new URLSearchParams({
    partner_id: String(app.partner_id),
    timestamp: String(shopTs),
    access_token: t.access_token,
    shop_id: String(t.shop_id),
    sign: shopSign,
  });
  const shopResult = await fetchShopeeUpload(app, path, shopQuery, bytes, mime, body, 'shop_access_token_fallback');
  return { ...shopResult, first_error: partnerResult.error || null, first_message: partnerResult.message || null };
}

async function findRecentGeneratedUpload(idempotencyKeyHash: string, region: string) {
  if (!idempotencyKeyHash) return null;
  const since = new Date(Date.now() - GENERATED_UPLOAD_CACHE_TTL_MS).toISOString();
  const { data, error } = await supabase
    .from('shopee_mutation_log')
    .select('id, created_at, response')
    .eq('action', 'upload_image')
    .eq('status', 'ok')
    .eq('region', region)
    .eq('request_payload->>idempotency_key_hash', idempotencyKeyHash)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    audit('upload_image_cache_lookup_failed', { region, error: error.message });
    return null;
  }
  return data || null;
}

async function insertUploadLog(params: {
  region: string;
  payloadHash: string;
  requestPayload: any;
  status: 'ok' | 'error' | 'skipped';
  response?: any;
  errorMsg?: string | null;
  requestId?: string | null;
  durationMs?: number | null;
  body?: any;
}) {
  try {
    return await insertMutationLog({
      action: 'upload_image',
      region: params.region,
      payloadHash: params.payloadHash,
      requestPayload: params.requestPayload,
      status: params.status,
      response: params.response,
      errorMsg: params.errorMsg,
      requestId: params.requestId,
      durationMs: params.durationMs,
      body: { ...(params.body || {}), actor: params.body?.actor || 'v2-staronemall-media' },
    });
  } catch (e: any) {
    audit('upload_image_log_failed', { region: params.region, status: params.status, error: String(e?.message || e) });
    return { id: null, skipped: false };
  }
}

function approvalFields(body: any): string[] {
  if (Array.isArray(body?.approved_blocked_fields)) return body.approved_blocked_fields.map((v: any) => String(v));
  if (Array.isArray(body?.degraded_fields)) return body.degraded_fields.map((v: any) => String(v));
  return [];
}

function hasExplicitDegradedApproval(body: any, fields: string[]): boolean {
  if (!body?.allow_degraded) return false;
  if (String(body?.degraded_approval || '') !== V2_DEGRADED_APPROVAL) return false;
  const approved = new Set(approvalFields(body));
  return fields.every(field => approved.has(field));
}

async function getV2CapabilityFlags() {
  const { data } = await supabase.from('shopee_app').select('*').eq('id', 1).single();
  const config = data?.config && typeof data.config === 'object' ? data.config : {};
  return {
    probe_item_name_ok: Boolean((config as any).probe_item_name_ok ?? data?.probe_item_name_ok),
    probe_model_weight_ok: Boolean((config as any).probe_model_weight_ok ?? data?.probe_model_weight_ok),
  };
}

function stripFieldsForDegradedPayload(action: string, requestPayload: any, blockedFields: string[]) {
  const payload = canonicalize(requestPayload);
  if (action === 'update_global_item') {
    if (blockedFields.includes('item_name')) delete payload.item_name;
    if (blockedFields.includes('description')) delete payload.description;
    if (blockedFields.includes('weight')) delete payload.weight;
  }
  if (action === 'update_global_model' && blockedFields.includes('weight')) {
    payload.global_model = (payload.global_model || []).map((m: any) => {
      const next = { ...m };
      delete next.weight;
      return next;
    });
  }
  return payload;
}

async function enforceV2ProbePreflight(action: string, requestPayload: any, body: any) {
  const flags = await getV2CapabilityFlags();
  const blockedFields: string[] = [];
  if (action === 'update_global_item') {
    if (requestPayload.item_name !== undefined && !flags.probe_item_name_ok) blockedFields.push('item_name');
    if (requestPayload.description !== undefined && !flags.probe_item_name_ok) blockedFields.push('description');
    if (requestPayload.weight !== undefined && !flags.probe_model_weight_ok) blockedFields.push('weight');
  }
  if (action === 'update_global_model') {
    const hasWeight = Array.isArray(requestPayload.global_model)
      && requestPayload.global_model.some((m: any) => m?.weight !== undefined);
    if (hasWeight && !flags.probe_model_weight_ok) blockedFields.push('weight');
  }
  if (blockedFields.length === 0) {
    return { ok: true, requestPayload, blockedFields, degraded: false, flags };
  }
  if (!hasExplicitDegradedApproval(body, blockedFields)) {
    return {
      ok: false,
      status: 428,
      error: 'v2_probe_preflight_blocked',
      message: `Probe has not approved fields: ${blockedFields.join(', ')}`,
      blocked_fields: blockedFields,
      approval_required: {
        allow_degraded: true,
        degraded_approval: V2_DEGRADED_APPROVAL,
        approved_blocked_fields: blockedFields,
      },
      flags,
    };
  }
  const degradedPayload = stripFieldsForDegradedPayload(action, requestPayload, blockedFields);
  return { ok: true, requestPayload: degradedPayload, blockedFields, degraded: true, flags };
}

function mutationTargets(action: string, region: string, requestPayload: any) {
  const modelIds = Array.isArray(requestPayload.global_model)
    ? requestPayload.global_model.map((m: any) => Number(m?.global_model_id)).filter((n: number) => Number.isFinite(n) && n > 0)
    : [];
  return {
    region,
    target_global_item_id: Number(requestPayload.global_item_id) || null,
    target_global_model_id: modelIds.length === 1 ? modelIds[0] : null,
    target_shop_item_id: Number(requestPayload.item_id || requestPayload.shop_item_id) || null,
  };
}

async function insertMutationLog(params: {
  action: string;
  region: string;
  payloadHash: string;
  requestPayload: any;
  status: 'dry_run' | 'ok' | 'error' | 'skipped';
  response?: any;
  errorMsg?: string | null;
  requestId?: string | null;
  durationMs?: number | null;
  body?: any;
}) {
  const targets = mutationTargets(params.action, params.region, params.requestPayload);
  const row: Record<string, any> = {
    actor: params.body?.actor || V2_WIZARD_ACTOR,
    action: params.action,
    ...targets,
    payload_hash: params.payloadHash,
    request_payload: params.requestPayload,
    response: params.response || null,
    status: params.status,
    error_msg: params.errorMsg || null,
    request_id: params.requestId || null,
    duration_ms: params.durationMs ?? null,
    run_id: params.body?.run_id || null,
    operator_id: params.body?.operator_id || null,
    rollback_policy: V2_ROLLBACK_POLICY,
  };
  const { data, error } = await supabase.from('shopee_mutation_log').insert(row).select('id').single();
  if (error) {
    if (params.status === 'ok' && /duplicate key|uidx_shopee_mutation_log_idempotent/i.test(error.message || '')) {
      const prev = await findOkMutation(params.payloadHash);
      return { skipped: true, previous_log_id: prev?.id || null, insert_error: error.message };
    }
    throw new Error(`mutation_log insert failed: ${error.message}`);
  }
  return { id: data?.id || null, skipped: false };
}

async function findOkMutation(payloadHash: string) {
  const { data } = await supabase
    .from('shopee_mutation_log')
    .select('id, created_at, response')
    .eq('payload_hash', payloadHash)
    .eq('status', 'ok')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

// ─── publish_request_id idempotency gate (D2 P1) ────────────────────────────
//
// If the caller supplies a publish_request_id (UUID string) in the request body,
// we check shopee_publish_idempotency before forwarding to Shopee.
//
//  - Cache hit  → return the stored response immediately (no Shopee call).
//  - Cache miss → call handler(), store the result, return it.
//  - Race / duplicate INSERT → fetch the winner row and return it (convergence).
//  - No publish_request_id → call handler() directly (back-compat, no change).
//
// Cache TTL: 7 days (rows older than 7 days are ignored in the SELECT so stale
// entries don't pollute the cache without a hard DELETE).
//
// The wrapper is transparent — it never alters the shape returned by handler().

const PUBLISH_IDEMPOTENCY_TTL_DAYS = 7;

async function withPublishRequestId(
  action: string,
  region: string,
  shopId: number | null,
  body: any,
  handler: () => Promise<Response>,
): Promise<Response> {
  const rawId = typeof body?.publish_request_id === 'string' ? body.publish_request_id.trim() : null;
  // Validate UUID format — reject malformed values so they don't slip through.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!rawId || !uuidRe.test(rawId)) {
    // No (or invalid) publish_request_id — pass through unchanged.
    return handler();
  }

  const since = new Date(Date.now() - PUBLISH_IDEMPOTENCY_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Step 1: look up existing cached result.
  const { data: cached, error: lookupErr } = await supabase
    .from('shopee_publish_idempotency')
    .select('response')
    .eq('publish_request_id', rawId)
    .gte('created_at', since)
    .maybeSingle();

  if (lookupErr) {
    // Non-fatal: log and fall through to real call so we don't block the operator.
    audit('publish_idempotency_lookup_failed', { action, region, publish_request_id: rawId, error: lookupErr.message });
  } else if (cached?.response) {
    audit('publish_idempotency_cache_hit', { action, region, publish_request_id: rawId });
    return new Response(JSON.stringify(cached.response, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  // Step 2: execute the real handler.
  const resp = await handler();

  // Step 3: only cache successful (2xx) responses to avoid storing error states.
  if (resp.status >= 200 && resp.status < 300) {
    let parsed: unknown = null;
    try {
      // Clone so the original Response body stream is not consumed.
      parsed = await resp.clone().json();
    } catch (_) {
      // Non-JSON response — skip caching.
    }
    if (parsed !== null) {
      const { error: insertErr } = await supabase
        .from('shopee_publish_idempotency')
        .insert({
          publish_request_id: rawId,
          action,
          region: region || null,
          shop_id: shopId || null,
          response: parsed,
        });

      if (insertErr) {
        // Unique-violation means a concurrent call already inserted — fetch it.
        if (/duplicate key|unique.*violation/i.test(insertErr.message || '')) {
          const { data: winner } = await supabase
            .from('shopee_publish_idempotency')
            .select('response')
            .eq('publish_request_id', rawId)
            .gte('created_at', since)
            .maybeSingle();
          if (winner?.response) {
            audit('publish_idempotency_race_resolved', { action, region, publish_request_id: rawId });
            return new Response(JSON.stringify(winner.response, null, 2), {
              status: 200,
              headers: { 'Content-Type': 'application/json', ...CORS },
            });
          }
        } else {
          audit('publish_idempotency_insert_failed', { action, region, publish_request_id: rawId, error: insertErr.message });
        }
      } else {
        audit('publish_idempotency_stored', { action, region, publish_request_id: rawId });
      }
    }
  }

  return resp;
}
// ────────────────────────────────────────────────────────────────────────────

async function forceRefreshForMutation(region: string, action: string) {
  if (action === 'update_shop_days_to_ship') {
    const refreshed = await forceRefreshShopToken(region);
    audit('v2_pre_fanout_shop_refresh_ok', { region, shop_id: refreshed.shop_id, action });
    return { shop: { ok: true, shop_id: refreshed.shop_id, expires_at: refreshed.expires_at } };
  }
  const merchant = await refreshMerchantRowToken();
  if (merchant) {
    audit('v2_pre_fanout_merchant_refresh_ok', { region, merchant_id: merchant.merchant_id, action });
    return { merchant: { ok: true, merchant_id: merchant.merchant_id } };
  }
  const issued = await issueMerchantToken(region);
  audit('v2_pre_fanout_merchant_issue_ok', { region, merchant_id: issued.merchant_id, action, scope: (issued as any).scope });
  return { merchant: { ok: true, merchant_id: issued.merchant_id, scope: (issued as any).scope } };
}

async function executeLoggedMutation(action: string, region: string, requestPayload: any, body: any, executor: (payload: any) => Promise<any>) {
  const payloadHash = await sha256Hex({ action, region, request_payload: requestPayload });
  const runId = body?.run_id || null;
  const dryRun = body?.dry_run === true;

  if (dryRun) {
    const log = await insertMutationLog({ action, region, payloadHash, requestPayload, status: 'dry_run', body });
    audit('v2_mutation_dry_run_logged', { action, region, run_id: runId, payload_hash: payloadHash, log_id: log.id || null, rollback_policy: V2_ROLLBACK_POLICY });
    return { ok: true, dry_run: true, region, action, payload_hash: payloadHash, log_id: log.id || null, request_payload: requestPayload, rollback_policy: V2_ROLLBACK_POLICY };
  }

  const previous = await findOkMutation(payloadHash);
  if (previous) {
    audit('v2_mutation_idempotent_skip', { action, region, run_id: runId, payload_hash: payloadHash, previous_log_id: previous.id });
    return { ok: true, skipped: true, previous_log_id: previous.id, region, action, payload_hash: payloadHash, rollback_policy: V2_ROLLBACK_POLICY };
  }

  const tokenRefresh = await forceRefreshForMutation(region, action);
  const started = Date.now();
  const result = await executor(requestPayload);
  const durationMs = Date.now() - started;
  const status = result?.error ? 'error' : 'ok';
  const log = await insertMutationLog({
    action,
    region,
    payloadHash,
    requestPayload,
    status,
    response: result,
    errorMsg: result?.error ? `${result.error || ''} ${result.message || ''}`.trim() : null,
    requestId: result?.request_id || null,
    durationMs,
    body,
  });
  if (log.skipped) {
    return { ok: true, skipped: true, previous_log_id: log.previous_log_id, region, action, payload_hash: payloadHash, result, rollback_policy: V2_ROLLBACK_POLICY };
  }
  audit('v2_mutation_logged', {
    action,
    region,
    run_id: runId,
    status,
    payload_hash: payloadHash,
    log_id: log.id || null,
    rollback_policy: V2_ROLLBACK_POLICY,
  });
  return {
    ok: !result?.error,
    region,
    action,
    payload_hash: payloadHash,
    log_id: log.id || null,
    result,
    token_refresh: tokenRefresh,
    rollback_policy: V2_ROLLBACK_POLICY,
    resume_hint: status === 'error' ? 'Use /v2_failed_mutations?run_id=... then resubmit the failed request_payload or call /v2_resume_failed.' : null,
  };
}

async function runV2MutationAction(action: string, body: any) {
  const r = String(body.region || 'SG').toUpperCase();
  if (!V2_MUTATION_ACTIONS.has(action)) {
    return { ok: false, error: 'unsupported_v2_mutation_action', action };
  }

  if (action === 'update_global_item') {
    const global_item_id = parseInt(body.global_item_id);
    const requestPayload: Record<string, any> = { global_item_id };
    const global_item_sku = typeof body.global_item_sku === 'string' ? body.global_item_sku.trim() : '';
    const item_name = typeof body.global_item_name === 'string'
      ? body.global_item_name.trim()
      : (typeof body.item_name === 'string' ? body.item_name.trim() : '');
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const days_to_ship = Number(body.days_to_ship ?? body?.pre_order?.days_to_ship);
    const weight = Number(body.weight);
    const imageIdList = stringArray(body?.image?.image_id_list || body?.image_id_list);
    if (global_item_sku) requestPayload.global_item_sku = global_item_sku;
    if (item_name) requestPayload.global_item_name = item_name;
    if (description) requestPayload.description = description;
    if (Number.isFinite(days_to_ship) && days_to_ship > 0) requestPayload.pre_order = { days_to_ship };
    if (Number.isFinite(weight) && weight > 0) requestPayload.weight = weight;
    if (imageIdList.length) requestPayload.image = { image_id_list: imageIdList };
    if (!global_item_id) return { ok: false, error: 'global_item_id required' };
    if (!global_item_sku && !item_name && !description && !requestPayload.pre_order && !requestPayload.weight) {
      return { ok: false, error: 'at least one of global_item_sku, global_item_name, description, days_to_ship, weight required' };
    }

    const preflight = await enforceV2ProbePreflight(action, requestPayload, body);
    if (!preflight.ok) return { ok: false, ...preflight };
    const finalPayload = await hydrateUpdateGlobalItemPayload(r, preflight.requestPayload);
    if (!finalPayload.global_item_sku && !finalPayload.global_item_name && !finalPayload.item_name && !finalPayload.description && !finalPayload.pre_order && !finalPayload.weight) {
      return { ok: false, error: 'v2_degraded_payload_empty', message: 'All requested fields were blocked by probe preflight.' };
    }
    const response = await executeLoggedMutation(action, r, finalPayload, body, payload =>
      merchantApiCall(r, '/api/v2/global_product/update_global_item', { method: 'POST', body: payload })
    );
    return { ...response, sent_global_item: finalPayload, degraded: preflight.degraded, blocked_fields: preflight.blockedFields };
  }

  if (action === 'update_global_model') {
    const global_item_id = parseInt(body.global_item_id);
    const global_model = Array.isArray(body.global_model) ? body.global_model : [];
    const cleaned = global_model
      .map((m: any) => {
        const next: Record<string, any> = { global_model_id: parseInt(m?.global_model_id) };
        const global_model_sku = typeof m?.global_model_sku === 'string' ? m.global_model_sku.trim() : '';
        if (global_model_sku) next.global_model_sku = global_model_sku;
        if (m?.weight !== undefined && m?.weight !== null && m?.weight !== '') next.weight = Number(m.weight);
        return next;
      })
      .filter((m: any) => Number.isFinite(m.global_model_id) && m.global_model_id > 0 && (m.global_model_sku || Number.isFinite(m.weight)));
    if (!global_item_id) return { ok: false, error: 'global_item_id required' };
    if (cleaned.length === 0) return { ok: false, error: 'global_model[] required (global_model_id + global_model_sku or weight)' };

    const requestPayload = { global_item_id, global_model: cleaned };
    const preflight = await enforceV2ProbePreflight(action, requestPayload, body);
    if (!preflight.ok) return { ok: false, ...preflight };
    const finalPayload = {
      ...preflight.requestPayload,
      global_model: (preflight.requestPayload.global_model || [])
        .filter((m: any) => m.global_model_sku || Number.isFinite(m.weight)),
    };
    if (!finalPayload.global_model.length) {
      return { ok: false, error: 'v2_degraded_payload_empty', message: 'All requested model fields were blocked by probe preflight.' };
    }
    const response = await executeLoggedMutation(action, r, finalPayload, body, payload =>
      merchantApiCall(r, '/api/v2/global_product/update_global_model', { method: 'POST', body: payload })
    );
    return { ...response, sent_global_model: finalPayload.global_model, global_item_id, degraded: preflight.degraded, blocked_fields: preflight.blockedFields };
  }

  if (action === 'update_global_price') {
    const global_item_id = parseInt(body.global_item_id);
    const global_price_list = body.global_price_list || [];
    if (!global_item_id) return { ok: false, error: 'global_item_id required' };
    if (!Array.isArray(global_price_list) || !global_price_list.length) return { ok: false, error: 'global_price_list required' };
    const requestPayload = { global_item_id, global_price_list };
    const response = await executeLoggedMutation(action, r, requestPayload, body, payload =>
      merchantApiCall(r, '/api/v2/global_product/update_price', { method: 'POST', body: payload })
    );
    return { ...response, global_item_id, sent_global_price_list: global_price_list };
  }

  // KRSC requires set_sync_field.price=true on each shop before
  // global_product.update_price can flow through. Operator calls this once
  // (or whenever a new shop joins) to flip the price sync toggle for the
  // supplied shop_sync_list. Other sync fields (name/media/days_to_ship/
  // tier_variation_name_and_option) are kept at their existing values when
  // possible — only required toggles are passed.
  // Docs: docs_ai_guides/guides/product/stock-price-management.md + docs_ai/
  //       apis/global_product/v2.global_product.set_sync_field.json
  if (action === 'set_price_sync_on' || action === 'set_global_sync_fields') {
    const shop_sync_list = Array.isArray(body.shop_sync_list) ? body.shop_sync_list : [];
    if (!shop_sync_list.length) return { ok: false, error: 'shop_sync_list required (each entry: { shop_id, shop_region })' };
    const normalized = shop_sync_list.map((entry: any) => ({
      shop_id: parseInt(entry?.shop_id),
      shop_region: String(entry?.shop_region || '').toUpperCase().trim(),
      // All five sync toggles are required by the API; default the non-price
      // ones to true so global product edits remain canonical for those
      // shops. Operator can override per-toggle by passing explicit booleans.
      name_and_description: entry?.name_and_description !== false,
      media_information: entry?.media_information !== false,
      tier_variation_name_and_option: entry?.tier_variation_name_and_option !== false,
      price: entry?.price !== false, // default true — the whole point of this action
      days_to_ship: entry?.days_to_ship !== false,
    }));
    const invalid = normalized.filter(e => !Number.isFinite(e.shop_id) || !e.shop_region);
    if (invalid.length) return { ok: false, error: 'each shop_sync_list entry needs shop_id (int) + shop_region (text)', invalid };
    const requestPayload = { shop_sync_list: normalized };
    const response = await executeLoggedMutation(action, r, requestPayload, body, payload =>
      merchantApiCall(r, '/api/v2/global_product/set_sync_field', { method: 'POST', body: payload })
    );
    return { ...response, applied_shops: normalized.map(e => ({ shop_id: e.shop_id, shop_region: e.shop_region })) };
  }

  if (action === 'update_shop_item_name') {
    const item_id = parseInt(body.item_id || body.shop_item_id);
    const item_name = typeof body.item_name === 'string' ? body.item_name.trim() : '';
    if (!item_id) return { ok: false, error: 'shop_item_id required' };
    if (!item_name) return { ok: false, error: 'item_name required' };
    const requestPayload = { item_id, item_name };
    const response = await executeLoggedMutation(action, r, requestPayload, body, payload =>
      shopApiCall(r, '/api/v2/product/update_item', { method: 'POST', body: payload })
    );
    return { ...response, item_id, sent_item_name: item_name };
  }

  const item_id = parseInt(body.item_id || body.shop_item_id);
  const days_to_ship = Number(body.days_to_ship);
  if (!item_id) return { ok: false, error: 'shop_item_id required' };
  if (!Number.isFinite(days_to_ship) || days_to_ship < 1 || days_to_ship > 150) {
    return { ok: false, error: 'days_to_ship must be between 1 and 150' };
  }
  const requestPayload = {
    item_id,
    days_to_ship,
    pre_order: { is_pre_order: days_to_ship > 2, days_to_ship },
  };
  const response = await executeLoggedMutation(action, r, requestPayload, body, payload =>
    shopApiCall(r, '/api/v2/product/update_item', { method: 'POST', body: payload })
  );
  return { ...response, item_id, sent_days_to_ship: days_to_ship };
}

function clampDaysToShip(v: unknown): number {
  const n = Number(v);
  return Math.max(1, Math.min(150, Number.isFinite(n) ? n : 2));
}

// Per Shopee UI/docs: Ready Stock DTS valid range is 1-10 (per Global SKU
// frame_016 observation); Pre-Order DTS valid range is 3-150 (per Shop SKU
// frame_020 observation). The Global add_global_item endpoint caps DTS at 10
// regardless of pre_order — operator msg #679. So:
//   - Ready Stock: clamp 1-10 (both Global + Region)
//   - Pre-Order Global: force 10 (max allowed at Global level)
//   - Pre-Order Region: clamp 3-150 (region max)
function clampReadyStockDts(v: unknown): number {
  const n = Number(v);
  return Math.max(1, Math.min(10, Number.isFinite(n) ? n : 2));
}
function clampPreOrderRegionDts(v: unknown): number {
  const n = Number(v);
  return Math.max(3, Math.min(150, Number.isFinite(n) ? n : 10));
}
const PRE_ORDER_GLOBAL_DTS = 10;

function imageBlockFrom(body: any) {
  const image: any = {};
  // Some regions (e.g. BR) reject items with fewer than 2 images. Callers
  // can pass image_id_list / image_url_list to satisfy that requirement.
  if (Array.isArray(body?.image_id_list) && body.image_id_list.length) {
    image.image_id_list = body.image_id_list.map((x: any) => String(x));
  } else if (body?.image_id) {
    image.image_id_list = [String(body.image_id)];
  } else if (Array.isArray(body?.image_url_list) && body.image_url_list.length) {
    image.image_url_list = body.image_url_list.map((x: any) => String(x));
  } else if (body?.image_url) {
    image.image_url_list = [String(body.image_url)];
  }
  return image;
}

function normalizeTierVariation(variation: any) {
  if (!variation?.tier_variation?.length) return [];
  return variation.tier_variation.slice(0, 2).map((t: any) => ({
    name: String(t?.name || '').trim(),
    option_list: Array.isArray(t?.option_list)
      ? t.option_list.map((o: any) => {
          const entry: any = { option: String(o?.option || '').trim() };
          // Path A (§2-3): per-option image. Pass through image object/url if provided.
          // probe_per_option_image_ok gate enforced at UI layer before calling bridge.
          if (o?.image) entry.image = o.image;
          return entry;
        }).filter((o: any) => o.option)
      : [],
  })).filter((t: any) => t.name && t.option_list.length > 0);
}

function normalizeVariation(variation: any) {
  const tier_variation = normalizeTierVariation(variation);
  const model = Array.isArray(variation?.model) ? variation.model : [];
  if (!tier_variation.length || !model.length) return null;
  if (tier_variation.length > 2) throw new Error('variation tiers must be <= 2');
  if (model.length > 50) throw new Error('variation combinations must be <= 50');
  return { tier_variation, model };
}

// buildGlobalModels — v44: migrated from normal_stock (sunset 2024-10-23) to seller_stock.
// Also adds optional per-model weight (float, kg) and per-option image fields when provided.
// Probe gate flags (probe_per_model_weight_ok / probe_per_option_image_ok) are checked at the
// UI layer before calling register_cbsc; bridge always sends what it receives.
function buildGlobalModels(variation: any, fallbackPrice: number, fallbackStock: number) {
  const normalized = normalizeVariation(variation);
  if (!normalized) return [];
  return normalized.model.map((m: any) => {
    const stock = Number(m?.stock ?? fallbackStock ?? 0);
    const model: any = {
      tier_index: Array.isArray(m?.tier_index) ? m.tier_index.map((x: any) => Number(x)) : [],
      global_model_sku: String(m?.global_model_sku || m?.model_sku || '').trim(),
      original_price: Number(m?.global_original_price ?? m?.original_price ?? fallbackPrice),
      // seller_stock replaces deprecated normal_stock (Shopee sunset 2024-10-23).
      seller_stock: [{ stock }],
    };
    // Optional: per-model weight in kg (probe_per_model_weight_ok gate at UI layer).
    // weight_g is stored in grams in our DB; Shopee expects kg float.
    if (m?.weight_g != null && Number(m.weight_g) > 0) {
      model.weight = Number(m.weight_g) / 1000;
    } else if (m?.weight != null && Number(m.weight) > 0) {
      // Already in kg (direct pass-through from caller).
      model.weight = Number(m.weight);
    }
    // Optional: per-model image_id (probe_per_option_image_ok gate at UI layer).
    // Shopee docs path A: model[].image_id — sent when available.
    if (m?.image_id) {
      model.image_id = String(m.image_id);
    }
    return model;
  });
}

function normalizeGlobalModelForAdd(model: any) {
  const stock = Number(model?.seller_stock?.[0]?.stock ?? model?.stock ?? model?.normal_stock ?? 0);
  const out: any = {
    tier_index: Array.isArray(model?.tier_index) ? model.tier_index.map((x: any) => Number(x)) : [],
    original_price: Number(model?.global_original_price ?? model?.original_price ?? 0),
    seller_stock: [{ stock }],
  };
  const sku = String(model?.global_model_sku || model?.model_sku || '').trim();
  if (sku) out.global_model_sku = sku;
  if (model?.image_id) out.image_id = String(model.image_id);
  return out;
}

function buildAddGlobalModelPayload(global_item_id: number, models: any[], body: any = {}, target: any = {}) {
  const dts = clampDaysToShip(target?.days_to_ship ?? body?.days_to_ship ?? body?.pre_order?.days_to_ship ?? 10);
  const payload: any = {
    global_item_id,
    global_model: models.map(normalizeGlobalModelForAdd),
    days_to_ship: dts,
    package_length: Number(body.package_length_cm ?? body.package_length ?? body.dimension?.package_length) || 20,
    package_width: Number(body.package_width_cm ?? body.package_width ?? body.dimension?.package_width) || 15,
    package_height: Number(body.package_height_cm ?? body.package_height ?? body.dimension?.package_height) || 5,
  };
  const weightKg = Number(body.weight ?? body.weight_kg ?? 0);
  if (weightKg > 0) payload.weight = weightKg;
  return payload;
}

function buildPublishModels(variation: any, fallbackPrice: number) {
  const normalized = normalizeVariation(variation);
  if (!normalized) return [];
  return normalized.model.map((m: any) => ({
    tier_index: Array.isArray(m?.tier_index) ? m.tier_index.map((x: any) => Number(x)) : [],
    original_price: Number(m?.original_price ?? fallbackPrice),
  }));
}

function buildGlobalItemPayload(body: any) {
  const dts = clampDaysToShip(body.days_to_ship);
  return {
    global_item_name: body.name,
    description: body.description || `${body.name}\n\nK-POP Official Merchandise. Ready stock.`,
    global_item_sku: body.sku,
    category_id: Number(body.category_id),
    condition: body.condition || 'NEW',
    weight: Number(body.weight_g || 100) / 1000,
    dimension: {
      package_length: Number(body.package_length_cm) || 20,
      package_width: Number(body.package_width_cm) || 15,
      package_height: Number(body.package_height_cm) || 5,
    },
    image: imageBlockFrom(body),
    original_price: Number(body.global_price ?? body.price),
    // seller_stock replaces deprecated normal_stock at global item level (Shopee sunset 2024-10-23).
    seller_stock: [{ stock: Number(body.stock || 0) }],
    pre_order: { days_to_ship: dts },
    brand: body.brand && body.brand.original_brand_name
      ? { brand_id: Number(body.brand.brand_id || 0), original_brand_name: String(body.brand.original_brand_name) }
      : { brand_id: 0, original_brand_name: 'No Brand' },
    attribute_list: Array.isArray(body.attribute_list) ? body.attribute_list : [],
  };
}

type AttrOption = { value_id?: number; original_value_name?: string; display_value_name?: string; value_name?: string };
type GlobalAttr = {
  attribute_id: number;
  name: string;
  is_mandatory: boolean;
  options: AttrOption[];
};

function asAttrName(a: any): string {
  return String(a?.display_attribute_name || a?.original_attribute_name || a?.attribute_name || a?.name || '').trim();
}

function asAttrOptions(a: any): AttrOption[] {
  const list = Array.isArray(a?.attribute_value_list) ? a.attribute_value_list
    : Array.isArray(a?.value_list) ? a.value_list
      : Array.isArray(a?.options) ? a.options
        : [];
  return list.map((v: any) => ({
    value_id: Number.isFinite(Number(v?.value_id)) ? Number(v.value_id) : undefined,
    original_value_name: v?.original_value_name || v?.display_value_name || v?.value_name || v?.name || '',
    display_value_name: v?.display_value_name || v?.original_value_name || v?.value_name || v?.name || '',
    value_name: v?.value_name || v?.display_value_name || v?.original_value_name || v?.name || '',
  }));
}

function flattenGlobalAttributes(raw: any): GlobalAttr[] {
  const src = raw?.response || raw || {};
  // Production get_attribute_tree (category_id_list form) wraps the tree as:
  //   response.list[<n>].attribute_tree[]  — each item is one requested category.
  // Older sandbox / legacy shapes used flat attribute_list / attributes at the root.
  // Support all shapes.
  const fromListWrapper: any[] = [];
  if (Array.isArray(src.list)) {
    for (const entry of src.list) {
      if (Array.isArray(entry?.attribute_tree)) fromListWrapper.push(...entry.attribute_tree);
      if (Array.isArray(entry?.attribute_list)) fromListWrapper.push(...entry.attribute_list);
    }
  }
  const roots = [
    ...(Array.isArray(src.attribute_list) ? src.attribute_list : []),
    ...(Array.isArray(src.attributes) ? src.attributes : []),
    ...(Array.isArray(src.attribute_tree) ? src.attribute_tree : []),
    ...(Array.isArray(src.children) ? src.children : []),
    ...fromListWrapper,
  ];
  const out: GlobalAttr[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    const id = Number(node.attribute_id ?? node.id ?? 0);
    const name = asAttrName(node);
    const mandatory = !!(node.is_mandatory ?? node.mandatory ?? node.required);
    if (id > 0 && name) out.push({ attribute_id: id, name, is_mandatory: mandatory, options: asAttrOptions(node) });
    const children = [
      ...(Array.isArray(node.children) ? node.children : []),
      ...(Array.isArray(node.attribute_list) ? node.attribute_list : []),
      ...(Array.isArray(node.attributes) ? node.attributes : []),
    ];
    children.forEach(walk);
  };
  roots.forEach(walk);
  const uniq = new Map<number, GlobalAttr>();
  out.forEach((a) => { if (!uniq.has(a.attribute_id)) uniq.set(a.attribute_id, a); });
  return Array.from(uniq.values());
}

function pickOptionByKeywords(options: AttrOption[], keywords: string[]): AttrOption | null {
  const lower = options.map((o) => ({ o, s: `${o.display_value_name || ''} ${o.original_value_name || ''} ${o.value_name || ''}`.toLowerCase() }));
  for (const kw of keywords) {
    const hit = lower.find((x) => x.s.includes(kw));
    if (hit) return hit.o;
  }
  return options[0] || null;
}

function defaultForMandatoryAttr(attr: GlobalAttr, categoryId: number): AttrOption | null {
  const name = attr.name.toLowerCase();
  const opts = attr.options || [];
  const kpopAlbumCategory = [300740, 100630].includes(Number(categoryId));
  if (name.includes('cd') && name.includes('dvd') && name.includes('bluray')) {
    return pickOptionByKeywords(opts, ['cd', 'album', 'regular']);
  }
  if (name.includes('country of origin') || name.includes('region of origin')) {
    return pickOptionByKeywords(opts, ['south korea', 'korea', 'kr']);
  }
  if (name.includes('shelf life')) {
    return pickOptionByKeywords(opts, ['no expiry', 'no expiration', 'not applicable', 'n/a', '12', '24']);
  }
  if (kpopAlbumCategory && (name.includes('media') || name.includes('format') || name.includes('type'))) {
    return pickOptionByKeywords(opts, ['cd', 'album', 'regular']);
  }
  return null;
}

function normalizeAttributeList(input: any[]): any[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((a: any) => ({
      attribute_id: Number(a?.attribute_id),
      attribute_value_list: Array.isArray(a?.attribute_value_list) ? a.attribute_value_list : [],
    }))
    .filter((a: any) => a.attribute_id > 0 && a.attribute_value_list.length > 0);
}

function parseMandatoryFromDebug(debugMessage: string): Array<{ attribute_id: number | null; attribute_name: string }> {
  if (!debugMessage) return [];
  const out: Array<{ attribute_id: number | null; attribute_name: string }> = [];
  const re = /Attribute is mandatory:\s*id:\s*([0-9]+)\s*,\s*name:\s*([^\]]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(debugMessage)) !== null) {
    out.push({ attribute_id: Number(m[1]), attribute_name: String(m[2] || '').trim() });
  }
  if (!out.length) {
    const re2 = /(CD,\s*DVD\s*&\s*Bluray\s*Type|Country of Origin|Region of Origin|shelf life[s]?)/ig;
    while ((m = re2.exec(debugMessage)) !== null) out.push({ attribute_id: null, attribute_name: m[1] });
  }
  return out;
}

function fallbackAttrValueByName(name: string): string | null {
  const n = String(name || '').toLowerCase();
  if (n.includes('cd') && n.includes('dvd') && n.includes('bluray')) return 'CD';
  if (n.includes('country of origin') || n.includes('region of origin')) return 'South Korea';
  if (n.includes('shelf life')) return 'No Expiration';
  return null;
}

async function buildCategoryAttributeList(region: string, categoryId: number, inputAttrs: any[]) {
  const normalized = normalizeAttributeList(inputAttrs);
  const byId = new Map<number, any>();
  normalized.forEach((a) => byId.set(Number(a.attribute_id), a));
  // Shopee Open Platform docs reference get_mtsku_attribute_tree with category_ids list
  // (sandbox path returns 404 in production — verified 2026-05-21). On the production
  // partner endpoint the correct path is /get_attribute_tree but the parameter must be
  // category_id_list (CSV/array), not category_id. Single-value category_id returns
  // an empty response{}; passing the list form fills attribute_list correctly.
  const attrTreeRes = await merchantApiCall(region, '/api/v2/global_product/get_attribute_tree', { query: { category_id_list: String(categoryId), language: 'en' } });
  const treeAttrs = flattenGlobalAttributes(attrTreeRes);
  const missing: any[] = [];
  for (const attr of treeAttrs.filter((a) => a.is_mandatory)) {
    const existing = byId.get(attr.attribute_id);
    const hasValue = !!(existing && Array.isArray(existing.attribute_value_list) && existing.attribute_value_list.length > 0);
    if (hasValue) continue;
    const picked = defaultForMandatoryAttr(attr, categoryId);
    if (picked) {
      byId.set(attr.attribute_id, {
        attribute_id: attr.attribute_id,
        attribute_value_list: [{
          ...(picked.value_id ? { value_id: picked.value_id } : {}),
          original_value_name: picked.original_value_name || picked.display_value_name || picked.value_name || '',
        }],
      });
      continue;
    }
    missing.push({
      attribute_id: attr.attribute_id,
      attribute_name: attr.name,
      options: (attr.options || []).slice(0, 20).map((o) => ({
        value_id: o.value_id ?? null,
        value_name: o.display_value_name || o.original_value_name || o.value_name || '',
      })),
    });
  }
  return { attribute_list: Array.from(byId.values()), missing, attr_tree_raw: attrTreeRes };
}

async function getRegionShopId(region: string): Promise<number> {
  const { data } = await supabase.from('shopee_tokens').select('shop_id').eq('region', region).single();
  const shopId = Number(data?.shop_id);
  if (!shopId) throw new Error(`no shop_id for region ${region}`);
  return shopId;
}

async function getPublishLogistics(region: string, isPreOrder = false) {
  const result = await shopApiCall(region, '/api/v2/logistics/get_channel_list');
  const channels: any[] = result?.response?.logistics_channel_list || [];
  const pickId = (ch: any) => ch?.logistic_id ?? ch?.logistics_channel_id ?? ch?.channel_id ?? ch?.id;
  const pickName = (ch: any) => ch?.logistic_name ?? ch?.name ?? `channel_${pickId(ch)}`;
  let enabled = channels.filter(ch => pickId(ch) != null && (ch.enabled ?? true));
  // Pre-order items can only use channels that explicitly support_pre_order=true.
  // (Verified 2026-05-22 — PH channel 48023 returned
  // "publish fail : channelID: 48023, msg:channel not support pre order".)
  if (isPreOrder) {
    enabled = enabled.filter(ch => ch.support_pre_order === true);
  }
  const out = enabled.map(ch => ({
    logistic_id: Number(pickId(ch)),
    logistic_name: String(pickName(ch)),
    enabled: true,
    is_free: false,
  }));
  return out.length ? out : [{ logistic_id: 80007, logistic_name: 'Default', enabled: true, is_free: false }];
}

function buildPublishItemPayload(body: any, target: any, logistics: any[]) {
  const price = Number(target.price ?? body.price);
  // is_pre_order is decided by caller (adapter) via body.is_pre_order OR
  // lifecycle_state === 'pre_order'. Default false (Ready Stock) for back-compat.
  const isPreOrder = body.is_pre_order === true || body.lifecycle_state === 'pre_order';
  const dtsRaw = target.days_to_ship ?? body.days_to_ship;
  const dts = isPreOrder
    ? clampPreOrderRegionDts(dtsRaw)
    : clampReadyStockDts(dtsRaw);
  const item: any = {
    item_name: body.name,
    description: body.description || `${body.name}\n\nK-POP Official Merchandise. Ready stock.`,
    item_status: body.item_status || 'NORMAL',
    original_price: price,
    image: imageBlockFrom(body),
    category_id: Number(body.category_id),
    logistic: logistics,
    pre_order: { is_pre_order: isPreOrder, days_to_ship: dts },
  };
  const publishVariation = normalizeVariation(target.variation || body.variation);
  if (publishVariation) {
    item.tier_variation = publishVariation.tier_variation;
    item.model = buildPublishModels(publishVariation, price);
  }
  return item;
}

function isPublishPending(task: any): boolean {
  const status = String(task?.response?.publish_status || task?.response?.status || task?.status || '');
  return /processing|pending|in_process|in progress/i.test(status);
}

function parsePublishOutcome(region: string, shopId: number, publishTaskId: number, task: any) {
  const response = task?.response || {};
  const status = String(response.publish_status || response.status || '');
  const list = Array.isArray(response.publish_result) ? response.publish_result : [];
  const fromList = list.find((r: any) => String(r.region || r.shop_region || '').toUpperCase() === region || Number(r.shop_id) === shopId) || list[0];
  const success = response.success || fromList?.success || (fromList && !fromList.error ? fromList : null);
  const failed = response.failed || fromList?.failed || (fromList?.error ? fromList : null);
  const itemId = Number(success?.item_id || success?.shop_item_id || fromList?.item_id || fromList?.shop_item_id || 0) || null;
  const failedReason = failed?.failed_reason || failed?.message || failed?.error || fromList?.failed_reason || '';
  const ok = !!itemId || (/success|completed|done|finish/i.test(status) && !failedReason);
  return {
    ok,
    region,
    shop_id: shopId,
    publish_task_id: publishTaskId,
    item_id: itemId,
    publish_status: status || null,
    error: ok ? null : (failedReason || (isPublishPending(task) ? 'publish still pending' : 'publish failed')),
    task,
  };
}

// /list_items ??paginated get_item_list + batch get_item_base_info + per-item get_model_list (when has_model=true).
async function listItemsForRegion(region: string, item_status = 'NORMAL', max_items = 5000) {
  const authFailure = (prefix: string, r: any) => ({
    error: `${prefix}: ${r.error} ${r.message || ''}`.trim(),
    auth_stage: r.auth_stage || null,
    first_error: r.first_error || null,
    refresh_error: r.refresh_error || null,
    retried_after_shop_refresh: !!r.retried_after_shop_refresh,
  });
  const items: { item_id: number, item_status: string }[] = [];
  let offset = 0;
  for (let page = 0; page < 50 && items.length < max_items; page++) {
    const r = await shopApiCall(region, '/api/v2/product/get_item_list', { query: { offset, page_size: 100, item_status } });
    if (r.error) {
      if (page === 0 && /invalid|not_support|item_status/i.test(`${r.error} ${r.message || ''}`)) {
        const r2 = await shopApiCall(region, '/api/v2/product/get_item_list', { query: { offset: 0, page_size: 100 } });
        if (r2.error) return authFailure('get_item_list', r2);
        for (const it of (r2.response?.item || [])) items.push({ item_id: it.item_id, item_status: it.item_status });
        if (!r2.response?.has_next_page) break;
        offset = r2.response.next_offset || 0;
        continue;
      }
      return authFailure('get_item_list', r);
    }
    for (const it of (r.response?.item || [])) items.push({ item_id: it.item_id, item_status: it.item_status });
    if (!r.response?.has_next_page) break;
    offset = r.response.next_offset || 0;
    if (!offset) break;
  }
  const baseMap = new Map<number, any>();
  for (let i = 0; i < items.length; i += 50) {
    const chunk = items.slice(i, i + 50);
    const ids = chunk.map(c => c.item_id).join(',');
    const info = await shopApiCall(region, '/api/v2/product/get_item_base_info', { query: { item_id_list: ids } });
    if (info.error) continue;
    for (const it of (info.response?.item_list || [])) {
      const pInfo = (it.price_info && it.price_info[0]) || {};
      baseMap.set(it.item_id, {
        item_id: it.item_id,
        item_sku: it.item_sku || '',
        item_name: it.item_name || '',
        current_price: pInfo.current_price ?? pInfo.original_price ?? null,
        original_price: pInfo.original_price ?? null,
        currency: pInfo.currency || '',
        has_model: !!it.has_model,
        status: it.item_status || '',
      });
    }
  }
  const modelMap = new Map<number, any[]>();
  const modelTargets = Array.from(baseMap.values()).filter((b: any) => b.has_model);
  for (let i = 0; i < modelTargets.length; i += 5) {
    const batch = modelTargets.slice(i, i + 5);
    await Promise.all(batch.map(async (b: any) => {
      try {
        const r = await shopApiCall(region, '/api/v2/product/get_model_list', { query: { item_id: b.item_id } });
        if (r.error) { modelMap.set(b.item_id, []); return; }
        const models = (r.response?.model || []).map((m: any) => {
          const pInfo = (m.price_info && m.price_info[0]) || {};
          return {
            model_id: m.model_id,
            model_sku: m.model_sku || '',
            model_name: (m.tier_index || []).join(',') || '',
            current_price: pInfo.current_price ?? pInfo.original_price ?? null,
            original_price: pInfo.original_price ?? null,
            currency: pInfo.currency || '',
            stock: m.stock_info?.[0]?.current_stock ?? null,
          };
        });
        modelMap.set(b.item_id, models);
      } catch (e) { modelMap.set(b.item_id, []); }
    }));
  }
  const enriched: any[] = [];
  for (const c of items) {
    const base = baseMap.get(c.item_id);
    if (!base) {
      enriched.push({ item_id: c.item_id, model_id: null, item_sku: '', item_name: '', current_price: null, currency: '', has_model: false, status: c.item_status });
      continue;
    }
    if (!base.has_model) {
      enriched.push({
        item_id: base.item_id, model_id: null,
        item_sku: base.item_sku, item_name: base.item_name,
        current_price: base.current_price, original_price: base.original_price,
        currency: base.currency, has_model: false, status: base.status,
      });
      continue;
    }
    const models = modelMap.get(base.item_id) || [];
    if (models.length === 0) {
      enriched.push({
        item_id: base.item_id, model_id: null,
        item_sku: base.item_sku, item_name: base.item_name,
        current_price: base.current_price, original_price: base.original_price,
        currency: base.currency, has_model: true, status: base.status, model_fetch_failed: true,
      });
      continue;
    }
    for (const m of models) {
      enriched.push({
        item_id: base.item_id, model_id: m.model_id,
        item_sku: m.model_sku,
        base_sku: base.item_sku,
        item_name: base.item_name + (m.model_name ? ` 쨌 ${m.model_name}` : ''),
        current_price: m.current_price ?? base.current_price,
        original_price: m.original_price ?? base.original_price,
        currency: m.currency || base.currency,
        has_model: true, status: base.status, stock: m.stock,
      });
    }
  }
  return { count: enriched.length, items: enriched };
}

function jsonResp(b: any, s = 200) { return new Response(JSON.stringify(b, null, 2), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } }); }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const action = url.pathname.split('/').filter(Boolean).pop() || '';
  const region = url.searchParams.get('region') || 'SG';

  // Step 0 auth gate (plan v2.2): every mutating route requires a real signed-in
  // user. Read-only PUBLIC_ACTIONS skip the check so dashboards/probes that have
  // been working with the anon key keep working. anon JWT or no JWT → 401.
  if (!PUBLIC_ACTIONS.has(action)) {
    const authResult = await requireAuthenticatedUser(req);
    if (authResult.response) {
      audit('auth_rejected', { action, reason: 'requireAuthenticatedUser_failed' });
      return authResult.response;
    }
    audit('auth_ok', { action, user_id: authResult.user.id, email: authResult.user.email });
  }

  try {
    if (action === 'health') {
      const app = await getApp();
      return jsonResp({
        ok: true,
        service: 'shopee-bridge',
        version: HEALTH_VERSION,
        source_version: SOURCE_VERSION,
        deployment_version: DEPLOYMENT_VERSION,
        deployment_id: DENO_DEPLOYMENT_ID || null,
        env: {
          partner_id: app.partner_id,
          is_sandbox: app.is_sandbox,
          has_env_partner_id: !!ENV_PARTNER_ID,
          has_env_partner_key: !!ENV_PARTNER_KEY,
        },
      });
    }
    if (action === 'try_refresh_variants') {
      // Tries all known refresh parameter shapes for the current region to find the one that returns a valid token.
      const { data } = await supabase.from('shopee_tokens').select('*').eq('region', region).single();
      if (!data) return jsonResp({ ok: false, error: `no tokens for region ${region}` }, 404);
      const app = await getApp();
      const path = '/api/v2/auth/access_token/get';
      const ts = Math.floor(Date.now() / 1000);
      const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}`);
      const url = `https://${host(app.is_sandbox)}${path}?partner_id=${app.partner_id}&timestamp=${ts}&sign=${sign}`;
      const variants: any[] = [
        { name: 'shop_id', body: { refresh_token: data.refresh_token, partner_id: app.partner_id, shop_id: data.shop_id } },
        { name: 'merchant_id', body: { refresh_token: data.refresh_token, partner_id: app.partner_id, merchant_id: data.merchant_id } },
        { name: 'main_account_id_constant', body: { refresh_token: data.refresh_token, partner_id: app.partner_id, main_account_id: MAIN_ACCOUNT_ID } },
        { name: 'main_account_id_as_merchant', body: { refresh_token: data.refresh_token, partner_id: app.partner_id, main_account_id: data.merchant_id } },
        { name: 'no_principal', body: { refresh_token: data.refresh_token, partner_id: app.partner_id } },
      ];
      const results: any[] = [];
      for (const v of variants) {
        try {
          const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v.body) });
          const j = await r.json();
          results.push({
            variant: v.name,
            sent_body: v.body,
            http: r.status,
            error: j.error || null,
            message: j.message || null,
            has_access: !!j.access_token,
            has_refresh: !!j.refresh_token,
            merchant_id: j.merchant_id || null,
            shop_id_list: j.shop_id_list || null,
            access_token_fp: fp(j.access_token || ''),
          });
        } catch (e: any) {
          results.push({ variant: v.name, error: String(e?.message || e) });
        }
      }
      return jsonResp({ ok: true, region, MAIN_ACCOUNT_ID, results });
    }
    if (action === 'tokens') {
      const { data } = await supabase.from('shopee_tokens').select('region, shop_id, merchant_id, expires_at, is_sandbox');
      const now = Math.floor(Date.now() / 1000);
      return jsonResp({ ok: true, tokens: (data || []).map(r => ({ ...r, expires_in_sec: r.expires_at - now })) });
    }
    if (action === 'token_probe') {
      const app = await getApp();
      const { data } = await supabase.from('shopee_tokens').select('region, shop_id, merchant_id, expires_at, is_sandbox, access_token').eq('region', region).single();
      if (!data) return jsonResp({ ok: false, region, error: 'token no' }, 404);
      const now = Math.floor(Date.now() / 1000);
      const probe = await probeShopToken(app, data.access_token, data.shop_id);
      return jsonResp({
        ok: probe.ok,
        region,
        shop_id: data.shop_id,
        merchant_id: data.merchant_id,
        expires_in_sec: data.expires_at - now,
        shop_probe: probe,
      }, probe.ok ? 200 : 502);
    }
    if (action === 'token_health' || action === 'token-health') {
      const runRefresh = url.searchParams.get('run_refresh') === '1';
      const includeMerchant = url.searchParams.get('include_merchant') !== '0';
      const targetRegions = parseTargetRegions(url.searchParams.get('regions'));
      const refreshThresholdSec = parsePositiveInt(url.searchParams.get('refresh_threshold_sec'), DEFAULT_REFRESH_THRESHOLD_SEC, 60, 21600);
      const maxRefreshAttempts = parsePositiveInt(url.searchParams.get('max_refresh_attempts'), DEFAULT_REFRESH_ATTEMPTS, 1, 5);
      const retryBaseMs = parsePositiveInt(url.searchParams.get('retry_base_ms'), DEFAULT_RETRY_BASE_MS, 100, 10000);
      const app = await getApp();
      const now = Math.floor(Date.now() / 1000);
      const { data } = await supabase
        .from('shopee_tokens')
        .select('region, shop_id, merchant_id, expires_at, is_sandbox, access_token')
        .in('region', targetRegions)
        .order('region', { ascending: true });
      const byRegion = new Map((data || []).map((row: any) => [String(row.region), row]));
      const results: any[] = [];
      const counters = {
        total: 0,
        probe_ok: 0,
        probe_fail: 0,
        refresh_attempted: 0,
        refresh_ok: 0,
        refresh_fail: 0,
        pre_expiry_refresh: 0,
        transient_fail: 0,
        permanent_fail: 0,
        principal_mismatch: 0,
        skipped_banned: 0,
        missing_token: 0,
        shop_total: 0,
        shop_ok: 0,
        shop_fail: 0,
        merchant_total: 0,
        merchant_ok: 0,
        merchant_fail: 0,
      };

      for (const regionName of targetRegions) {
        counters.total++;
        counters.shop_total++;
        const row: any = byRegion.get(regionName);
        if (!row) {
          counters.missing_token++;
          counters.shop_fail++;
          results.push({
            principal: 'shop',
            region: regionName,
            ok: false,
            error: 'token_missing',
            refresh_skipped: 'missing_token_row',
          });
          continue;
        }

        const expiresIn = Number(row.expires_at || 0) - now;
        const out: any = {
          principal: 'shop',
          region: row.region,
          shop_id: row.shop_id,
          merchant_id: row.merchant_id,
          expires_in_sec: expiresIn,
          refresh_threshold_sec: refreshThresholdSec,
          next_refresh_due_in_sec: expiresIn - refreshThresholdSec,
        };

        const { data: shopRow } = await supabase
          .from('shopee_shops')
          .select('shop_id, region, merchant_id, status')
          .eq('shop_id', String(row.shop_id))
          .maybeSingle();
        out.shop_status = shopRow?.status || null;
        if (!shopRow) {
          counters.principal_mismatch++;
          counters.shop_fail++;
          out.ok = false;
          out.error = 'shop_principal_missing';
          out.refresh_skipped = 'missing_shopee_shops_row';
          results.push(out);
          continue;
        }
        if (String(shopRow.region || '') !== String(row.region)) {
          counters.principal_mismatch++;
          counters.shop_fail++;
          out.ok = false;
          out.error = 'shop_principal_region_mismatch';
          out.refresh_skipped = 'principal_mismatch';
          results.push(out);
          continue;
        }
        if (shopRow.status === 'banned') {
          counters.skipped_banned++;
          counters.shop_fail++;
          out.ok = false;
          out.error = 'shop_banned';
          out.refresh_skipped = 'banned_shop';
          results.push(out);
          continue;
        }

        const probe = row.access_token ? await probeShopToken(app, row.access_token, row.shop_id) : { ok: false, http_status: 0, error: 'missing_access_token', message: 'missing access_token', request_id: null };
        if (probe.ok) counters.probe_ok++;
        else counters.probe_fail++;
        out.probe_ok = probe.ok;
        out.probe_http_status = probe.http_status;
        out.probe_error = probe.error || null;
        out.probe_message = probe.message || null;

        const refreshReasons: string[] = [];
        if (expiresIn <= refreshThresholdSec) refreshReasons.push('pre_expiry');
        if (!probe.ok) refreshReasons.push('probe_failed');
        out.refresh_reasons = refreshReasons;
        out.refresh_needed = runRefresh && refreshReasons.length > 0;
        if (runRefresh && refreshReasons.length > 0) {
          counters.refresh_attempted++;
          if (refreshReasons.includes('pre_expiry')) counters.pre_expiry_refresh++;
          const refreshed = await refreshWithRetry(`shop:${row.region}`, () => forceRefreshShopToken(row.region), maxRefreshAttempts, retryBaseMs);
          out.refresh_attempts = refreshed.attempts;
          if (refreshed.ok) {
            counters.refresh_ok++;
            const refreshedValue = refreshed.value;
            const nowAfter = Math.floor(Date.now() / 1000);
            out.refresh_ok = true;
            out.refreshed_expires_at = refreshedValue.expires_at;
            out.expires_in_sec = refreshedValue.expires_at - nowAfter;
            out.next_refresh_due_in_sec = out.expires_in_sec - refreshThresholdSec;
            out.probe_after_refresh_ok = true;
            out.ok = true;
          } else {
            counters.refresh_fail++;
            if (refreshed.transient) counters.transient_fail++;
            if (refreshed.permanent) counters.permanent_fail++;
            if (String(refreshed.error || '').includes('principal mismatch')) counters.principal_mismatch++;
            out.refresh_ok = false;
            out.refresh_error = refreshed.error;
            out.failure_kind = refreshed.permanent ? 'permanent' : (refreshed.transient ? 'transient' : 'unknown');
            out.ok = false;
          }
        } else {
          out.ok = probe.ok && expiresIn > 0;
        }
        if (out.ok) counters.shop_ok++;
        else counters.shop_fail++;
        results.push(out);
      }

      let merchantResult: any = null;
      if (includeMerchant) {
        counters.total++;
        counters.merchant_total++;
        const { data: merchantRow } = await supabase
          .from('shopee_tokens')
          .select('region, merchant_id, expires_at, is_sandbox, access_token')
          .eq('region', '_MERCHANT')
          .maybeSingle();
        if (!merchantRow) {
          counters.missing_token++;
          counters.merchant_fail++;
          merchantResult = {
            principal: 'merchant',
            region: '_MERCHANT',
            ok: false,
            error: 'merchant_row_missing',
            refresh_skipped: 'missing_token_row',
          };
        } else {
          const expiresIn = Number(merchantRow.expires_at || 0) - now;
          merchantResult = {
            principal: 'merchant',
            region: '_MERCHANT',
            merchant_id: merchantRow.merchant_id,
            expires_in_sec: expiresIn,
            refresh_threshold_sec: refreshThresholdSec,
            next_refresh_due_in_sec: expiresIn - refreshThresholdSec,
          };
          const probe = merchantRow.access_token && merchantRow.merchant_id
            ? await probeMerchantToken(app, merchantRow.access_token, merchantRow.merchant_id)
            : { ok: false, http_status: 0, error: 'merchant_principal_missing', message: 'missing access_token or merchant_id', request_id: null };
          if (probe.ok) counters.probe_ok++;
          else counters.probe_fail++;
          merchantResult.probe_ok = probe.ok;
          merchantResult.probe_http_status = probe.http_status;
          merchantResult.probe_error = probe.error || null;
          merchantResult.probe_message = probe.message || null;
          merchantResult.category_count = (probe as any).category_count ?? null;

          const refreshReasons: string[] = [];
          if (expiresIn <= refreshThresholdSec) refreshReasons.push('pre_expiry');
          if (!probe.ok) refreshReasons.push('probe_failed');
          merchantResult.refresh_reasons = refreshReasons;
          merchantResult.refresh_needed = runRefresh && refreshReasons.length > 0;
          if (runRefresh && refreshReasons.length > 0) {
            counters.refresh_attempted++;
            if (refreshReasons.includes('pre_expiry')) counters.pre_expiry_refresh++;
            const refreshed = await refreshWithRetry('merchant:_MERCHANT', () => refreshMerchantRowTokenStrict(), maxRefreshAttempts, retryBaseMs);
            merchantResult.refresh_attempts = refreshed.attempts;
            if (refreshed.ok) {
              counters.refresh_ok++;
              const refreshedValue = refreshed.value;
              const nowAfter = Math.floor(Date.now() / 1000);
              const afterProbe = await probeMerchantToken(app, refreshedValue.access_token, refreshedValue.merchant_id);
              merchantResult.refresh_ok = true;
              merchantResult.refreshed_expires_at = refreshedValue.expires_at;
              merchantResult.expires_in_sec = refreshedValue.expires_at - nowAfter;
              merchantResult.next_refresh_due_in_sec = merchantResult.expires_in_sec - refreshThresholdSec;
              merchantResult.probe_after_refresh_ok = afterProbe.ok;
              merchantResult.probe_after_refresh_error = afterProbe.error || null;
              merchantResult.ok = afterProbe.ok;
            } else {
              counters.refresh_fail++;
              if (refreshed.transient) counters.transient_fail++;
              if (refreshed.permanent) counters.permanent_fail++;
              merchantResult.refresh_ok = false;
              merchantResult.refresh_error = refreshed.error;
              merchantResult.failure_kind = refreshed.permanent ? 'permanent' : (refreshed.transient ? 'transient' : 'unknown');
              merchantResult.ok = false;
            }
          } else {
            merchantResult.ok = probe.ok && expiresIn > 0;
          }
          if (merchantResult.ok) counters.merchant_ok++;
          else counters.merchant_fail++;
        }
        results.push(merchantResult);
      }

      const failures = results.filter((r: any) => !r.ok);
      const ok = failures.length === 0;
      audit('token_health_scan', {
        run_refresh: runRefresh,
        refresh_threshold_sec: refreshThresholdSec,
        max_refresh_attempts: maxRefreshAttempts,
        target_regions: targetRegions,
        ...counters,
      });
      return jsonResp({
        ok,
        overall_ok: ok,
        run_refresh: runRefresh,
        include_merchant: includeMerchant,
        target_regions: targetRegions,
        refresh_threshold_sec: refreshThresholdSec,
        max_refresh_attempts: maxRefreshAttempts,
        counters,
        failures: failures.map((r: any) => ({
          principal: r.principal,
          region: r.region,
          shop_id: r.shop_id || null,
          merchant_id: r.merchant_id || null,
          error: r.error || r.probe_error || r.refresh_error || null,
          failure_kind: r.failure_kind || null,
        })),
        shop_results: results.filter((r: any) => r.principal === 'shop'),
        merchant_result: merchantResult,
        results,
      });
    }
    if (action === 'shop_info') return jsonResp(await shopApiCall(region, '/api/v2/shop/get_shop_info'));
    // Debug: raw shop API call. GET /raw_call?region=SG&path=/api/v2/...&q=k1=v1&q=k2=v2
    if (action === 'raw_call') {
      const path = url.searchParams.get('path') || '';
      if (!path.startsWith('/api/v2/')) return jsonResp({ ok: false, error: 'path must start with /api/v2/' }, 400);
      const queries = url.searchParams.getAll('q');
      const query: Record<string, string> = {};
      for (const q of queries) {
        const i = q.indexOf('=');
        if (i > 0) query[q.slice(0, i)] = q.slice(i + 1);
      }
      const result = await shopApiCall(region, path, { query });
      return jsonResp({ ok: !result.error, region, path, query, result });
    }
    if (action === 'channels') {
      const result = await shopApiCall(region, '/api/v2/logistics/get_channel_list');
      return jsonResp({ ok: !result.error, region, result });
    }
    if (action === 'categories') {
      const result = await shopApiCall(region, '/api/v2/product/get_category', { query: { language: 'en' } });
      return jsonResp({ ok: !result.error, region, result });
    }
    if (action === 'attributes') {
      const category_id = url.searchParams.get('category_id') || '';
      if (!category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      const result = await shopApiCall(region, '/api/v2/product/get_attributes', { query: { category_id, language: 'en' } });
      return jsonResp({ ok: !result.error, region, category_id, result });
    }
    if (action === 'brands') {
      const category_id = url.searchParams.get('category_id') || '';
      const status = url.searchParams.get('status') || '1';
      if (!category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      const result = await shopApiCall(region, '/api/v2/product/get_brand_list', { query: { category_id, status, page_size: 100, offset: 0 } });
      return jsonResp({ ok: !result.error, region, category_id, result });
    }
    if (action === 'global_categories') {
      const result = await merchantApiCall(region, '/api/v2/global_product/get_category', { query: { language: 'en' } });
      return jsonResp({ ok: !result.error, region, result });
    }
    if (action === 'global_brands') {
      const category_id = url.searchParams.get('category_id') || '';
      const status = url.searchParams.get('status') || '1';
      if (!category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      const result = await merchantApiCall(region, '/api/v2/global_product/get_brand_list', { query: { category_id, status, page_size: 100, offset: 0 } });
      return jsonResp({ ok: !result.error, region, category_id, result });
    }
    if (action === 'global_attributes') {
      const category_id = url.searchParams.get('category_id') || '';
      if (!category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      // Production /get_attribute_tree requires category_id_list (CSV), not single category_id.
      const result = await merchantApiCall(region, '/api/v2/global_product/get_attribute_tree', { query: { category_id_list: category_id, language: 'en' } });
      return jsonResp({ ok: !result.error, region, category_id, result });
    }
    // POST /add_global_item: create only the GlobalProduct source item. Variation/model setup is separate.
    if (action === 'add_global_item' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      if (!body.name) return jsonResp({ ok: false, error: 'name required' }, 400);
      if (!body.sku) return jsonResp({ ok: false, error: 'sku required' }, 400);
      if (!body.price && !body.global_price) return jsonResp({ ok: false, error: 'price required' }, 400);
      if (!body.category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      return withPublishRequestId(action, r, null, body, async () => {
        const payload = buildGlobalItemPayload(body);
        const result = await merchantApiCall(r, '/api/v2/global_product/add_global_item', { method: 'POST', body: payload });
        if (result.error) return jsonResp({ ok: false, region: r, error: result.error, message: result.message, sent: payload, raw: result }, 502);
        return jsonResp({ ok: true, region: r, global_item_id: result.response?.global_item_id, sent: payload, raw: result });
      });
    }
    if (action === 'init_tier_variation' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const global_item_id = Number(body.global_item_id);
      const variation = normalizeVariation(body.variation);
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      if (!variation) return jsonResp({ ok: false, error: 'variation required' }, 400);
      const models = buildGlobalModels(variation, Number(body.global_price ?? body.price), Number(body.stock || 0));
      if (!models.length) return jsonResp({ ok: false, error: 'global_model required' }, 400);
      return withPublishRequestId(action, r, null, body, async () => {
        const result = await merchantApiCall(r, '/api/v2/global_product/init_tier_variation', {
          method: 'POST',
          body: { global_item_id, tier_variation: variation.tier_variation, global_model: [models[0]] },
        });
        if (result.error) return jsonResp({ ok: false, region: r, error: result.error, message: result.message, raw: result }, 502);
        return jsonResp({ ok: true, region: r, global_item_id, sent_model: models[0], raw: result });
      });
    }
    if (action === 'add_global_model' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const global_item_id = Number(body.global_item_id);
      const model_list = Array.isArray(body.model_list) ? body.model_list : buildGlobalModels(body.variation, Number(body.global_price ?? body.price), Number(body.stock || 0));
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      if (!model_list.length) return jsonResp({ ok: false, error: 'model_list required' }, 400);
      return withPublishRequestId(action, r, null, body, async () => {
        const addModelPayload = buildAddGlobalModelPayload(global_item_id, model_list, body, body);
        const result = await merchantApiCall(r, '/api/v2/global_product/add_global_model', {
          method: 'POST',
          body: addModelPayload,
        });
        if (result.error) return jsonResp({ ok: false, region: r, error: result.error, message: result.message, sent: addModelPayload, raw: result }, 502);
        return jsonResp({ ok: true, region: r, global_item_id, sent: addModelPayload, sent_model_list: addModelPayload.global_model, raw: result });
      });
    }
    // POST /create_publish_task: publish one global item to one shop/region.
    if (action === 'create_publish_task' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const global_item_id = Number(body.global_item_id);
      const shop_id = Number(body.shop_id || await getRegionShopId(r));
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      if (!shop_id) return jsonResp({ ok: false, error: 'shop_id required' }, 400);
      return withPublishRequestId(action, r, shop_id, body, async () => {
        const logistics = await getPublishLogistics(r);
        const item = body.item || buildPublishItemPayload(body, body, logistics);
        if (!item.logistic) item.logistic = logistics;
        const sent = { global_item_id, shop_id, shop_region: r, item };
        const result = await merchantApiCall(r, '/api/v2/global_product/create_publish_task', { method: 'POST', body: sent });
        if (result.error) return jsonResp({ ok: false, region: r, error: result.error, message: result.message, sent, raw: result }, 502);
        return jsonResp({ ok: true, region: r, publish_task_id: result.response?.publish_task_id, sent, raw: result });
      });
    }
    if (action === 'publish_task_result') {
      const publish_task_id = url.searchParams.get('publish_task_id') || '';
      if (!publish_task_id) return jsonResp({ ok: false, error: 'publish_task_id required' }, 400);
      const result = await merchantApiCall(region, '/api/v2/global_product/get_publish_task_result', { query: { publish_task_id } });
      return jsonResp({ ok: !result.error, region, result });
    }
    if (action === 'publishable_shop') {
      const global_item_id = url.searchParams.get('global_item_id') || '';
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      const result = await merchantApiCall(region, '/api/v2/global_product/get_publishable_shop', { query: { global_item_id } });
      return jsonResp({ ok: !result.error, region, global_item_id, result });
    }
    if (action === 'shop_publishable_status') {
      const global_item_id = url.searchParams.get('global_item_id') || '';
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      const offset = url.searchParams.get('offset') || '0';
      const page_size = url.searchParams.get('page_size') || '50';
      const result = await merchantApiCall(region, '/api/v2/global_product/get_shop_publishable_status', { query: { global_item_id, offset, page_size } });
      return jsonResp({ ok: !result.error, region, global_item_id, result });
    }
    if (action === 'publish_to_region' && req.method === 'POST') {
      const body = await req.json();
      const global_item_id = Number(body.global_item_id);
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      const targetInputs = (Array.isArray(body.targets) && body.targets.length ? body.targets : [body])
        .map((t: any) => ({ ...t, region: String(t.region || '').toUpperCase() }))
        .filter((t: any) => t.region);
      if (!targetInputs.length) return jsonResp({ ok: false, error: 'targets required' }, 400);
      if (!body.name) return jsonResp({ ok: false, error: 'name required (publish item payload)' }, 400);
      if (!body.category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      const _isPreOrderRepublish = body.is_pre_order === true || body.lifecycle_state === 'pre_order';
      const results: any[] = [];
      for (const target of targetInputs) {
        const targetRegion = String(target.region || '').toUpperCase();
        try {
          const shop_id = target.shop_id ? Number(target.shop_id) : await getRegionShopId(targetRegion);
          const BRIDGE_BANNED_SHOP_IDS = new Set([1002269093]);
          if (BRIDGE_BANNED_SHOP_IDS.has(shop_id)) {
            results.push({ ok: false, region: targetRegion, shop_id, stage: 'banned_shop', error: 'shop_id is permanently banned' });
            continue;
          }
          const logistics = await getPublishLogistics(targetRegion, _isPreOrderRepublish);
          const item = buildPublishItemPayload({ ...body, image_id: target.image_id || body.image_id, image_url: target.image_url || body.image_url, image_id_list: target.image_id_list || body.image_id_list, image_url_list: target.image_url_list || body.image_url_list }, target, logistics);
          const publishBody = { global_item_id, shop_id, shop_region: targetRegion, item };
          const publishRes = await merchantApiCall(targetRegion, '/api/v2/global_product/create_publish_task', { method: 'POST', body: publishBody });
          if (publishRes.error) {
            results.push({ ok: false, region: targetRegion, shop_id, stage: 'create_publish_task', error: publishRes.error, message: publishRes.message, raw: publishRes });
            continue;
          }
          const publish_task_id = Number(publishRes.response?.publish_task_id);
          let task: any = null;
          let pollAttempts = 0;
          // BR publish async is slower — double the polling window for BR only
          const maxPoll = (targetRegion === 'BR') ? 60 : 30;
          for (let i = 0; i < maxPoll; i++) {
            await new Promise(s => setTimeout(s, 2000));
            const taskRes = await merchantApiCall(targetRegion, '/api/v2/global_product/get_publish_task_result', { query: { publish_task_id } });
            task = taskRes;
            pollAttempts = i + 1;
            if (taskRes.error || !isPublishPending(taskRes)) break;
          }
          let outcome = parsePublishOutcome(targetRegion, shop_id, publish_task_id, task);
          // Fallback verification: query published_list — BR gets 3 retries (5s apart), others get 1
          if (!outcome.ok) {
            const fbRetries = (targetRegion === 'BR') ? 3 : 1;
            const fbSleep = (targetRegion === 'BR') ? 5000 : 0;
            for (let r = 0; r < fbRetries; r++) {
              if (r > 0) await new Promise(s => setTimeout(s, fbSleep));
              try {
                const publishedRes = await merchantApiCall(targetRegion, '/api/v2/global_product/get_published_list', { query: { global_item_id } });
                const pubItems = Array.isArray(publishedRes?.response?.published_item) ? publishedRes.response.published_item : [];
                const hit = pubItems.find((p: any) => Number(p.shop_id) === Number(shop_id));
                if (hit && hit.item_id) {
                  outcome = { ok: true, region: targetRegion, shop_id, publish_task_id, item_id: Number(hit.item_id), publish_status: 'verified_via_published_list_retry_' + r, error: null, task };
                  break;
                }
              } catch (_) {}
            }
          }
          // BR-only: if still failing after fallback, re-issue create_publish_task once more
          if (!outcome.ok && targetRegion === 'BR') {
            try {
              const retryPublishRes = await merchantApiCall(targetRegion, '/api/v2/global_product/create_publish_task', { method: 'POST', body: publishBody });
              if (retryPublishRes.response?.publish_task_id) {
                const retryTaskId = Number(retryPublishRes.response.publish_task_id);
                // Give BR 15s for async resolution before final published_list check
                await new Promise(s => setTimeout(s, 15000));
                const finalPubRes = await merchantApiCall(targetRegion, '/api/v2/global_product/get_published_list', { query: { global_item_id } });
                const finalItems = Array.isArray(finalPubRes?.response?.published_item) ? finalPubRes.response.published_item : [];
                const finalHit = finalItems.find((p: any) => Number(p.shop_id) === Number(shop_id));
                if (finalHit && finalHit.item_id) {
                  outcome = { ok: true, region: 'BR', shop_id, publish_task_id: retryTaskId, item_id: Number(finalHit.item_id), publish_status: 'verified_via_br_retry', error: null, task: retryPublishRes };
                }
              }
            } catch (_) {}
          }
          outcome.raw_create = publishRes;
          outcome.raw_task = task;
          outcome.poll_attempts = pollAttempts;
          results.push(outcome);
        } catch (e: any) {
          results.push({ ok: false, region: targetRegion, stage: 'publish_exception', error: String(e?.message || e) });
        }
      }
      return jsonResp({ ok: true, global_item_id, results });
    }
    if (action === 'oauth_exchange') {
      const code = url.searchParams.get('code') || '';
      const main_account_id = url.searchParams.get('main_account_id') || '';
      const shop_id = url.searchParams.get('shop_id') || '';
      if (!code) return jsonResp({ ok: false, error: 'code required' }, 400);
      if (!main_account_id && !shop_id) return jsonResp({ ok: false, error: 'main_account_id or shop_id required' }, 400);
      const app = await getApp();
      const path = '/api/v2/auth/token/get';
      const ts = Math.floor(Date.now() / 1000);
      const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}`);
      const body: any = { code, partner_id: Number(app.partner_id) };
      if (main_account_id) body.main_account_id = Number(main_account_id);
      if (shop_id) body.shop_id = Number(shop_id);
      const r = await fetch(`https://${LIVE_HOST}${path}?partner_id=${app.partner_id}&timestamp=${ts}&sign=${sign}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.error || !j.access_token) return jsonResp({ ok: false, error: j.error || 'no_access_token', message: j.message || null, raw: j }, 502);
      // Persist merchant row (KRSC merchant token)
      const now = Math.floor(Date.now() / 1000);
      const expires_at = now + Number(j.expire_in || 14400);
      const merchant_id_list: number[] = Array.isArray(j.merchant_id_list) ? j.merchant_id_list.map((x: any) => Number(x)) : [];
      const merchant_id = merchant_id_list[0] || null;
      const updates: any[] = [];
      if (main_account_id && merchant_id) {
        const { error } = await supabase.from('shopee_tokens').upsert({
          region: '_MERCHANT', shop_id: Number(main_account_id), merchant_id, access_token: j.access_token, refresh_token: j.refresh_token, expires_at,
        }, { onConflict: 'region' });
        updates.push({ kind: 'merchant', region: '_MERCHANT', shop_id: main_account_id, error: error?.message || null });
      }
      const shop_id_list: number[] = Array.isArray(j.shop_id_list) ? j.shop_id_list.map((x: any) => Number(x)) : [];
      return jsonResp({ ok: true, access_token_set: !!j.access_token, expires_at, merchant_id, merchant_id_list, shop_id_list, updates, raw: j });
    }
    if (action === 'merchant_shops') {
      const r = url.searchParams.get('region') || 'SG';
      const result = await merchantApiCall(r, '/api/v2/merchant/get_shop_list_by_merchant', { query: { page_no: 1, page_size: 100 } });
      return jsonResp({ ok: !result.error, region: r, result });
    }
    if (action === 'oauth_url') {
      const app = await getApp();
      const path = url.searchParams.get('shop') === '1'
        ? '/api/v2/shop/auth_partner'
        : '/api/v2/merchant/auth_partner';
      const ts = Math.floor(Date.now() / 1000);
      const base = `${app.partner_id}${path}${ts}`;
      const sign = await hmac(app.partner_key, base);
      const redirect = url.searchParams.get('redirect') || 'https://shopee-dashboard-kohl.vercel.app/v2/';
      const oauthUrl = `https://${LIVE_HOST}${path}?partner_id=${app.partner_id}&timestamp=${ts}&sign=${sign}&redirect=${encodeURIComponent(redirect)}`;
      return jsonResp({ ok: true, oauth_url: oauthUrl, partner_id: app.partner_id, timestamp: ts, path });
    }
    if (action === 'force_refresh_all') {
      const regions = (url.searchParams.get('regions') || 'SG,TW,TH,MY,PH,BR').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      const results: any[] = [];
      let merchant: any = null;
      try {
        merchant = await refreshMerchantRowToken();
      } catch (e) {
        merchant = { error: String((e as any)?.message || e) };
      }
      for (const r of regions) {
        try {
          const refreshed = await forceRefreshShopToken(r);
          results.push({ region: r, ok: true, shop_id: refreshed.shop_id, expires_at: refreshed.expires_at });
        } catch (e) {
          results.push({ region: r, ok: false, error: String((e as any)?.message || e) });
        }
      }
      return jsonResp({ ok: true, merchant, shops: results });
    }
    // POST /register_cbsc: high-level GlobalProduct registration and region publish orchestration.
    // v44: accepts body.idempotency_token (UUID) forwarded from UI card — used as request_id
    //      for the withPublishRequestId gate so duplicate browser submits are blocked.
    //      body.variation.model[] now supports per-model weight_g and image_id fields (§6-1, §2-2).
    if (action === 'register_cbsc' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      // Use UI-supplied idempotency_token as the publish request id when provided (§6-2).
      const _cbscIdempotencyToken = body.idempotency_token ? String(body.idempotency_token) : null;
      const targetInputs = (Array.isArray(body.targets) && body.targets.length ? body.targets : [body])
        .map((t: any) => ({ ...t, region: t.region || r }))
        .filter((t: any) => t.region);
      if (!body.name) return jsonResp({ ok: false, error: 'name required' }, 400);
      if (!body.sku) return jsonResp({ ok: false, error: 'sku required' }, 400);
      if (!body.category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      if (!targetInputs.length) return jsonResp({ ok: false, error: 'targets required' }, 400);

      return withPublishRequestId(action, r, _cbscIdempotencyToken, body, async () => {
      const stage_logs: string[] = [];
      const catAttrs = await buildCategoryAttributeList(r, Number(body.category_id), Array.isArray(body.attribute_list) ? body.attribute_list : []);
      if (catAttrs.missing.length > 0) {
        return jsonResp({
          ok: false,
          region: r,
          stage: 'add_global_item',
          error: 'mandatory_attribute_missing',
          message: 'Required category attributes are missing. Provide values in attribute_list.',
          missing_attributes: catAttrs.missing,
        }, 400);
      }

      // Operator msg #679: Global add_global_item DTS caps at 10. For Pre-Order
      // products we force 10 at Global level; per-region DTS is then applied
      // separately in each create_publish_task call (which can go up to 150).
      // Ready Stock keeps the existing 1-10 clamp on the first target's DTS.
      const _isPreOrderRegister = body.is_pre_order === true || body.lifecycle_state === 'pre_order';
      const _globalDts = _isPreOrderRegister
        ? PRE_ORDER_GLOBAL_DTS
        : clampReadyStockDts(targetInputs[0]?.days_to_ship ?? body.days_to_ship);
      const addPayload = buildGlobalItemPayload({
        ...body,
        attribute_list: catAttrs.attribute_list,
        price: Number(body.global_price ?? body.price ?? targetInputs[0]?.price),
        stock: Number(body.stock ?? targetInputs[0]?.stock ?? 0),
        weight_g: Number(body.weight_g ?? targetInputs[0]?.weight_g ?? 100),
        days_to_ship: _globalDts,
        is_pre_order: _isPreOrderRegister,
      });
      const addRes = await merchantApiCall(r, '/api/v2/global_product/add_global_item', { method: 'POST', body: addPayload });
      if (addRes.error) {
        const dbg = String(addRes?.debug_message || '');
        if (/Attribute is mandatory/i.test(dbg) || /CD,\s*DVD\s*&\s*Bluray\s*Type/i.test(`${addRes?.message || ''} ${dbg}`)) {
          const parsed = parseMandatoryFromDebug(`${addRes?.message || ''} ${dbg}`);
          const miss = (parsed.length ? parsed : catAttrs.missing).map((a: any) => ({
            attribute_id: a.attribute_id ?? null,
            attribute_name: a.attribute_name || a.name || 'unknown',
            options: a.options || [],
          }));
          // Retry once with name-based fallback defaults when id is known.
          let retried = null as any;
          const fallbackAttrs = [...(catAttrs.attribute_list || [])];
          const existingIds = new Set<number>(fallbackAttrs.map((x: any) => Number(x.attribute_id)));
          parsed.forEach((p) => {
            if (!p.attribute_id || existingIds.has(Number(p.attribute_id))) return;
            const v = fallbackAttrValueByName(p.attribute_name);
            if (!v) return;
            fallbackAttrs.push({ attribute_id: Number(p.attribute_id), attribute_value_list: [{ original_value_name: v }] });
          });
          if (fallbackAttrs.length !== (catAttrs.attribute_list || []).length) {
            const retryPayload = { ...addPayload, attribute_list: fallbackAttrs };
            retried = await merchantApiCall(r, '/api/v2/global_product/add_global_item', { method: 'POST', body: retryPayload });
            if (!retried.error && retried.response?.global_item_id) {
              stage_logs.push('add_global_item retry ok (fallback mandatory attrs)');
              const global_item_id = retried.response.global_item_id;
              // continue flow by replacing addRes-like result
              addRes.error = '';
              addRes.response = { ...(addRes.response || {}), global_item_id };
            }
          }
          if (addRes.error) {
          return jsonResp({
            ok: false,
            region: r,
            stage: 'add_global_item',
            error: addRes.error,
            message: addRes.message,
            missing_attributes: miss,
            sent: addPayload,
            retry_attempted: !!retried,
            retry_raw: retried,
            raw: addRes,
          }, 502);
          }
        }
        if (addRes.error) return jsonResp({ ok: false, region: r, stage: 'add_global_item', error: addRes.error, message: addRes.message, sent: addPayload, raw: addRes }, 502);
      }
      const global_item_id = addRes.response?.global_item_id;
      if (!global_item_id) return jsonResp({ ok: false, region: r, stage: 'add_global_item', error: 'no global_item_id', raw: addRes }, 502);
      stage_logs.push(`add_global_item ok: global_item_id=${global_item_id}`);

      // §6-1 failure state machine: variation setup with explicit stage tracking.
      // init_tier_variation failure → auto delete_global_item (cleanup orphan).
      // add_global_model partial failure → no auto cleanup (dangerous), return partial_published.
      const baseVariation = normalizeVariation(body.variation || targetInputs.find((t: any) => t.variation)?.variation);
      if (baseVariation) {
        const globalModels = buildGlobalModels(baseVariation, Number(body.global_price ?? body.price ?? targetInputs[0]?.price), Number(body.stock ?? 0));
        const initRes = await merchantApiCall(r, '/api/v2/global_product/init_tier_variation', {
          method: 'POST',
          body: { global_item_id, tier_variation: baseVariation.tier_variation, global_model: [globalModels[0]] },
        });
        if (initRes.error) {
          // §6-1: init_tier_variation failed → orphan global_item exists. Auto-cleanup.
          stage_logs.push(`init_tier_variation FAILED: ${initRes.error} — attempting delete_global_item cleanup`);
          let cleanupState = 'cleanup_required';
          try {
            const delRes = await merchantApiCall(r, '/api/v2/global_product/delete_global_item', {
              method: 'POST',
              body: { global_item_id },
            });
            if (!delRes.error) {
              cleanupState = 'cleanup_done';
              stage_logs.push(`delete_global_item cleanup ok: global_item_id=${global_item_id}`);
            } else {
              stage_logs.push(`delete_global_item cleanup FAILED: ${delRes.error}`);
            }
          } catch (cleanupErr: any) {
            stage_logs.push(`delete_global_item cleanup exception: ${String(cleanupErr?.message || cleanupErr)}`);
          }
          return jsonResp({
            ok: false,
            region: r,
            stage: 'init_tier_variation',
            cleanup_state: cleanupState,
            global_item_id: cleanupState === 'cleanup_done' ? null : global_item_id,
            error: initRes.error,
            message: initRes.message,
            stage_logs,
            raw: initRes,
          }, 502);
        }
        stage_logs.push(`init_tier_variation ok: 1/${globalModels.length} models`);
        if (globalModels.length > 1) {
          const addModelPayload = buildAddGlobalModelPayload(global_item_id, globalModels.slice(1), body, targetInputs[0] || {});
          const addModelRes = await merchantApiCall(r, '/api/v2/global_product/add_global_model', {
            method: 'POST',
            body: addModelPayload,
          });
          if (addModelRes.error) {
            // §6-1: add_global_model failure — partial state. No auto cleanup (dangerous).
            // Return partial_published so UI can surface the correct DB state.
            // P1 #1: include per-model identifiers so UI/operator knows which options to retry.
            stage_logs.push(`add_global_model FAILED: ${addModelRes.error} — partial model state, no auto-cleanup`);
            const failedModels = globalModels.slice(1).map((m: any, idx: number) => ({
              tier_index: m.tier_index,
              global_model_sku: m.model_sku ?? m.global_model_sku ?? null,
              error: addModelRes.error,
            }));
            const succeededModels = [{
              tier_index: globalModels[0].tier_index,
              global_model_sku: globalModels[0].model_sku ?? globalModels[0].global_model_sku ?? null,
              // global_model_id is not returned by init_tier_variation; must be fetched separately if needed
              global_model_id: null,
            }];
            return jsonResp({
              ok: false,
              region: r,
              stage: 'add_global_model',
              cleanup_state: 'partial_published',
              global_item_id,
              models_added: 1,
              models_failed: globalModels.length - 1,
              succeeded_models: succeededModels,
              failed_models: failedModels,
              error: addModelRes.error,
              message: addModelRes.message,
              stage_logs,
              raw: addModelRes,
            }, 502);
          }
          stage_logs.push(`add_global_model ok: ${globalModels.length - 1} models`);
        }
      }

      // Diagnostic: query KRSC publishable_shop for this global_item_id once. Result is
      // recorded in stage_logs + returned so adapter/UI can show which region shops
      // Shopee considers eligible (KRSC blocks publish to non-publishable shops).
      let publishable_shops: any = null;
      try {
        const psRes = await merchantApiCall(r, '/api/v2/global_product/get_publishable_shop', { query: { global_item_id } });
        publishable_shops = psRes;
        console.log(`[register_cbsc] get_publishable_shop global_item_id=${global_item_id} response=${JSON.stringify(psRes).slice(0, 1200)}`);
        const shopList = Array.isArray(psRes?.response?.publishable_shop) ? psRes.response.publishable_shop : [];
        stage_logs.push(`publishable_shops: ${shopList.length} shops eligible (${shopList.map((s: any) => `${s.shop_region || s.region || '?'}:${s.shop_id}`).join(', ')})`);
      } catch (e) {
        stage_logs.push(`publishable_shops_lookup_failed: ${String(e)}`);
      }

      // Codex hypothesis C — pre-check per-shop publishable status (with reason)
      // so we can surface KRSC's "category prohibited" / "channel/region not
      // supported" reasons up-front instead of getting a generic publish_task
      // failure that misattributes the cause.
      let publishable_status: any = null;
      const unpublishableByShop = new Map<number, string>();
      try {
        const stRes = await merchantApiCall(r, '/api/v2/global_product/get_shop_publishable_status', { query: { global_item_id, offset: 0, page_size: 100 } });
        publishable_status = stRes;
        const list = Array.isArray(stRes?.response?.shop_publishable_status_list) ? stRes.response.shop_publishable_status_list : [];
        for (const row of list) {
          if (row?.shop_publishable_status === false && row?.unpublishable_reason) {
            unpublishableByShop.set(Number(row.shop_id), String(row.unpublishable_reason));
          }
        }
        stage_logs.push(`shop_publishable_status: ${list.length} shops checked, ${unpublishableByShop.size} unpublishable`);
      } catch (e) {
        stage_logs.push(`shop_publishable_status_failed: ${String(e)}`);
      }

      const results: any[] = [];
      for (const target of targetInputs) {
        const targetRegion = String(target.region || '').toUpperCase();
        try {
          // Prefer caller-provided shop_id; only fall back to region default when omitted.
          // Ignoring the caller's shop_id (old behaviour) would publish to the wrong shop
          // when an explicit non-default shop is passed (e.g. a second shop in the same region).
          const shop_id = target.shop_id ? Number(target.shop_id) : await getRegionShopId(targetRegion);
          // Defense-in-depth: block permanently-banned shop IDs even inside the bridge.
          const BRIDGE_BANNED_SHOP_IDS = new Set([1002269093]);
          if (BRIDGE_BANNED_SHOP_IDS.has(shop_id)) {
            results.push({ ok: false, region: targetRegion, shop_id, stage: 'banned_shop', error: 'shop_id is permanently banned', message: `shop_id ${shop_id} is banned and cannot be published to` });
            continue;
          }
          // Pre-check: if KRSC reported this shop as unpublishable, surface the
          // reason verbatim instead of letting create_publish_task return a
          // generic failure with a misleading message.
          const blockedReason = unpublishableByShop.get(shop_id);
          if (blockedReason) {
            results.push({ ok: false, region: targetRegion, shop_id, stage: 'shop_unpublishable', error: 'shop_unpublishable', message: blockedReason });
            continue;
          }
          const logistics = await getPublishLogistics(targetRegion, _isPreOrderRegister);
          const item = buildPublishItemPayload({ ...body, image_id: target.image_id || body.image_id, image_url: target.image_url || body.image_url, image_id_list: target.image_id_list || body.image_id_list, image_url_list: target.image_url_list || body.image_url_list }, target, logistics);
          const publishBody = { global_item_id, shop_id, shop_region: targetRegion, item };
          const publishRes = await merchantApiCall(targetRegion, '/api/v2/global_product/create_publish_task', { method: 'POST', body: publishBody });
          if (publishRes.error) {
            results.push({ ok: false, region: targetRegion, shop_id, stage: 'create_publish_task', error: publishRes.error, message: publishRes.message, raw: publishRes });
            continue;
          }
          const publish_task_id = Number(publishRes.response?.publish_task_id);
          console.log(`[register_cbsc] region=${targetRegion} shop_id=${shop_id} publish_task_id=${publish_task_id} create_publish_task_response=${JSON.stringify(publishRes).slice(0, 800)}`);
          let task: any = null;
          let pollAttempts = 0;
          // BR publish async is slower — double the polling window for BR only
          const maxPoll = (targetRegion === 'BR') ? 60 : 30;
          for (let i = 0; i < maxPoll; i++) {
            await new Promise(s => setTimeout(s, 2000));
            const taskRes = await merchantApiCall(targetRegion, '/api/v2/global_product/get_publish_task_result', { query: { publish_task_id } });
            task = taskRes;
            pollAttempts = i + 1;
            if (taskRes.error || !isPublishPending(taskRes)) break;
          }
          console.log(`[register_cbsc] region=${targetRegion} publish_task_id=${publish_task_id} poll_attempts=${pollAttempts} final_task=${JSON.stringify(task).slice(0, 1200)}`);
          let outcome = parsePublishOutcome(targetRegion, shop_id, publish_task_id, task);
          outcome.raw_create = publishRes;
          outcome.raw_task = task;
          outcome.poll_attempts = pollAttempts;
          // Fallback verification: if parser declared failure but the task may still be
          // resolving async on Shopee's side, query published_list and check whether the
          // global_item_id has actually surfaced as a shop item.
          // BR gets 3 retries (5s apart), other regions get 1 attempt.
          if (!outcome.ok) {
            const fbRetries = (targetRegion === 'BR') ? 3 : 1;
            const fbSleep = (targetRegion === 'BR') ? 5000 : 0;
            for (let r = 0; r < fbRetries; r++) {
              if (r > 0) await new Promise(s => setTimeout(s, fbSleep));
              try {
                const publishedRes = await merchantApiCall(targetRegion, '/api/v2/global_product/get_published_list', { query: { global_item_id } });
                const pubItems = Array.isArray(publishedRes?.response?.published_item) ? publishedRes.response.published_item : [];
                const hit = pubItems.find((p: any) => Number(p.shop_id) === Number(shop_id));
                if (hit && hit.item_id) {
                  outcome = {
                    ok: true,
                    region: targetRegion,
                    shop_id,
                    publish_task_id,
                    item_id: Number(hit.item_id),
                    publish_status: 'verified_via_published_list_retry_' + r,
                    error: null,
                    task,
                  };
                  break;
                }
              } catch (_) { /* ignore — keep original parsePublishOutcome verdict */ }
            }
          }
          // BR-only: if still failing after fallback retries, re-issue create_publish_task once more
          if (!outcome.ok && targetRegion === 'BR') {
            try {
              stage_logs.push('BR retry: re-creating publish_task');
              const retryPublishRes = await merchantApiCall(targetRegion, '/api/v2/global_product/create_publish_task', { method: 'POST', body: publishBody });
              if (retryPublishRes.response?.publish_task_id) {
                const retryTaskId = Number(retryPublishRes.response.publish_task_id);
                // Give BR 15s for async resolution before final published_list check
                await new Promise(s => setTimeout(s, 15000));
                const finalPubRes = await merchantApiCall(targetRegion, '/api/v2/global_product/get_published_list', { query: { global_item_id } });
                const finalItems = Array.isArray(finalPubRes?.response?.published_item) ? finalPubRes.response.published_item : [];
                const finalHit = finalItems.find((p: any) => Number(p.shop_id) === Number(shop_id));
                if (finalHit && finalHit.item_id) {
                  outcome = { ok: true, region: 'BR', shop_id, publish_task_id: retryTaskId, item_id: Number(finalHit.item_id), publish_status: 'verified_via_br_retry', error: null, task: retryPublishRes };
                }
              }
            } catch (_) {}
          }
          results.push(outcome);
        } catch (e: any) {
          results.push({ ok: false, region: target.region || r, stage: 'publish_exception', error: String(e?.message || e) });
        }
      }
      return jsonResp({ ok: true, region: r, global_item_id, stage_logs, results, publishable_shops, publishable_status });
      }); // end withPublishRequestId for register_cbsc
    }
    if (action === 'item_info') {
      const item_id = parseInt(url.searchParams.get('item_id') || '0');
      if (!item_id) return jsonResp({ ok: false, error: 'item_id required' }, 400);
      const result = await shopApiCall(region, '/api/v2/product/get_item_base_info', { query: { item_id_list: item_id } });
      return jsonResp({ ok: !result.error, region, item_id, result });
    }
    if (action === 'shop_item_dts_limit') {
      const r = String(url.searchParams.get('region') || region || '').toUpperCase();
      const item_id = parseInt(url.searchParams.get('item_id') || '0');
      let category_id = parseInt(url.searchParams.get('category_id') || '0');
      if (!r) return jsonResp({ ok: false, error: 'region required' }, 400);
      if (!item_id && !category_id) return jsonResp({ ok: false, error: 'item_id or category_id required' }, 400);
      let itemInfo: any = null;
      let itemInfoResult: any = null;
      if (!category_id && item_id) {
        itemInfoResult = await shopApiCall(r, '/api/v2/product/get_item_base_info', { query: { item_id_list: item_id } });
        if (itemInfoResult.error) {
          return jsonResp({ ok: false, region: r, item_id, error: itemInfoResult.error, result: itemInfoResult }, 500);
        }
        const itemList = itemInfoResult.response?.item_list || [];
        itemInfo = Array.isArray(itemList) ? itemList[0] || null : null;
        category_id = Number(itemInfo?.category_id || 0);
        if (!category_id) {
          return jsonResp({ ok: false, region: r, item_id, error: 'category_id not found for item', result: itemInfoResult }, 404);
        }
      }
      const result = await shopApiCall(r, '/api/v2/product/get_item_limit', { query: { category_id } });
      if (result.error) {
        return jsonResp({ ok: false, region: r, category_id, item_id: item_id || null, error: result.error, result }, 500);
      }
      const dts_limit = result.response?.dts_limit || result.dts_limit || null;
      const range = dts_limit?.days_to_ship_limit || null;
      const min_limit = Number(range?.min_limit);
      const max_limit = Number(range?.max_limit);
      const non_pre_order_days_to_ship = Number(dts_limit?.non_pre_order_days_to_ship);
      const support_pre_order = dts_limit?.support_pre_order !== false;
      return jsonResp({
        ok: true,
        region: r,
        item_id: item_id || null,
        category_id,
        category_source: itemInfo ? 'item_info' : 'query',
        dts_limit,
        min_limit: Number.isFinite(min_limit) ? min_limit : null,
        max_limit: Number.isFinite(max_limit) ? max_limit : null,
        non_pre_order_days_to_ship: Number.isFinite(non_pre_order_days_to_ship) ? non_pre_order_days_to_ship : null,
        support_pre_order,
        note: 'Shop-level DTS limit from product/get_item_limit.',
        result,
      });
    }
    if (action === 'list_items') {
      const item_status = url.searchParams.get('item_status') || 'NORMAL';
      const max_items = parseInt(url.searchParams.get('max_items') || '5000');
      const r = await listItemsForRegion(region, item_status, max_items);
      if ((r as any).error) return jsonResp({ ok: false, region, ...r }, 502);
      return jsonResp({ ok: true, region, count: (r as any).count, items: (r as any).items });
    }
    if (action === 'update_price' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const item_id = parseInt(body.item_id);
      const price_list = body.price_list || [];
      if (!item_id) return jsonResp({ ok: false, error: 'item_id required' }, 400);
      if (!Array.isArray(price_list) || !price_list.length) return jsonResp({ ok: false, error: 'price_list required' }, 400);
      const result = await shopApiCall(r, '/api/v2/product/update_price', { method: 'POST', body: { item_id, price_list } });
      const failureList = Array.isArray(result?.response?.failure_list) ? result.response.failure_list : [];
      return jsonResp({ ok: !result.error && failureList.length === 0, region: r, item_id, sent_price_list: price_list, failure_list: failureList, result });
    }
    if (action === 'update_item_sku' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const item_id = parseInt(body.item_id);
      const item_sku = typeof body.item_sku === 'string' ? body.item_sku.trim() : '';
      if (!item_id) return jsonResp({ ok: false, error: 'item_id required' }, 400);
      if (!item_sku) return jsonResp({ ok: false, error: 'item_sku required' }, 400);
      const result = await shopApiCall(r, '/api/v2/product/update_item', { method: 'POST', body: { item_id, item_sku } });
      return jsonResp({ ok: !result.error, region: r, item_id, item_sku, result });
    }
    if (action === 'update_model_sku' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const item_id = parseInt(body.item_id);
      const model = Array.isArray(body.model) ? body.model : [];
      const cleaned = model
        .map((m: any) => ({
          model_id: parseInt(m?.model_id),
          model_sku: typeof m?.model_sku === 'string' ? m.model_sku.trim() : '',
        }))
        .filter((m: any) => Number.isFinite(m.model_id) && m.model_id > 0 && m.model_sku !== '');
      if (!item_id) return jsonResp({ ok: false, error: 'item_id required' }, 400);
      if (cleaned.length === 0) return jsonResp({ ok: false, error: 'model[] required (model_id + model_sku)' }, 400);
      const result = await shopApiCall(r, '/api/v2/product/update_model', { method: 'POST', body: { item_id, model: cleaned } });
      return jsonResp({ ok: !result.error, region: r, item_id, sent_model: cleaned, result });
    }
    if (action === 'published_list') {
      const global_item_id = parseInt(url.searchParams.get('global_item_id') || '0');
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      // No shop_id_list per plan R2 — Shopee returns publishable shops automatically (max 300, we have 6)
      const result = await merchantApiCall(region, '/api/v2/global_product/get_published_list', { query: { global_item_id } });
      return jsonResp({ ok: !result.error, region, global_item_id, result });
    }
    if (action === 'shop_model_list') {
      const item_id = parseInt(url.searchParams.get('item_id') || '0');
      if (!item_id) return jsonResp({ ok: false, error: 'item_id required' }, 400);
      const result = await shopApiCall(region, '/api/v2/product/get_model_list', { query: { item_id } });
      return jsonResp({ ok: !result.error, region, item_id, result });
    }
    if (action === 'update_global_dts' && req.method === 'POST') {
      // Plan: plans/shopee-dts-bulk-update-plan.md. Single API call applies DTS to all
      // published shops (KRSC seller — global_product API only).
      const body = await req.json();
      const global_item_id = parseInt(body.global_item_id);
      const days_to_ship = parseInt(body.days_to_ship);
      const is_pre_order = !!body.is_pre_order;
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      if (!Number.isFinite(days_to_ship) || days_to_ship < 1 || days_to_ship > 30) {
        return jsonResp({ ok: false, error: 'days_to_ship must be int 1-30' }, 400);
      }
      const result = await merchantApiCall(region, '/api/v2/global_product/update_global_item', {
        method: 'POST',
        body: { global_item_id, pre_order: { is_pre_order, days_to_ship } },
      });
      return jsonResp({ ok: !result.error, region, global_item_id, days_to_ship, is_pre_order, result });
    }
    if (action === 'update_shop_item_dts' && req.method === 'POST') {
      // Shop-level DTS update — tries shopApiCall (KRSC may block; we'll see the error).
      // Body: { region, item_id, days_to_ship, is_pre_order }
      const body = await req.json();
      const r = String(body.region || region || '').toUpperCase();
      const item_id = parseInt(body.item_id);
      const days_to_ship = parseInt(body.days_to_ship);
      const is_pre_order = !!body.is_pre_order;
      if (!r) return jsonResp({ ok: false, error: 'region required' }, 400);
      if (!item_id) return jsonResp({ ok: false, error: 'item_id required' }, 400);
      if (!Number.isFinite(days_to_ship) || days_to_ship < 1 || days_to_ship > 150) {
        return jsonResp({ ok: false, error: 'days_to_ship must be int 1-150' }, 400);
      }
      const result = await shopApiCall(r, '/api/v2/product/update_item', {
        method: 'POST',
        body: { item_id, pre_order: { is_pre_order, days_to_ship } },
      });
      return jsonResp({ ok: !result.error, region: r, item_id, days_to_ship, is_pre_order, result });
    }
    if (action === 'set_dts_sync' && req.method === 'POST') {
      // Enable days_to_ship sync from global → shop for a list of shops. Required when
      // shop_sync_list[].days_to_ship is false (default in some setups), otherwise
      // update_global_item.pre_order.days_to_ship does NOT propagate to shop listings.
      // Body: { shops: [{shop_id, shop_region}, ...] }
      const body = await req.json();
      const shops = Array.isArray(body.shops) ? body.shops : [];
      if (!shops.length) return jsonResp({ ok: false, error: 'shops[] required' }, 400);
      // Default: turn ON days_to_ship sync, leave other flags as the caller specified (default true).
      const shop_sync_list = shops.map((s: any) => ({
        shop_id: Number(s.shop_id),
        shop_region: String(s.shop_region || '').toUpperCase(),
        name_and_description: s.name_and_description !== false,
        media_information: s.media_information !== false,
        tier_variation_name_and_option: s.tier_variation_name_and_option !== false,
        price: s.price !== false,
        days_to_ship: s.days_to_ship !== false, // default true
      }));
      const result = await merchantApiCall(region, '/api/v2/global_product/set_sync_field', {
        method: 'POST',
        body: { shop_sync_list },
      });
      return jsonResp({ ok: !result.error, region, sent: shop_sync_list, result });
    }
    if (action === 'global_items') {
      const merchantRegion = String(region || '').toUpperCase() === 'GLOBAL' ? 'SG' : region;
      const page_size = parseInt(url.searchParams.get('page_size') || '50');
      const offset = url.searchParams.get('offset') || '';
      const update_time_from = url.searchParams.get('update_time_from');
      const update_time_to = url.searchParams.get('update_time_to');
      const keyword = String(url.searchParams.get('keyword') || url.searchParams.get('item_name') || '').trim();
      const query: Record<string, any> = { page_size };
      if (offset && offset !== '0') query.offset = offset;
      if (keyword) {
        // Shopee's Global Product list has had inconsistent docs around keyword
        // naming; include both aliases so callers can perform keyword search where
        // the live API supports it. The V2 UI also performs client-side filtering
        // as a safe fallback when the upstream ignores these params.
        query.keyword = keyword;
        query.item_name = keyword;
      }
      if (update_time_from) query.update_time_from = update_time_from;
      if (update_time_to) query.update_time_to = update_time_to;
      else if (update_time_from) query.update_time_to = String(Math.floor(Date.now() / 1000));
      const result = await merchantApiCall(merchantRegion, '/api/v2/global_product/get_global_item_list', { query });
      return jsonResp({ ok: !result.error, region, query, keyword: keyword || null, result });
    }
    if (action === 'global_item_info') {
      const merchantRegion = String(region || '').toUpperCase() === 'GLOBAL' ? 'SG' : region;
      const ids = url.searchParams.getAll('global_item_id').map(s => parseInt(s)).filter(n => Number.isFinite(n));
      if (ids.length === 0) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      const result = await merchantApiCall(merchantRegion, '/api/v2/global_product/get_global_item_info', { query: { global_item_id_list: ids.join(',') } });
      return jsonResp({ ok: !result.error, region, global_item_id_list: ids, result });
    }
    if (action === 'global_item_dts_limit') {
      const global_item_id = parseInt(url.searchParams.get('global_item_id') || '0');
      let category_id = parseInt(url.searchParams.get('category_id') || '0');
      if (!global_item_id && !category_id) {
        return jsonResp({ ok: false, error: 'global_item_id or category_id required' }, 400);
      }
      let itemInfo: any = null;
      let itemInfoResult: any = null;
      if (!category_id && global_item_id) {
        itemInfoResult = await merchantApiCall(region, '/api/v2/global_product/get_global_item_info', {
          query: { global_item_id_list: String(global_item_id) },
        });
        if (itemInfoResult.error) {
          return jsonResp({ ok: false, region, global_item_id, error: itemInfoResult.error, result: itemInfoResult }, 500);
        }
        const itemList = itemInfoResult.response?.global_item_list || itemInfoResult.response?.item_list || [];
        itemInfo = Array.isArray(itemList) ? itemList[0] || null : null;
        category_id = Number(itemInfo?.category_id || 0);
        if (!category_id) {
          return jsonResp({ ok: false, region, global_item_id, error: 'category_id not found for global item', result: itemInfoResult }, 404);
        }
      }
      const result = await merchantApiCall(region, '/api/v2/global_product/get_global_item_limit', {
        query: { category_id },
      });
      if (result.error) {
        return jsonResp({ ok: false, region, category_id, global_item_id: global_item_id || null, error: result.error, result }, 500);
      }
      const dts_limit = result.response?.dts_limit || result.dts_limit || null;
      const rangeListRaw = Array.isArray(dts_limit?.days_to_ship_range_list)
        ? dts_limit.days_to_ship_range_list
        : (dts_limit ? [dts_limit] : []);
      const ranges = rangeListRaw
        .map((it: any) => ({
          min_limit: Number(it?.min_limit),
          max_limit: Number(it?.max_limit),
        }))
        .filter((it: any) => Number.isFinite(it.min_limit) && Number.isFinite(it.max_limit) && it.min_limit >= 1 && it.max_limit >= it.min_limit);
      const allMins = ranges.map((it: any) => it.min_limit);
      const allMaxs = ranges.map((it: any) => it.max_limit);
      const min_limit = allMins.length ? Math.min(...allMins) : null;
      const max_limit = allMaxs.length ? Math.max(...allMaxs) : null;
      return jsonResp({
        ok: true,
        region,
        global_item_id: global_item_id || null,
        category_id,
        category_source: itemInfo ? 'global_item_info' : 'query',
        dts_limit,
        ranges,
        min_limit: Number.isFinite(min_limit) ? min_limit : null,
        max_limit: Number.isFinite(max_limit) ? max_limit : null,
        note: 'Shopee KRSC exposes category/global DTS limits. Region-specific DTS range is not provided by this endpoint.',
        result,
      });
    }
    if (action === 'global_model_list') {
      const merchantRegion = String(region || '').toUpperCase() === 'GLOBAL' ? 'SG' : region;
      const global_item_id = parseInt(url.searchParams.get('global_item_id') || '0');
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      const result = await merchantApiCall(merchantRegion, '/api/v2/global_product/get_global_model_list', { query: { global_item_id } });
      return jsonResp({ ok: !result.error, region, global_item_id, result });
    }
    if (action === 'v2_failed_mutations') {
      const run_id = url.searchParams.get('run_id') || '';
      let q = supabase
        .from('shopee_mutation_log')
        .select('id, created_at, run_id, actor, action, region, request_payload, response, error_msg, request_id, duration_ms, rollback_policy')
        .eq('actor', V2_WIZARD_ACTOR)
        .eq('status', 'error')
        .order('created_at', { ascending: false })
        .limit(200);
      if (run_id) q = q.eq('run_id', run_id);
      const { data, error } = await q;
      if (error) return jsonResp({ ok: false, error: error.message }, 500);
      return jsonResp({
        ok: true,
        rollback_policy: V2_ROLLBACK_POLICY,
        resume_tool: 'POST /v2_resume_failed with { run_id } or { log_ids: [...] }',
        rows: data || [],
      });
    }

    if (action === 'v2_resume_failed' && req.method === 'POST') {
      const body = await req.json();
      const logIds = Array.isArray(body.log_ids) ? body.log_ids.map((v: any) => Number(v)).filter((n: number) => Number.isFinite(n)) : [];
      const runId = String(body.run_id || '');
      if (!runId && logIds.length === 0) return jsonResp({ ok: false, error: 'run_id or log_ids required' }, 400);
      let q = supabase
        .from('shopee_mutation_log')
        .select('id, run_id, action, region, request_payload')
        .eq('actor', V2_WIZARD_ACTOR)
        .eq('status', 'error')
        .order('created_at', { ascending: true })
        .limit(100);
      if (logIds.length > 0) q = q.in('id', logIds);
      else q = q.eq('run_id', runId);
      const { data, error } = await q;
      if (error) return jsonResp({ ok: false, error: error.message }, 500);
      const results: any[] = [];
      for (const row of data || []) {
        const retryBody = {
          ...(row.request_payload || {}),
          region: row.region,
          run_id: body.resume_run_id || row.run_id || runId || null,
          operator_id: body.operator_id || null,
          retry_of_log_id: row.id,
        };
        results.push({ source_log_id: row.id, ...(await runV2MutationAction(row.action, retryBody)) });
      }
      return jsonResp({
        ok: results.every(r => r.ok || r.skipped),
        rollback_policy: V2_ROLLBACK_POLICY,
        retried: results.length,
        results,
      });
    }

    if (V2_MUTATION_ACTIONS.has(action) && req.method === 'POST') {
      const body = await req.json();
      const result = await runV2MutationAction(action, body);
      return jsonResp(result, result.ok || result.skipped ? 200 : ((result as any).status || 400));
    }

    if (action === 'update_global_price' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const global_item_id = parseInt(body.global_item_id);
      const global_price_list = body.global_price_list || [];
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      if (!Array.isArray(global_price_list) || !global_price_list.length) return jsonResp({ ok: false, error: 'global_price_list required' }, 400);
      const result = await merchantApiCall(r, '/api/v2/global_product/update_price', { method: 'POST', body: { global_item_id, global_price_list } });
      return jsonResp({ ok: !result.error, region: r, global_item_id, sent_global_price_list: global_price_list, result });
    }

    // Update SKU at the merchant (CBSC global product) level.
    // - Use `update_global_item` to change the parent item SKU (no variants).
    // - Use `update_global_model` to change variant SKUs in bulk.
    // Single edge call per item or per item-with-models — frontend chunks the
    // requested edits so we don't hold a long-running request open.
    if (action === 'update_global_item' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const global_item_id = parseInt(body.global_item_id);
      const global_item_sku = typeof body.global_item_sku === 'string' ? body.global_item_sku.trim() : '';
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      if (!global_item_sku) return jsonResp({ ok: false, error: 'global_item_sku required' }, 400);
      return withPublishRequestId(action, r, null, body, async () => {
        const result = await merchantApiCall(r, '/api/v2/global_product/update_global_item', {
          method: 'POST',
          body: { global_item_id, global_item_sku },
        });
        return jsonResp({ ok: !result.error, region: r, global_item_id, global_item_sku, result });
      });
    }

    if (action === 'update_global_model' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const global_item_id = parseInt(body.global_item_id);
      const global_model = Array.isArray(body.global_model) ? body.global_model : [];
      const cleaned = global_model
        .map((m: any) => ({
          global_model_id: parseInt(m?.global_model_id),
          global_model_sku: typeof m?.global_model_sku === 'string' ? m.global_model_sku.trim() : '',
        }))
        .filter((m: any) => Number.isFinite(m.global_model_id) && m.global_model_id > 0 && m.global_model_sku !== '');
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      if (cleaned.length === 0) return jsonResp({ ok: false, error: 'global_model[] required (global_model_id + global_model_sku)' }, 400);
      return withPublishRequestId(action, r, null, body, async () => {
        const result = await merchantApiCall(r, '/api/v2/global_product/update_global_model', {
          method: 'POST',
          body: { global_item_id, global_model: cleaned },
        });
        return jsonResp({ ok: !result.error, region: r, global_item_id, sent_global_model: cleaned, result });
      });
    }

    // --- v20: product registration helpers ---

    // GET /proxy_image?url=<encoded> - proxy only StarOneMall/known CDN images for browser canvas use.
    if (action === 'proxy_image') {
      const imageUrlRaw = url.searchParams.get('url') || '';
      if (!imageUrlRaw) return imageProxyError('url required', 400);
      try {
        let normalized = imageUrlRaw.trim();
        if (normalized.startsWith('//')) normalized = 'https:' + normalized;
        const candidates = Array.from(new Set([
          normalized,
          normalized.replace(/^https:\/\//i, 'http://'),
          normalized.replace(/^http:\/\//i, 'https://'),
        ])).filter(Boolean);

        let lastErr = 'proxy fetch failed';
        for (const imageUrl of candidates) {
          let upstream: URL;
          try { upstream = new URL(imageUrl); } catch { continue; }
          if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') continue;
          const targetCheck = await assertPublicProxyTarget(upstream);
          if (!targetCheck.ok) return imageProxyError(targetCheck.error || 'proxy_target_blocked', targetCheck.status || 403);
          if (/\.svg(\?|$)/i.test(upstream.pathname)) return imageProxyError('svg_not_allowed', 415);

          const referers = Array.from(new Set([
            `${upstream.protocol}//${upstream.hostname}/`,
            'https://www.staronemall.com/',
          ]));

          for (const referer of referers) {
            let r: Response;
            try {
              r = await fetch(imageUrl, {
                redirect: 'manual',
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Accept': 'image/avif,image/webp,image/apng,image/jpeg,image/png,image/*;q=0.8',
                  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                  'Referer': referer,
                },
              });
            } catch (e: any) {
              lastErr = 'upstream_fetch_failed';
              continue;
            }
            if (r.status >= 300 && r.status < 400) {
              lastErr = 'upstream_redirect_blocked';
              continue;
            }
            if (r.ok) {
              const ct = r.headers.get('content-type') || '';
              if (!isSupportedImageContentType(ct)) return imageProxyError('upstream_content_type_not_image', 415);
              const len = Number(r.headers.get('content-length') || 0);
              if (len > PROXY_IMAGE_MAX_BYTES) return imageProxyError('upstream_image_too_large', 413);
              const buf = await r.arrayBuffer();
              if (buf.byteLength > PROXY_IMAGE_MAX_BYTES) return imageProxyError('upstream_image_too_large', 413);
              const bytes = new Uint8Array(buf);
              if (isSvgLike(ct, bytes)) return imageProxyError('svg_not_allowed', 415);
              audit('proxy_image_ok', { host: upstream.hostname, bytes: buf.byteLength, content_type: ct });
              return new Response(buf, { status: 200, headers: { 'Content-Type': ct, ...IMAGE_PROXY_HEADERS } });
            }
            lastErr = `upstream_${r.status}`;
          }
        }
        return imageProxyError(lastErr, 502);
      } catch (e: any) {
        audit('proxy_image_error', { error: String(e?.message || e) });
        return imageProxyError('proxy_image_failed', 502);
      }
    }

    // POST /upload_image - validate a base64 JPEG/PNG and upload to Shopee media space.
    // Body: { region, image_base64, source_url?, main_image_url?, layer_version?, output_hash? }
    if (action === 'upload_image' && req.method === 'POST') {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object') return jsonResp({ ok: false, error: 'invalid_json' }, 400);
      const r = normalizeRegion(body.region);
      if (!r) return jsonResp({ ok: false, error: 'invalid_region', allowed_regions: OPERATING_REGIONS }, 400);

      const decoded = decodeBase64Image(body.image_base64 || '');
      if (!decoded.ok) return jsonResp({ ok: false, error: decoded.error }, decoded.error === 'image_too_large' ? 413 : 400);
      const inspected = inspectUploadImage(decoded.bytes, decoded.mimeHint);
      if (!inspected.ok) {
        return jsonResp({
          ok: false,
          error: inspected.error,
          width: (inspected as any).width,
          height: (inspected as any).height,
        }, inspected.error === 'image_dimensions_out_of_range' ? 413 : 415);
      }

      const sourceUrl = String(body.source_url || '').trim();
      const mainImageUrl = String(body.main_image_url || '').trim();
      const layerVersion = String(body.layer_version || '').trim();
      const outputHash = String(body.output_hash || '').trim();
      const hasGeneratedKey = !!(sourceUrl && mainImageUrl && layerVersion && outputHash);
      const idempotencyKeyHash = hasGeneratedKey
        ? await sha256Hex({ sourceUrl, mainImageUrl, layerVersion, outputHash, region: r })
        : '';
      const payloadHash = hasGeneratedKey
        ? `upload_image:${idempotencyKeyHash}:${Math.floor(Date.now() / GENERATED_UPLOAD_CACHE_TTL_MS)}`
        : await sha256Hex({ action: 'upload_image', region: r, outputHash: outputHash || await sha256Hex(decoded.bytes), bytes: decoded.bytes.byteLength });
      const requestPayload = {
        region: r,
        source_url: sourceUrl || null,
        main_image_url: mainImageUrl || null,
        layer_version: layerVersion || null,
        output_hash: outputHash || null,
        idempotency_key_hash: idempotencyKeyHash || null,
        bytes: decoded.bytes.byteLength,
        mime: inspected.mime,
        width: inspected.width,
        height: inspected.height,
      };

      if (hasGeneratedKey) {
        const cached = await findRecentGeneratedUpload(idempotencyKeyHash, r);
        const cachedResponse = cached?.response || null;
        if (cachedResponse?.image_id) {
          audit('upload_image_cache_hit', { region: r, idempotency_key_hash: idempotencyKeyHash, log_id: cached.id });
          return jsonResp({
            ok: true,
            region: r,
            image_url: cachedResponse.image_url || '',
            image_id: cachedResponse.image_id,
            request_id: cachedResponse.request_id || null,
            cached: true,
            previous_log_id: cached.id,
          });
        }
      }

      audit('upload_image_started', {
        region: r,
        bytes: decoded.bytes.byteLength,
        mime: inspected.mime,
        width: inspected.width,
        height: inspected.height,
        idempotency_key_hash: idempotencyKeyHash || null,
      });
      const uploadJson = await uploadShopeeMediaImage(r, decoded.bytes, inspected.mime, body);
      const perImageErrors = extractPerImageErrors(uploadJson);
      const imageInfo = extractUploadImageInfo(uploadJson, r);
      const durationMs = uploadJson.duration_ms ?? null;

      if (uploadJson.error || perImageErrors.length > 0 || !imageInfo.image_id) {
        const clientError = uploadJson.error || perImageErrors[0]?.error || 'upload_image_failed';
        const clientMessage = uploadJson.message || perImageErrors[0]?.message || 'Shopee media upload failed';
        await insertUploadLog({
          region: r,
          payloadHash,
          requestPayload,
          status: 'error',
          response: { error: uploadJson.error || null, message: uploadJson.message || null, per_image_errors: perImageErrors, request_id: uploadJson.request_id || null, auth_shape: uploadJson.auth_shape || null },
          errorMsg: `${clientError} ${clientMessage}`.trim(),
          requestId: uploadJson.request_id || null,
          durationMs,
          body,
        });
        audit('upload_image_failed', { region: r, error: clientError, message: clientMessage, request_id: uploadJson.request_id || null, per_image_errors: perImageErrors });
        return jsonResp({ ok: false, region: r, error: clientError, message: clientMessage, per_image_errors: perImageErrors, request_id: uploadJson.request_id || null }, 502);
      }

      const responsePayload = {
        image_url: imageInfo.image_url,
        image_id: imageInfo.image_id,
        request_id: imageInfo.request_id,
        auth_shape: uploadJson.auth_shape || null,
      };
      const log = await insertUploadLog({
        region: r,
        payloadHash,
        requestPayload,
        status: 'ok',
        response: responsePayload,
        requestId: imageInfo.request_id,
        durationMs,
        body,
      });
      audit('upload_image_ok', { region: r, image_id: imageInfo.image_id, request_id: imageInfo.request_id, log_id: log.id || null, auth_shape: uploadJson.auth_shape || null });
      return jsonResp({ ok: true, region: r, image_url: imageInfo.image_url, image_id: imageInfo.image_id, request_id: imageInfo.request_id, cached: false });
    }

    // POST /add_item ??create a new Shopee product listing (shop-level, unlisted by default)
    // Body: { region, name, description?, sku, price, stock, weight_g, category_id, image_url, condition? }
    // Returns: { ok, item_id }
    if (action === 'add_item' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const {
        name, sku, price, stock = 0, weight_g = 100,
        category_id, image_url, image_id, condition = 'NEW', description, variation,
        days_to_ship = 2, brand,
        package_length_cm = 20, package_width_cm = 15, package_height_cm = 5,
        attribute_list = [], wholesale_list = [],
      } = body;
      if (!name) return jsonResp({ ok: false, error: 'name required' }, 400);
      if (!sku) return jsonResp({ ok: false, error: 'sku required' }, 400);
      if (!price) return jsonResp({ ok: false, error: 'price required' }, 400);
      if (!category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);

      // Fetch available logistics channels. Field per Shopee SDK is logistic_info[] with logistic_id+logistic_name+enabled+is_free.
      const logisticsResp = await shopApiCall(r, '/api/v2/logistics/get_channel_list');
      const allCh: any[] = logisticsResp.response?.logistics_channel_list || [];
      const pickId = (ch: any) => ch?.logistic_id ?? ch?.logistics_channel_id ?? ch?.channel_id ?? ch?.id;
      const pickName = (ch: any) => ch?.logistic_name ?? ch?.name ?? `channel_${pickId(ch)}`;
      const eligibleCh = allCh.filter(ch => pickId(ch) != null && (ch.enabled ?? true));
      let logistic_info = eligibleCh.map(ch => ({
        logistic_id: Number(pickId(ch)),
        logistic_name: String(pickName(ch)),
        enabled: true,
        is_free: false,
      }));
      if (logistic_info.length === 0 && allCh.length > 0) {
        const first = allCh[0];
        const id = pickId(first);
        if (id != null) logistic_info = [{ logistic_id: Number(id), logistic_name: String(pickName(first)), enabled: true, is_free: false }];
      }

      const item_desc = description || `${name}\n\nK-POP Official Merchandise. Ready stock, ships within 1-3 business days.`;
      const dts = Math.max(1, Math.min(30, Number(days_to_ship) || 2));
      const stockNum = Number(stock);

      // image: prefer image_id_list (Shopee's modern format); fallback to image_url_list.
      const imageBlock: any = {};
      if (image_id) imageBlock.image_id_list = [String(image_id)];
      else if (image_url) imageBlock.image_url_list = [String(image_url)];

      const payload: any = {
        item_name: name,
        description: item_desc,
        item_sku: sku,
        category_id: Number(category_id),
        condition,
        weight: Number(weight_g) / 1000,
        dimension: {
          package_length: Number(package_length_cm) || 20,
          package_width: Number(package_width_cm) || 15,
          package_height: Number(package_height_cm) || 5,
        },
        image: imageBlock,
        original_price: Number(price),
        seller_stock: [{ stock: stockNum }],   // top-level, NO location_id wrapper
        logistic_info: logistic_info.length > 0 ? logistic_info : [{ logistic_id: 80007, logistic_name: 'Default', enabled: true, is_free: false }],
        item_status: 'UNLIST',
        days_to_ship: dts,
        pre_order: { is_pre_order: false, days_to_ship: dts },
        brand: brand && brand.original_brand_name
          ? { brand_id: Number(brand.brand_id || 0), original_brand_name: String(brand.original_brand_name) }
          : { brand_id: 0, original_brand_name: 'No Brand' },
        attribute_list: Array.isArray(attribute_list) ? attribute_list : [],
        wholesale: Array.isArray(wholesale_list) ? wholesale_list : [],
      };

      // Variation support: max 2 tiers, max 50 total model combinations.
      // Per Shopee SDK: model[] entries take top-level original_price, seller_stock array (no v2 wrapper). NO per-model weight.
      if (variation && Array.isArray(variation.tier_variation) && Array.isArray(variation.model) && variation.tier_variation.length > 0) {
        if (variation.tier_variation.length > 2) return jsonResp({ ok: false, error: 'variation tiers must be <= 2' }, 400);
        if (variation.model.length > 50) return jsonResp({ ok: false, error: 'variation combinations must be <= 50' }, 400);
        payload.tier_variation = variation.tier_variation.map((t: any) => ({
          name: String(t?.name || '').trim(),
          option_list: Array.isArray(t?.option_list) ? t.option_list.map((o: any) => ({ option: String(o?.option || '').trim() })).filter((o: any) => o.option) : [],
        }));
        payload.model = variation.model.map((m: any) => ({
          tier_index: Array.isArray(m?.tier_index) ? m.tier_index.map((x: any) => Number(x)) : [],
          model_sku: String(m?.model_sku || '').trim(),
          original_price: Number(m?.original_price ?? price),
          seller_stock: [{ stock: Number(m?.stock ?? stock) }],
        }));
      }

      const result = await shopApiCall(r, '/api/v2/product/add_item', { method: 'POST', body: payload });
      if (result.error) return jsonResp({ ok: false, region: r, error: result.error, message: result.message, sent: payload, raw: result }, 502);
      return jsonResp({ ok: true, region: r, item_id: result.response?.item_id, sent: payload, raw: result });
    }

    return jsonResp({ ok: false, error: `unknown: ${action}` }, 404);
  } catch (e: any) {
    audit('request_unhandled_error', { action, error: String(e?.message || e), stack: e?.stack ? String(e.stack).slice(0, 800) : null });
    return jsonResp({ ok: false, error: 'internal_error', message: 'Unexpected shopee-bridge error' }, 500);
  }
});
