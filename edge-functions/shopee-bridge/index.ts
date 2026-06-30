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
  "lookup-sku",
  "list_items",
  "lookup-sku",
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
  "oauth_callback",
]);

const SANDBOX_HOST = 'openplatform.sandbox.test-stable.shopee.sg';
const LIVE_HOST = 'partner.shopeemobile.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info, x-platform-bridge-token',
  'Access-Control-Max-Age': '3600',
};

// @ts-ignore
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const ENV_PARTNER_ID = Deno.env.get("SHOPEE_PARTNER_ID") || "";
const ENV_PARTNER_KEY = Deno.env.get("SHOPEE_PARTNER_KEY") || "";
// CBSC main account ID ??Shopee CB Mall / KRSC group. Same across all 10 region shops in our setup.
const MAIN_ACCOUNT_ID = Number(Deno.env.get("SHOPEE_MAIN_ACCOUNT_ID") || "1842717");
const DEFAULT_SHOPEE_ACCOUNT_KEY = "starphotocard";
// v85: add gated Shopee Product batch price probe endpoints.
const SOURCE_VERSION = 85;
const DENO_DEPLOYMENT_ID = Deno.env.get("DENO_DEPLOYMENT_ID") || "";
const DEPLOYMENT_VERSION_MATCH = DENO_DEPLOYMENT_ID.match(/_(\d+)$/);
const DEPLOYMENT_VERSION = DEPLOYMENT_VERSION_MATCH ? Number(DEPLOYMENT_VERSION_MATCH[1]) : null;
const HEALTH_VERSION = DEPLOYMENT_VERSION ?? SOURCE_VERSION;
const OPERATING_REGIONS = ['SG', 'BR', 'MY', 'PH', 'TH', 'TW'];
const OPERATING_REGION_SET = new Set(OPERATING_REGIONS);
const DEFAULT_REFRESH_THRESHOLD_SEC = 7200;
const DEFAULT_REFRESH_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1000;
const SHOPEE_HEADLESS_DELETE_CONFIRM_PHRASE = 'DELETE_SHOPEE_GLOBAL_ITEM';
const SHOPEE_BATCH_PRICE_CONFIRMATION = 'BATCH_PRICE_PROBE_APPROVED';
const SHOPEE_DEFAULT_MODEL_PRICE_RATIO_LIMIT = 7;
const SHOPEE_REGION_MODEL_PRICE_RATIO_LIMITS: Record<string, number> = Object.freeze({
  SG: 5,
  TW: 5,
  TH: 5,
  MY: 5,
  PH: 5,
  BR: 4,
});
const SHOPEE_BR_PUBLISHED_LIST_EARLY_CHECK_AFTER_POLLS = 3;
const SHOPEE_BR_PUBLISHED_LIST_EARLY_CHECK_EVERY_POLLS = 3;
const SHOPEE_BR_MAX_PUBLISH_POLLS = 36;
const SHOPEE_PUBLISH_TASK_POLL_DELAYS_MS = Object.freeze([800, 1200, 2000]);
const SHOPEE_PUBLISHED_LIST_EARLY_CHECK_AFTER_POLLS = 5;
const SHOPEE_PUBLISHED_LIST_EARLY_CHECK_EVERY_POLLS = 3;
const PROXY_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
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
  'image.yes24.com',
  'cf.shopee.sg',
  'cf.shopee.tw',
  'cf.shopee.ph',
  'cf.shopee.com.my',
  'cf.shopee.co.th',
  'cf.shopee.com.br',
  'bpdafetvjyvvwbksvowu.supabase.co',
  'mgqlwgnmwegzsjelbrih.supabase.co',
  'res.cloudinary.com',
]);
const PROXY_ALLOWED_SUFFIXES = [
  '.wisacdn.com',
  '.shopeesz.com',
];

async function getAccountCredential(accountKey: string) {
  try {
    const { data, error } = await supabase
      .from('shopee_account_credentials')
      .select('account_key, partner_id, partner_key_secret_name, is_sandbox')
      .eq('account_key', accountKey)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (e: any) {
    audit('account_credential_lookup_failed', { account_key: accountKey, error: String(e?.message || e) });
    return null;
  }
}

async function getApp(accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const key = normalizeAccountKey(accountKey);
  const { data } = await supabase.from('shopee_app').select('*').eq('id', 1).single();
  if (!data) throw new Error('shopee_app no');
  const credential = await getAccountCredential(key);
  if (credential?.partner_id && credential?.partner_key_secret_name) {
    const partnerKey = Deno.env.get(String(credential.partner_key_secret_name));
    if (!partnerKey) {
      throw new Error(`Shopee partner key secret missing for account=${key}: ${credential.partner_key_secret_name}`);
    }
    return {
      ...data,
      account_key: key,
      partner_id: Number(credential.partner_id),
      partner_key: partnerKey,
      partner_key_secret_name: credential.partner_key_secret_name,
      is_sandbox: Boolean(credential.is_sandbox),
    };
  }
  if (key !== DEFAULT_SHOPEE_ACCOUNT_KEY) {
    throw new Error(`Shopee credential missing for account=${key}`);
  }
  return {
    ...data,
    account_key: key,
    partner_id: ENV_PARTNER_ID ? Number(ENV_PARTNER_ID) : data.partner_id,
    partner_key: ENV_PARTNER_KEY || data.partner_key,
  };
}
function host(s: boolean): string { return s ? SANDBOX_HOST : LIVE_HOST; }

function normalizeAccountKey(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{1,62}$/.test(raw)) return raw;
  return DEFAULT_SHOPEE_ACCOUNT_KEY;
}

async function getShopeeAccountProfile(accountKey: string) {
  try {
    const { data } = await supabase
      .from('shopee_account_profiles')
      .select('account_key, display_name, main_account_id, merchant_id, layer_asset_path, enabled_regions, status')
      .eq('account_key', accountKey)
      .maybeSingle();
    return data || null;
  } catch (e: any) {
    audit('account_profile_lookup_failed', { account_key: accountKey, error: String(e?.message || e) });
    return null;
  }
}

async function mainAccountIdForAccount(accountKey: string): Promise<number> {
  const profile = await getShopeeAccountProfile(accountKey);
  return Number(profile?.main_account_id || MAIN_ACCOUNT_ID);
}

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function audit(event: string, payload: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ service: 'shopee-bridge', event, ts: new Date().toISOString(), ...payload }));
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function elapsedMs(startMs: number): number {
  return Math.max(0, Date.now() - startMs);
}

function createShopeeTimingRecorder() {
  const startedAt = Date.now();
  const marks: Record<string, number> = {};
  return {
    mark(name: string, startMs: number) {
      marks[name] = elapsedMs(startMs);
      return marks[name];
    },
    since(startMs: number) {
      return elapsedMs(startMs);
    },
    snapshot() {
      return { ...marks, total: elapsedMs(startedAt) };
    },
  };
}

function nextPublishTaskPollDelayMs(attemptIndex: number, targetRegion = ''): number {
  const index = Math.max(0, Math.floor(Number(attemptIndex) || 0));
  const delay = SHOPEE_PUBLISH_TASK_POLL_DELAYS_MS[
    Math.min(index, SHOPEE_PUBLISH_TASK_POLL_DELAYS_MS.length - 1)
  ];
  return Number(delay) || 2000;
}

function shouldVerifyPublishedListDuringPublishPolling(targetRegion: string, pollAttempts: number): boolean {
  const region = String(targetRegion || '').toUpperCase();
  const attempts = Math.max(0, Number(pollAttempts) || 0);
  if (region === 'BR') {
    return attempts >= SHOPEE_BR_PUBLISHED_LIST_EARLY_CHECK_AFTER_POLLS
      && attempts % SHOPEE_BR_PUBLISHED_LIST_EARLY_CHECK_EVERY_POLLS === 0;
  }
  return attempts >= SHOPEE_PUBLISHED_LIST_EARLY_CHECK_AFTER_POLLS
    && attempts % SHOPEE_PUBLISHED_LIST_EARLY_CHECK_EVERY_POLLS === 0;
}

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

function uniquePositiveNumberList(values: unknown[]): number[] {
  return [...new Set(
    values
      .map((value) => Number(value || 0))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.floor(value)),
  )];
}

function isMissingAccountKeyColumn(error: any): boolean {
  const text = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`;
  return error?.code === '42703' && /account_key/i.test(text);
}

async function getShopeeTokenRow(region: string, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY): Promise<any | null> {
  const scoped = await supabase
    .from('shopee_tokens')
    .select('*')
    .eq('account_key', accountKey)
    .eq('region', region)
    .maybeSingle();
  if (!scoped.error) return scoped.data || null;
  if (!isMissingAccountKeyColumn(scoped.error)) throw scoped.error;

  const legacy = await supabase
    .from('shopee_tokens')
    .select('*')
    .eq('region', region)
    .maybeSingle();
  if (legacy.error) throw legacy.error;
  return legacy.data ? { account_key: accountKey, ...legacy.data } : null;
}

async function getShopeeTokenRows(accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY, opts: { regions?: string[]; includeAccessToken?: boolean } = {}): Promise<any[]> {
  const baseColumns = ['region', 'shop_id', 'merchant_id', 'expires_at', 'is_sandbox'];
  if (opts.includeAccessToken) baseColumns.push('access_token');
  const scopedColumns = ['account_key', ...baseColumns].join(', ');
  const legacyColumns = baseColumns.join(', ');

  let scopedQuery = supabase
    .from('shopee_tokens')
    .select(scopedColumns)
    .eq('account_key', accountKey);
  if (opts.regions?.length) scopedQuery = scopedQuery.in('region', opts.regions);
  const scoped = await scopedQuery.order('region', { ascending: true });
  if (!scoped.error) return scoped.data || [];
  if (!isMissingAccountKeyColumn(scoped.error)) throw scoped.error;

  let legacyQuery = supabase
    .from('shopee_tokens')
    .select(legacyColumns);
  if (opts.regions?.length) legacyQuery = legacyQuery.in('region', opts.regions);
  const legacy = await legacyQuery.order('region', { ascending: true });
  if (legacy.error) throw legacy.error;
  return (legacy.data || []).map((row: any) => ({ account_key: accountKey, ...row }));
}

async function updateShopeeTokenRow(region: string, values: Record<string, unknown>, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const scoped = await supabase
    .from('shopee_tokens')
    .update(values)
    .eq('account_key', accountKey)
    .eq('region', region);
  if (!scoped.error) return;
  if (!isMissingAccountKeyColumn(scoped.error)) throw scoped.error;

  const legacy = await supabase
    .from('shopee_tokens')
    .update(values)
    .eq('region', region);
  if (legacy.error) throw legacy.error;
}

async function getShopeeShopRowByShopId(shopId: string | number, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY): Promise<any | null> {
  const scoped = await supabase
    .from('shopee_shops')
    .select('shop_id, region, merchant_id, status')
    .eq('account_key', accountKey)
    .eq('shop_id', String(shopId))
    .maybeSingle();
  if (!scoped.error) return scoped.data || null;
  if (!isMissingAccountKeyColumn(scoped.error)) throw scoped.error;

  const legacy = await supabase
    .from('shopee_shops')
    .select('shop_id, region, merchant_id, status')
    .eq('shop_id', String(shopId))
    .maybeSingle();
  if (legacy.error) throw legacy.error;
  return legacy.data ? { account_key: accountKey, ...legacy.data } : null;
}

async function updateShopeeShopTokenByShopId(shopId: string | number, values: Record<string, unknown>, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const scoped = await supabase
    .from('shopee_shops')
    .update(values)
    .eq('account_key', accountKey)
    .eq('shop_id', String(shopId));
  if (!scoped.error) return;
  if (!isMissingAccountKeyColumn(scoped.error)) throw scoped.error;

  const legacy = await supabase
    .from('shopee_shops')
    .update(values)
    .eq('shop_id', String(shopId));
  if (legacy.error) throw legacy.error;
}

async function getRegionShopRow(region: string, shopId: string | number, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const data = await getShopeeShopRowByShopId(shopId, accountKey);
  if (!data) throw new Error(`principal missing in shopee_shops for account=${accountKey}, region=${region}, shop_id=${shopId}`);
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

async function persistShopToken(region: string, row: any, token: any, expiresAt: number, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  if (!token?.access_token || !token?.refresh_token) {
    throw new Error(`token refresh payload incomplete for region=${region}`);
  }
  const shopRow = await getRegionShopRow(region, row.shop_id, accountKey);
  if (shopRow.merchant_id && row.merchant_id && Number(shopRow.merchant_id) !== Number(row.merchant_id)) {
    throw new Error(`principal mismatch merchant_id for region=${region}, shop_id=${row.shop_id}`);
  }

  await updateShopeeTokenRow(region, {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: expiresAt,
  }, accountKey);

  if (row?.shop_id) {
    await updateShopeeShopTokenByShopId(row.shop_id, {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: new Date(expiresAt * 1000).toISOString(),
    }, accountKey);
  }
  audit('shop_token_persist_ok', {
    account_key: accountKey,
    region,
    shop_id: row?.shop_id || null,
    merchant_id: row?.merchant_id || null,
    expire_in: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
    access_fp: fp(token.access_token),
    refresh_fp: fp(token.refresh_token),
  });
}

async function refreshMerchantToken(region: string, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const data = await getShopeeTokenRow(region, accountKey);
  if (!data) throw new Error(`token no: ${region}`);
  if (!data.merchant_id) throw new Error(`merchant_id missing for region ${region}`);
  const app = await getApp(accountKey);
  const path = '/api/v2/auth/access_token/get';
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}`);
  const url = `https://${host(app.is_sandbox)}${path}?partner_id=${app.partner_id}&timestamp=${ts}&sign=${sign}`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: data.refresh_token, partner_id: app.partner_id, merchant_id: data.merchant_id }) });
  const j = await r.json();
  if (j.error) {
    audit('merchant_refresh_fail', { account_key: accountKey, region, error: j.error, message: j.message || null });
    throw new Error(`merchant refresh: ${j.error} ${j.message || ''} | full: ${JSON.stringify(j)}`);
  }
  if (!j.refresh_token) {
    audit('merchant_refresh_fail', { account_key: accountKey, region, error: 'missing_refresh_token', message: 'refresh_access_token response did not return refresh_token' });
    throw new Error(`merchant refresh: missing refresh_token in response for region=${region}`);
  }
  const newExpiry = Math.floor(Date.now() / 1000) + (j.expire_in || 14400);
  // Merchant tokens are not valid for shop/product APIs. Keep shopee_tokens shop-scoped.
  audit('merchant_refresh_ok', {
    account_key: accountKey,
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

async function forceRefreshShopToken(region: string, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const data = await getShopeeTokenRow(region, accountKey);
  if (!data) throw new Error(`token no: ${region}`);
  const app = await getApp(accountKey);
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
    audit('shop_refresh_fail', { account_key: accountKey, region, shop_id: data.shop_id, error: j.error, message: j.message || null });
    throw new Error(`shop refresh: ${j.error} ${j.message || ''}`);
  }
  if (!j.refresh_token) {
    audit('shop_refresh_fail', { account_key: accountKey, region, shop_id: data.shop_id, error: 'missing_refresh_token', message: 'refresh_access_token response did not return refresh_token' });
    throw new Error(`shop refresh: missing refresh_token in response for region=${region}`);
  }
  const newExpiry = Math.floor(Date.now() / 1000) + (j.expire_in || 14400);
  await persistShopToken(region, data, j, newExpiry, accountKey);
  const probe = await probeShopToken(app, j.access_token, data.shop_id);
  if (!probe.ok) {
    audit('shop_refresh_probe_fail', { account_key: accountKey, region, shop_id: data.shop_id, error: probe.error || null, message: probe.message || null });
    throw new Error(`shop refresh returned token rejected by shop API: ${probe.error || 'unknown'} ${probe.message || ''}`.trim());
  }
  audit('shop_refresh_ok', {
    account_key: accountKey,
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
async function issueMerchantToken(region: string, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const data = await getShopeeTokenRow(region, accountKey);
  if (!data) throw new Error(`token no: ${region}`);
  const app = await getApp(accountKey);
  const path = '/api/v2/auth/access_token/get';
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}`);
  const url = `https://${host(app.is_sandbox)}${path}?partner_id=${app.partner_id}&timestamp=${ts}&sign=${sign}`;

  // Variant A: main_account_id (CBSC primary)
  const mainAccountId = await mainAccountIdForAccount(accountKey);
  const bodyA: any = { refresh_token: data.refresh_token, partner_id: app.partner_id, main_account_id: mainAccountId };
  const rA = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyA) });
  const jA = await rA.json();
  if (!jA.error && jA.access_token) {
    return { access_token: jA.access_token, merchant_id: jA.merchant_id || data.merchant_id, main_account_id: mainAccountId, scope: 'main_account', raw: jA };
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

async function getValidToken(region: string, mode: 'shop' | 'merchant' = 'shop', accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const data = await getShopeeTokenRow(region, accountKey);
  if (!data) throw new Error(`token no: ${region}`);
  const now = Math.floor(Date.now() / 1000);
  if (data.expires_at && now < data.expires_at - 60) return { access_token: data.access_token, shop_id: data.shop_id, merchant_id: data.merchant_id, expires_at: data.expires_at };
  if (mode === 'merchant' && data.merchant_id) {
    const r = await refreshMerchantToken(region, accountKey);
    return r;
  }
  const app = await getApp(accountKey);
  const path = '/api/v2/auth/access_token/get';
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}`);
  const url = `https://${host(app.is_sandbox)}${path}?partner_id=${app.partner_id}&timestamp=${ts}&sign=${sign}`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: data.refresh_token, partner_id: app.partner_id, shop_id: data.shop_id }) });
  const j = await r.json();
  if (!j.error && j.access_token) {
    const newExpiry = Math.floor(Date.now() / 1000) + (j.expire_in || 14400);
    await persistShopToken(region, data, j, newExpiry, accountKey);
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
  const accountKey = normalizeAccountKey(opts.account_key || opts.accountKey);
  const app = await getApp(accountKey);
  const callWithToken = async (t: any) => {
    const ts = Math.floor(Date.now() / 1000);
    const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}${t.access_token}${t.shop_id}`);
    const baseQuery: Record<string, string> = { partner_id: String(app.partner_id), timestamp: String(ts), access_token: t.access_token, shop_id: String(t.shop_id), sign };
    if (opts.query) for (const [k, v] of Object.entries(opts.query)) baseQuery[k] = String(v);
    const url = `https://${host(app.is_sandbox)}${path}?${new URLSearchParams(baseQuery)}`;
    const r = await fetch(url, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
    return { http_status: r.status, ...(await r.json()) };
  };

  const first = await callWithToken(await getValidToken(region, 'shop', accountKey));
  if (!isInvalidAccessToken(first)) return first;

  try {
    const refreshed = await forceRefreshShopToken(region, accountKey);
    const second = await callWithToken(refreshed);
    if (!second.error) return { ...second, retried_after_shop_refresh: true };
    return { ...second, retried_after_shop_refresh: true, first_error: first.error };
  } catch (e: any) {
    return { ...first, auth_stage: 'stored_token_invalid_refresh_failed', refresh_error: String(e?.message || e) };
  }
}

// Refresh the _MERCHANT row's access_token using merchant_id principal.
async function refreshMerchantRowTokenStrict(accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY): Promise<{ access_token: string; merchant_id: number; expires_at: number }> {
  const data = await getShopeeTokenRow('_MERCHANT', accountKey);
  if (!data || !data.refresh_token || !data.merchant_id) throw new Error('merchant row token missing');
  const app = await getApp(accountKey);
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
  await updateShopeeTokenRow('_MERCHANT', {
    access_token: j.access_token,
    refresh_token: j.refresh_token || data.refresh_token,
    expires_at: newExpiry,
  }, accountKey);
  audit('merchant_row_refresh_ok', { account_key: accountKey, merchant_id: data.merchant_id, expire_in: j.expire_in });
  return { access_token: j.access_token, merchant_id: data.merchant_id, expires_at: newExpiry };
}

async function refreshMerchantRowToken(accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY): Promise<{ access_token: string; merchant_id: number; expires_at?: number } | null> {
  try {
    return await refreshMerchantRowTokenStrict(accountKey);
  } catch (e: any) {
    audit('merchant_row_refresh_unavailable', { account_key: accountKey, error: String(e?.message || e) });
    return null;
  }
}

// Get valid merchant token from _MERCHANT row, refreshing if needed.
async function getValidMerchantToken(accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY): Promise<{ access_token: string; merchant_id: number; expires_at?: number } | null> {
  const data = await getShopeeTokenRow('_MERCHANT', accountKey);
  if (!data || !data.access_token || !data.merchant_id) return null;
  const now = Math.floor(Date.now() / 1000);
  if (data.expires_at && now < data.expires_at - 60) {
    return { access_token: data.access_token, merchant_id: data.merchant_id, expires_at: data.expires_at };
  }
  return await refreshMerchantRowToken(accountKey);
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
  const accountKey = normalizeAccountKey(opts.account_key || opts.accountKey);
  const app = await getApp(accountKey);
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
  const merchTok = await getValidMerchantToken(accountKey);
  if (merchTok) {
    const r1 = await callWithToken(merchTok);
    if (!r1.error) return { ...r1, token_path: '_MERCHANT_row' };
    if (isInvalidAccessToken(r1)) {
      const refreshed = await refreshMerchantRowToken(accountKey);
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
    const issued = await issueMerchantToken(region, accountKey);
    const r3 = await callWithToken({ access_token: issued.access_token, merchant_id: issued.merchant_id });
    if (!r3.error) return { ...r3, token_path: 'issued_merchant', scope: (issued as any).scope };
    issuedErr = `${r3.error || ''} ${r3.message || ''}`.trim();
    if (!isInvalidAccessToken(r3)) return { ...r3, token_path: 'issued_merchant', scope: (issued as any).scope };
  } catch (e: any) {
    issuedErr = String(e?.message || e);
  }

  // Step 3: fallback to shop token signed with merchant_id (works only for SOME endpoints; CBSC/KRSC global_product needs merchant auth).
  try {
    const t = await getValidToken(region, 'shop', accountKey);
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
const UPDATE_PRICE_BATCH_PARALLELISM = 6;
const UPDATE_PRICE_BATCH_MAX_UPDATES = 60;
const V2_MUTATION_ACTIONS = new Set([
  'update_global_item',
  'update_global_model',
  'update_global_price',
  'update_shop_days_to_ship',
  'update_shop_item_name',
  'update_shop_item_description',
  'init_shop_tier_variation',
  'update_shop_tier_variation',
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

function normalizeBrandRows(result: any): any[] {
  const response = result?.response || result?.result?.response || result?.result || result || {};
  const rows = Array.isArray(response.brand_list) ? response.brand_list : [];
  return rows.map((brand: any) => ({
    brand_id: Number(brand?.brand_id || 0),
    original_brand_name: String(brand?.original_brand_name || brand?.brand_name || brand?.display_brand_name || '').trim(),
    display_brand_name: String(brand?.display_brand_name || brand?.original_brand_name || brand?.brand_name || '').trim(),
  })).filter((brand: any) => brand.original_brand_name || brand.display_brand_name);
}

async function fetchBrandListPages(region: string, scope: 'shop' | 'merchant', category_id: string, status: string, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const pageSize = 100;
  let offset = 0;
  const brands: any[] = [];
  const pages: any[] = [];
  const seenOffsets = new Set<string>();
  const path = scope === 'merchant'
    ? '/api/v2/global_product/get_brand_list'
    : '/api/v2/product/get_brand_list';
  for (let i = 0; i < 20; i++) {
    const key = String(offset);
    if (seenOffsets.has(key)) break;
    seenOffsets.add(key);
    const result = scope === 'merchant'
      ? await merchantApiCall(region, path, { query: { category_id, status, page_size: pageSize, offset }, account_key: accountKey })
      : await shopApiCall(region, path, { query: { category_id, status, page_size: pageSize, offset }, account_key: accountKey });
    pages.push(result);
    if (result.error) {
      return { ok: false, brands, result, pages, error: result.error, message: result.message };
    }
    brands.push(...normalizeBrandRows(result));
    const response = result?.response || {};
    if (!response.has_next_page) break;
    const next = Number(response.next_offset);
    if (!Number.isFinite(next) || next === offset) break;
    offset = next;
  }
  const deduped = Array.from(new Map(brands.map((brand: any) => [
    `${brand.brand_id}:${(brand.original_brand_name || brand.display_brand_name).toLowerCase()}`,
    brand,
  ])).values());
  return { ok: true, brands: deduped, result: pages[0] || null, pages, page_count: pages.length };
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

async function hydrateUpdateGlobalItemPayload(region: string, requestPayload: any, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const payload = canonicalize(requestPayload);
  if (payload.image?.image_id_list?.length) return payload;
  const globalItemId = Number(payload.global_item_id || 0);
  if (!Number.isFinite(globalItemId) || globalItemId <= 0) return payload;
  const result = await merchantApiCall(region, '/api/v2/global_product/get_global_item_info', {
    query: { global_item_id_list: String(globalItemId) },
    account_key: accountKey,
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
  const accountKey = normalizeAccountKey(body?.account_key || body?.accountKey);
  const app = await getApp(accountKey);
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

  const t = await getValidToken(region, 'shop', accountKey);
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

async function findRecentGeneratedUpload(idempotencyKeyHash: string, region: string, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  if (!idempotencyKeyHash) return null;
  const since = new Date(Date.now() - GENERATED_UPLOAD_CACHE_TTL_MS).toISOString();
  const { data, error } = await supabase
    .from('shopee_mutation_log')
    .select('id, created_at, response')
    .eq('action', 'upload_image')
    .eq('status', 'ok')
    .eq('region', region)
    .eq('request_payload->>account_key', accountKey)
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
  return payload;
}

async function enforceV2ProbePreflight(action: string, requestPayload: any, body: any) {
  const flags = await getV2CapabilityFlags();
  const blockedFields: string[] = [];
  if (action === 'update_global_item') {
    if (requestPayload.item_name !== undefined && !flags.probe_item_name_ok) blockedFields.push('item_name');
    if (requestPayload.weight !== undefined && !flags.probe_model_weight_ok) blockedFields.push('weight');
  }
  // Shopee Global Product update_global_model documents model-level `weight`
  // as a supported field. Keep the probe gate only for update_global_item.weight.
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
  const firstBatchItem = Array.isArray(requestPayload.item_list)
    ? requestPayload.item_list.find((row: any) => Number(row?.item_id) > 0)
    : null;
  return {
    region,
    target_global_item_id: Number(requestPayload.global_item_id) || null,
    target_global_model_id: modelIds.length === 1 ? modelIds[0] : null,
    target_shop_item_id: Number(requestPayload.item_id || requestPayload.shop_item_id || firstBatchItem?.item_id) || null,
  };
}

function normalizeBatchOutletPriceItemList(raw: any) {
  const errors: string[] = [];
  if (!Array.isArray(raw)) {
    return { ok: false, item_list: [], errors: ['item_list must be an array'] };
  }
  if (raw.length < 1 || raw.length > 100) {
    errors.push('item_list length must be between 1 and 100');
  }

  const item_list = raw.map((row: any, index: number) => {
    const outlet_shop_id = Number(row?.outlet_shop_id || row?.shop_id);
    const item_id = Number(row?.item_id || row?.shop_item_id);
    const priceInput = Array.isArray(row?.price_list) ? row.price_list : [];
    if (!Number.isFinite(outlet_shop_id) || outlet_shop_id <= 0) errors.push(`item_list[${index}].outlet_shop_id must be positive`);
    if (!Number.isFinite(item_id) || item_id <= 0) errors.push(`item_list[${index}].item_id must be positive`);
    if (priceInput.length < 1) errors.push(`item_list[${index}].price_list must have at least 1 row`);

    const price_list = priceInput.map((priceRow: any, priceIndex: number) => {
      const original_price = Number(priceRow?.original_price);
      if (!Number.isFinite(original_price) || original_price <= 0) {
        errors.push(`item_list[${index}].price_list[${priceIndex}].original_price must be greater than 0`);
      }
      const model_id = Number(priceRow?.model_id || priceRow?.shop_model_id || 0);
      if ((priceRow?.model_id !== undefined || priceRow?.shop_model_id !== undefined) && (!Number.isFinite(model_id) || model_id < 0)) {
        errors.push(`item_list[${index}].price_list[${priceIndex}].model_id must be non-negative when provided`);
      }
      const out: Record<string, number> = { original_price };
      if (Number.isFinite(model_id) && model_id > 0) out.model_id = model_id;
      return out;
    });

    return { outlet_shop_id, item_id, price_list };
  });

  return { ok: errors.length === 0, item_list, errors };
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
  const publishRequestId = typeof body?.publish_request_id === 'string' ? body.publish_request_id.trim() : '';
  const legacyIdempotencyToken = typeof body?.idempotency_token === 'string' ? body.idempotency_token.trim() : '';
  const rawId = publishRequestId || legacyIdempotencyToken || null;
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

async function forceRefreshForMutation(region: string, action: string, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  if (action === 'update_shop_days_to_ship') {
    const refreshed = await forceRefreshShopToken(region, accountKey);
    audit('v2_pre_fanout_shop_refresh_ok', { account_key: accountKey, region, shop_id: refreshed.shop_id, action });
    return { shop: { ok: true, shop_id: refreshed.shop_id, expires_at: refreshed.expires_at } };
  }
  const merchant = await refreshMerchantRowToken(accountKey);
  if (merchant) {
    audit('v2_pre_fanout_merchant_refresh_ok', { account_key: accountKey, region, merchant_id: merchant.merchant_id, action });
    return { merchant: { ok: true, merchant_id: merchant.merchant_id } };
  }
  const issued = await issueMerchantToken(region, accountKey);
  audit('v2_pre_fanout_merchant_issue_ok', { account_key: accountKey, region, merchant_id: issued.merchant_id, action, scope: (issued as any).scope });
  return { merchant: { ok: true, merchant_id: issued.merchant_id, scope: (issued as any).scope } };
}

async function executeLoggedMutation(action: string, region: string, requestPayload: any, body: any, executor: (payload: any) => Promise<any>) {
  const accountKey = normalizeAccountKey(body?.account_key || body?.accountKey);
  const payloadHash = await sha256Hex({ action, account_key: accountKey, region, request_payload: requestPayload });
  const runId = body?.run_id || null;
  const dryRun = body?.dry_run === true;

  if (dryRun) {
    const log = await insertMutationLog({ action, region, payloadHash, requestPayload: { account_key: accountKey, ...requestPayload }, status: 'dry_run', body });
    audit('v2_mutation_dry_run_logged', { action, account_key: accountKey, region, run_id: runId, payload_hash: payloadHash, log_id: log.id || null, rollback_policy: V2_ROLLBACK_POLICY });
    return { ok: true, dry_run: true, account_key: accountKey, region, action, payload_hash: payloadHash, log_id: log.id || null, request_payload: requestPayload, rollback_policy: V2_ROLLBACK_POLICY };
  }

  const previous = await findOkMutation(payloadHash);
  if (previous) {
    audit('v2_mutation_idempotent_skip', { action, account_key: accountKey, region, run_id: runId, payload_hash: payloadHash, previous_log_id: previous.id });
    return { ok: true, skipped: true, previous_log_id: previous.id, account_key: accountKey, region, action, payload_hash: payloadHash, rollback_policy: V2_ROLLBACK_POLICY };
  }

  const tokenRefresh = accountKey === DEFAULT_SHOPEE_ACCOUNT_KEY
    ? await forceRefreshForMutation(region, action)
    : await forceRefreshForMutation(region, action, accountKey);
  const started = Date.now();
  const result = await executor(requestPayload);
  const durationMs = Date.now() - started;
  const status = result?.error ? 'error' : 'ok';
  const log = await insertMutationLog({
    action,
    region,
    payloadHash,
    requestPayload: { account_key: accountKey, ...requestPayload },
    status,
    response: result,
    errorMsg: result?.error ? `${result.error || ''} ${result.message || ''}`.trim() : null,
    requestId: result?.request_id || null,
    durationMs,
    body,
  });
  if (log.skipped) {
    return { ok: true, skipped: true, previous_log_id: log.previous_log_id, account_key: accountKey, region, action, payload_hash: payloadHash, result, rollback_policy: V2_ROLLBACK_POLICY };
  }
  audit('v2_mutation_logged', {
    action,
    account_key: accountKey,
    region,
    run_id: runId,
    status,
    payload_hash: payloadHash,
    log_id: log.id || null,
    rollback_policy: V2_ROLLBACK_POLICY,
  });
  return {
    ok: !result?.error,
    account_key: accountKey,
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

function normalizeUpdatePriceRegion(value: unknown): string {
  return String(value || 'SG').trim().toUpperCase();
}

function normalizeUpdatePriceRow(input: any, fallbackRegion = 'SG'): any {
  const region = normalizeUpdatePriceRegion(input?.region || fallbackRegion);
  const itemId = Number.parseInt(String(input?.item_id ?? input?.itemId ?? ''), 10);
  const priceList = Array.isArray(input?.price_list) ? input.price_list : [];
  const clientRef = input?.client_ref || input?.clientRef || null;

  if (!region) return { ok: false, error: 'region required' };
  if (!Number.isFinite(itemId) || itemId <= 0) return { ok: false, error: 'item_id required' };
  if (!Array.isArray(priceList) || priceList.length < 1) return { ok: false, error: 'price_list required' };
  if (priceList.length > 50) return { ok: false, error: 'price_list length must be between 1 and 50' };

  const normalizedPriceList = priceList.map((entry: any, index: number) => {
    const originalPrice = Number(entry?.original_price);
    if (!Number.isFinite(originalPrice) || originalPrice <= 0) {
      return { ok: false, error: `price_list[${index}].original_price required` };
    }
    const row: any = { original_price: originalPrice };
    if (entry?.model_id !== undefined && entry?.model_id !== null && entry?.model_id !== '') {
      const modelId = Number(entry.model_id);
      if (!Number.isFinite(modelId) || modelId < 0) {
        return { ok: false, error: `price_list[${index}].model_id invalid` };
      }
      row.model_id = modelId;
    }
    return { ok: true, row };
  });

  const invalid = normalizedPriceList.find((entry: any) => !entry.ok);
  if (invalid) return { ok: false, error: invalid.error };

  return {
    ok: true,
    row: {
      region,
      item_id: itemId,
      price_list: normalizedPriceList.map((entry: any) => entry.row),
      client_ref: clientRef,
    },
  };
}

function normalizeUpdatePriceBatchRows(body: any): any {
  const rows = Array.isArray(body?.updates)
    ? body.updates
    : (Array.isArray(body?.batches) ? body.batches : (Array.isArray(body?.items) ? body.items : []));
  if (!Array.isArray(rows) || rows.length < 1) {
    return { ok: false, status: 400, error: 'updates required' };
  }
  if (rows.length > UPDATE_PRICE_BATCH_MAX_UPDATES) {
    return { ok: false, status: 400, error: `updates length must be <= ${UPDATE_PRICE_BATCH_MAX_UPDATES}` };
  }
  const normalized = rows.map((row: any, index: number) => {
    const result = normalizeUpdatePriceRow(row, body?.region || 'SG');
    if (!result.ok) return { ok: false, index, error: result.error };
    return { ok: true, index, row: result.row };
  });
  const invalid = normalized.find((entry: any) => !entry.ok);
  if (invalid) {
    return { ok: false, status: 400, error: `updates[${invalid.index}]: ${invalid.error}` };
  }
  return { ok: true, rows: normalized.map((entry: any) => entry.row) };
}

async function executeShopUpdatePriceMutation(params: {
  accountKey: string;
  region: string;
  itemId: number;
  priceList: any[];
  body: any;
  clientRef?: string | null;
}) {
  const action = 'update_price';
  const requestPayload = {
    account_key: params.accountKey,
    item_id: params.itemId,
    price_list: params.priceList,
  };
  const payloadHash = await sha256Hex({
    action,
    account_key: params.accountKey,
    region: params.region,
    request_payload: requestPayload,
  });

  const started = Date.now();
  const result = await shopApiCall(params.region, '/api/v2/product/update_price', {
    method: 'POST',
    body: {
      item_id: params.itemId,
      price_list: params.priceList,
    },
    account_key: params.accountKey,
  });
  const durationMs = Date.now() - started;
  const failureList = Array.isArray(result?.response?.failure_list) ? result.response.failure_list : [];
  const ok = !result?.error && failureList.length === 0;
  const errorMsg = result?.error
    ? `${result.error || ''} ${result.message || ''}`.trim()
    : (failureList.length ? 'update_price failure_list: ' + JSON.stringify(failureList).slice(0, 500) : null);
  const log = await insertMutationLog({
    action,
    region: params.region,
    payloadHash,
    requestPayload,
    status: ok ? 'ok' : 'error',
    response: result,
    errorMsg,
    requestId: result?.request_id || null,
    durationMs,
    body: {
      ...params.body,
      account_key: params.accountKey,
      region: params.region,
      item_id: params.itemId,
      price_list: params.priceList,
      client_ref: params.clientRef || null,
    },
  });
  return {
    ok,
    account_key: params.accountKey,
    region: params.region,
    item_id: params.itemId,
    client_ref: params.clientRef || null,
    sent_price_list: params.priceList,
    failure_list: failureList,
    result,
    payload_hash: payloadHash,
    log_id: log.id || null,
    previous_log_id: log.previous_log_id || null,
    rollback_policy: V2_ROLLBACK_POLICY,
  };
}

async function runV2MutationAction(action: string, body: any) {
  const r = String(body.region || 'SG').toUpperCase();
  const accountKey = normalizeAccountKey(body?.account_key || body?.accountKey);
  body.account_key = accountKey;
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
    const attribute_list = normalizeAttributeList(body.attribute_list);
    if (global_item_sku) requestPayload.global_item_sku = global_item_sku;
    if (item_name) requestPayload.global_item_name = item_name;
    if (description) requestPayload.description = description;
    if (Number.isFinite(days_to_ship) && days_to_ship > 0) requestPayload.pre_order = { days_to_ship };
    if (Number.isFinite(weight) && weight > 0) requestPayload.weight = weight;
    if (imageIdList.length) requestPayload.image = { image_id_list: imageIdList };
    if (attribute_list.length) requestPayload.attribute_list = attribute_list;
    if (!global_item_id) return { ok: false, error: 'global_item_id required' };
    if (!global_item_sku && !item_name && !description && !requestPayload.pre_order && !requestPayload.weight && !attribute_list.length && !imageIdList.length) {
      return { ok: false, error: 'at least one of global_item_sku, global_item_name, description, days_to_ship, weight, attribute_list, image_id_list required' };
    }

    const preflight = await enforceV2ProbePreflight(action, requestPayload, body);
    if (!preflight.ok) return { ok: false, ...preflight };
    const finalPayload = await hydrateUpdateGlobalItemPayload(r, preflight.requestPayload, accountKey);
    if (!finalPayload.global_item_sku && !finalPayload.global_item_name && !finalPayload.item_name && !finalPayload.description && !finalPayload.pre_order && !finalPayload.weight && !finalPayload.attribute_list && !finalPayload.image?.image_id_list?.length) {
      return { ok: false, error: 'v2_degraded_payload_empty', message: 'All requested fields were blocked by probe preflight.' };
    }
    const response = await executeLoggedMutation(action, r, finalPayload, body, payload =>
      merchantApiCall(r, '/api/v2/global_product/update_global_item', { method: 'POST', body: payload, account_key: accountKey })
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
      .filter((m: any) => Number.isFinite(m.global_model_id) && m.global_model_id > 0 && m.global_model_sku);
    if (!global_item_id) return { ok: false, error: 'global_item_id required' };
    if (cleaned.length === 0) return { ok: false, error: 'global_model[] required (global_model_id + global_model_sku, plus optional weight)' };

    const requestPayload = { global_item_id, global_model: cleaned };
    const preflight = await enforceV2ProbePreflight(action, requestPayload, body);
    if (!preflight.ok) return { ok: false, ...preflight };
    const finalPayload = {
      ...preflight.requestPayload,
      global_model: (preflight.requestPayload.global_model || [])
        .filter((m: any) => m.global_model_sku),
    };
    if (!finalPayload.global_model.length) {
      return { ok: false, error: 'v2_degraded_payload_empty', message: 'All requested model fields were blocked by probe preflight.' };
    }
    const response = await executeLoggedMutation(action, r, finalPayload, body, payload =>
      merchantApiCall(r, '/api/v2/global_product/update_global_model', { method: 'POST', body: payload, account_key: accountKey })
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
      merchantApiCall(r, '/api/v2/global_product/update_price', { method: 'POST', body: payload, account_key: accountKey })
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
      merchantApiCall(r, '/api/v2/global_product/set_sync_field', { method: 'POST', body: payload, account_key: accountKey })
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
      shopApiCall(r, '/api/v2/product/update_item', { method: 'POST', body: payload, account_key: accountKey })
    );
    return { ...response, item_id, sent_item_name: item_name };
  }

  if (action === 'update_shop_item_description') {
    const item_id = parseInt(body.item_id || body.shop_item_id);
    const description = sanitizeShopeePlainTextDescription(body.description);
    if (!item_id) return { ok: false, error: 'shop_item_id required' };
    if (!description) return { ok: false, error: 'description required' };
    // Official local doc: C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.update_item.json
    const requestPayload = { item_id, description };
    const response = await executeLoggedMutation(action, r, requestPayload, body, payload =>
      shopApiCall(r, '/api/v2/product/update_item', { method: 'POST', body: payload, account_key: accountKey })
    );
    return { ...response, item_id, sent_description_length: description.length };
  }

  if (action === 'init_shop_tier_variation') {
    const item_id = parseInt(body.item_id || body.shop_item_id);
    if (!item_id) return { ok: false, error: 'shop_item_id required' };

    let variation: any = null;
    try {
      variation = normalizeVariation(body.variation);
    } catch (e: any) {
      return { ok: false, stage: 'variation_preflight', error: 'invalid_variation', message: String(e?.message || e) };
    }
    if (!variation) return { ok: false, error: 'variation required' };

    const standardise_tier_variation = buildStandardiseTierVariation(variation.tier_variation);
    const model = variation.model.map((m: any) => {
      const stock = Number(m?.seller_stock?.[0]?.stock ?? m?.stock ?? body.stock ?? 0);
      const entry: Record<string, any> = {
        tier_index: Array.isArray(m?.tier_index) ? m.tier_index.map((v: any) => Number(v)) : [],
        model_sku: String(m?.model_sku || m?.global_model_sku || '').trim(),
        original_price: Number(m?.original_price ?? body.price ?? 0),
        seller_stock: [{ stock }],
      };
      if (m?.weight_g != null && Number(m.weight_g) > 0) entry.weight = Number(m.weight_g) / 1000;
      else if (m?.weight != null && Number(m.weight) > 0) entry.weight = Number(m.weight);
      return entry;
    }).filter((m: any) => (
      Array.isArray(m.tier_index)
      && m.tier_index.every((v: any) => Number.isFinite(v))
      && m.model_sku
      && Number.isFinite(m.original_price)
    ));
    if (!standardise_tier_variation.length) return { ok: false, error: 'standardise_tier_variation[] required' };
    if (!model.length) return { ok: false, error: 'model[] required (tier_index + model_sku + original_price)' };

    const requestPayload: Record<string, any> = { item_id, standardise_tier_variation, model };

    // Official local doc:
    // C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.init_tier_variation.json
    const response = await executeLoggedMutation(action, r, requestPayload, body, payload =>
      shopApiCall(r, '/api/v2/product/init_tier_variation', { method: 'POST', body: payload, account_key: accountKey })
    );
    let mapping_results: any = null;
    if (response?.ok) {
      try {
        const shopModelsResult = await shopApiCall(r, '/api/v2/product/get_model_list', { query: { item_id }, account_key: accountKey });
        const shopModels = Array.isArray(shopModelsResult?.response?.model) ? shopModelsResult.response.model : [];
        const mappingRows = variation.model.map((sourceModel: any) => {
          const sku = shopeeModelSkuForMapping(sourceModel);
          const tierKey = shopeeTierKeyForMapping(sourceModel);
          const shopModel = shopModels.find((m: any) => shopeeSkuEquals(m?.model_sku, sku))
            || shopModels.find((m: any) => shopeeTierKeyForMapping(m) === tierKey)
            || {};
          return {
            product_id: sourceModel?.product_id || sourceModel?.productId || body.product_id || body.productId || null,
            sku,
            model_sku: sku,
            shopee_global_model_sku: sku,
            account_key: accountKey,
            region: r,
            shop_id: body.shop_id || null,
            shop_item_id: item_id,
            shop_model_id: numberOrNull(shopModel?.model_id || shopModel?.shop_model_id),
            status: 'mapped',
            raw_payload: { source: 'product.init_tier_variation', raw: response.result || response, shop_model: shopModel },
          };
        }).filter((row: any) => row.sku);
        mapping_results = await persistShopeeRegistrationMappings(accountKey, mappingRows);
      } catch (e: any) {
        mapping_results = { ok: false, error: String(e?.message || e) };
      }
    }
    return {
      ...response,
      item_id,
      mapping_results,
      sent_model_count: model.length,
      sent_tier_count: standardise_tier_variation.length,
      tier_payload_kind: 'standardise_tier_variation',
    };
  }

  if (action === 'update_shop_tier_variation') {
    const item_id = parseInt(body.item_id || body.shop_item_id);
    if (!item_id) return { ok: false, error: 'shop_item_id required' };

    const modelSource = Array.isArray(body.model_list)
      ? body.model_list
      : (Array.isArray(body.model) ? body.model : []);
    const model_list = modelSource
      .map((m: any) => ({
        model_id: parseInt(m?.model_id),
        tier_index: Array.isArray(m?.tier_index) ? m.tier_index.map((v: any) => Number(v)) : [],
      }))
      .filter((m: any) => (
        Number.isFinite(m.model_id)
        && m.model_id > 0
        && Array.isArray(m.tier_index)
        && m.tier_index.every((v: any) => Number.isFinite(v))
      ));

    const standardiseSource = Array.isArray(body.standardise_tier_variation) ? body.standardise_tier_variation : [];
    const standardise_tier_variation = standardiseSource
      .map((tier: any) => {
        const out: Record<string, any> = {
          variation_id: Number(tier?.variation_id),
          variation_option_list: Array.isArray(tier?.variation_option_list)
            ? tier.variation_option_list.map((option: any) => {
              const next: Record<string, any> = {
                variation_option_id: Number(option?.variation_option_id),
                variation_option_name: String(option?.variation_option_name || '').trim(),
              };
              const imageId = String(option?.image_id || option?.image?.image_id || '').trim();
              if (imageId) next.image_id = imageId;
              return next;
            }).filter((option: any) => (
              Number.isFinite(option.variation_option_id)
              && option.variation_option_id >= 0
              && option.variation_option_name
            ))
            : [],
        };
        const variationName = String(tier?.variation_name || tier?.name || '').trim();
        if (variationName) out.variation_name = variationName;
        const variationGroupId = Number(tier?.variation_group_id);
        if (Number.isFinite(variationGroupId) && variationGroupId >= 0) out.variation_group_id = variationGroupId;
        return out;
      })
      .filter((tier: any) => (
        Number.isFinite(tier.variation_id)
        && tier.variation_id >= 0
        && Array.isArray(tier.variation_option_list)
        && tier.variation_option_list.length
      ));

    if (!model_list.length) return { ok: false, error: 'model_list[] required (model_id + tier_index)' };
    if (!standardise_tier_variation.length) {
      return { ok: false, error: 'standardise_tier_variation[] required' };
    }

    const requestPayload: Record<string, any> = { item_id, model_list, standardise_tier_variation };

    // Official local doc:
    // C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.update_tier_variation.json
    const response = await executeLoggedMutation(action, r, requestPayload, body, payload =>
      shopApiCall(r, '/api/v2/product/update_tier_variation', { method: 'POST', body: payload, account_key: accountKey })
    );
    return {
      ...response,
      item_id,
      sent_model_count: model_list.length,
      sent_tier_count: standardise_tier_variation.length,
      tier_payload_kind: 'standardise_tier_variation',
    };
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
    shopApiCall(r, '/api/v2/product/update_item', { method: 'POST', body: payload, account_key: accountKey })
  );
  return { ...response, item_id, sent_days_to_ship: days_to_ship };
}

function clampDaysToShip(v: unknown): number {
  const n = Number(v);
  return Math.max(1, Math.min(150, Number.isFinite(n) ? n : 2));
}

// Per Shopee UI/docs: Ready Stock DTS valid range is 1-10 (per Global SKU
// frame_016 observation); Pre-Order DTS valid range is 3-150 (per Shop SKU
// frame_020 observation). Global Product DTS follows lifecycle-specific fixed values
// by current lifecycle:
//   - Ready Stock Global: force 1
//   - Pre-Order Global: force 10
//   - Pre-Order Region: clamp 3-150 (region max)
function clampReadyStockDts(v: unknown): number {
  const n = Number(v);
  return Math.max(1, Math.min(10, Number.isFinite(n) ? n : 2));
}
function clampPreOrderRegionDts(v: unknown): number {
  const n = Number(v);
  return Math.max(3, Math.min(150, Number.isFinite(n) ? n : 10));
}
const READY_STOCK_GLOBAL_DTS = 1;
const PRE_ORDER_GLOBAL_DTS = 10;

function resolveGlobalProductDts(body: any = {}): number {
  const isPreOrder = body.is_pre_order === true || body.lifecycle_state === 'pre_order';
  return isPreOrder ? PRE_ORDER_GLOBAL_DTS : READY_STOCK_GLOBAL_DTS;
}

function sanitizeShopeePlainTextDescription(value: unknown): string {
  const raw = String(value || '');
  return raw
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h[1-6]|section|article|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/🟣/gu, '[Product]')
    .replace(/💿/gu, '[Official Album]')
    .replace(/📊/gu, '[Chart Certified]')
    .replace(/📦/gu, '[Shipping]')
    .replace(/📌/gu, '[Contents]')
    .replace(/⚠️?/gu, '[Important Notice]')
    .replace(/💳/gu, '[COD Policy]')
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
    .replace(/\uFE0F/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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

function hasShopeeProductImageInput(body: any) {
  return stringArray(body?.image?.image_id_list || body?.image_id_list).length > 0
    || stringArray(body?.image?.image_url_list || body?.image_url_list).length > 0
    || !!String(body?.image_id || body?.image_url || '').trim();
}

function registerModelStock(model: any, fallbackStock: number) {
  return Math.floor(Number(model?.seller_stock?.[0]?.stock ?? model?.stock ?? fallbackStock ?? 0));
}

function registerModelPrice(model: any, fallbackPrice: number) {
  return Number(model?.global_original_price ?? model?.original_price ?? fallbackPrice ?? 0);
}

function shopeeModelPriceRatioLimitForRegion(region: any) {
  const key = String(region || '').toUpperCase();
  const limit = SHOPEE_REGION_MODEL_PRICE_RATIO_LIMITS[key];
  return Number.isFinite(limit) && limit > 0 ? limit : SHOPEE_DEFAULT_MODEL_PRICE_RATIO_LIMIT;
}

function shopeeStrictestModelPriceRatioLimit(targets: any[] = []) {
  const regions = new Set(targets.map((target: any) => String(target?.region || '').toUpperCase()).filter(Boolean));
  let limit = SHOPEE_DEFAULT_MODEL_PRICE_RATIO_LIMIT;
  for (const region of regions) limit = Math.min(limit, shopeeModelPriceRatioLimitForRegion(region));
  return limit;
}

function normalizeRegionalGlobalModelPriceRatio(body: any, targets: any[] = []) {
  const safeRatioLimit = shopeeStrictestModelPriceRatioLimit(targets);
  const targetRegions = Array.from(new Set(targets.map((target: any) => String(target?.region || '').toUpperCase()).filter(Boolean)));
  const targetsHaveRegionVariation = targets.some((target: any) => {
    try {
      return !!normalizeVariation(target?.variation);
    } catch (_) {
      return false;
    }
  });
  const models = Array.isArray(body?.variation?.model) ? body.variation.model : [];
  if (models.length < 2) return [];
  const rows = models
    .map((model: any, index: number) => ({
      model,
      index,
      sku: String(model?.global_model_sku || model?.model_sku || `model-${index + 1}`).trim(),
      price: registerModelPrice(model, Number(body.global_price ?? body.price ?? targets[0]?.price ?? 0)),
    }))
    .filter((row: any) => Number.isFinite(row.price) && row.price > 0);
  if (rows.length < 2) return [];
  const maxPrice = Math.max(...rows.map((row: any) => row.price));
  const minPrice = Math.min(...rows.map((row: any) => row.price));
  if (!(maxPrice > 0) || !(minPrice > 0) || maxPrice / minPrice < safeRatioLimit) return [];

  const safeMinimum = Math.floor(maxPrice / safeRatioLimit) + 1;
  const adjustments: any[] = [];
  for (const row of rows) {
    if (row.price >= safeMinimum) continue;
    row.model.global_original_price = safeMinimum;
    if (!targetsHaveRegionVariation) row.model.original_price = safeMinimum;
    adjustments.push({
      regions: targetRegions,
      sku: row.sku,
      from: row.price,
      to: safeMinimum,
      min_price: minPrice,
      max_price: maxPrice,
      ratio: Number((maxPrice / minPrice).toFixed(4)),
      safe_ratio: safeRatioLimit,
    });
  }
  return adjustments;
}

function normalizeRegionalTargetModelPriceRatio(targets: any[] = []) {
  const adjustments: any[] = [];
  for (const target of targets) {
    const targetRegion = String(target?.region || '').toUpperCase();
    if (!targetRegion) continue;
    const safeRatioLimit = shopeeModelPriceRatioLimitForRegion(targetRegion);
    let normalized: any = null;
    try {
      normalized = normalizeVariation(target?.variation);
    } catch (_) {
      continue;
    }
    const models = Array.isArray(normalized?.model) ? normalized.model : [];
    if (models.length < 2) continue;
    const fallbackPrice = Number(target?.price ?? 0);
    const rows = models
      .map((model: any, index: number) => ({
        model,
        index,
        sku: String(model?.model_sku || model?.global_model_sku || `model-${index + 1}`).trim(),
        price: Number(model?.original_price ?? fallbackPrice),
      }))
      .filter((row: any) => Number.isFinite(row.price) && row.price > 0);
    if (rows.length < 2) continue;
    const maxPrice = Math.max(...rows.map((row: any) => row.price));
    const minPrice = Math.min(...rows.map((row: any) => row.price));
    if (!(maxPrice > 0) || !(minPrice > 0) || maxPrice / minPrice < safeRatioLimit) continue;

    const safeMinimum = Number((Math.ceil(((maxPrice / safeRatioLimit) + 0.000001) * 100) / 100).toFixed(2));
    for (const row of rows) {
      if (row.price >= safeMinimum) continue;
      row.model.original_price = safeMinimum;
      adjustments.push({
        region: targetRegion,
        sku: row.sku,
        from: row.price,
        to: safeMinimum,
        min_price: minPrice,
        max_price: maxPrice,
        ratio: Number((maxPrice / minPrice).toFixed(4)),
        safe_ratio: safeRatioLimit,
      });
    }
  }
  return adjustments;
}

function validateRegisterStockInput(body: any, normalizedVariation: any, targets: any[] = []) {
  const fallbackStock = Number(body.stock ?? targets[0]?.stock ?? 0);
  if (normalizedVariation?.model?.length) {
    const invalid = normalizedVariation.model
      .map((model: any, index: number) => ({
        sku: String(model?.global_model_sku || model?.model_sku || `model ${index + 1}`).trim(),
        stock: registerModelStock(model, fallbackStock),
      }))
      .filter((row: any) => !Number.isFinite(row.stock) || row.stock < 1);
    if (invalid.length) {
      return `Shopee registration requires option stock >= 1: ${invalid.slice(0, 5).map((row: any) => row.sku).join(', ')}`;
    }
    return '';
  }
  if (!Number.isFinite(fallbackStock) || Math.floor(fallbackStock) < 1) {
    return 'Shopee registration requires stock >= 1.';
  }
  return '';
}

function validateRegisterPriceInput(body: any, normalizedVariation: any, targets: any[] = []) {
  const fallbackPrice = Number(body.global_price ?? body.price ?? targets[0]?.price ?? 0);
  if (normalizedVariation?.model?.length) {
    const invalid = normalizedVariation.model
      .map((model: any, index: number) => ({
        sku: String(model?.global_model_sku || model?.model_sku || `model ${index + 1}`).trim(),
        price: registerModelPrice(model, fallbackPrice),
      }))
      .filter((row: any) => !Number.isFinite(row.price) || row.price <= 0);
    if (invalid.length) {
      return `Shopee registration requires option price > 0: ${invalid.slice(0, 5).map((row: any) => row.sku).join(', ')}`;
    }
    return '';
  }
  if (!Number.isFinite(fallbackPrice) || fallbackPrice <= 0) {
    return 'Shopee registration requires price > 0.';
  }
  return '';
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

function validateVariationTierIndexes(tier_variation: any[], model: any[]) {
  if (!tier_variation.length || !model.length) return;
  model.forEach((m: any) => {
    const tierIndex = Array.isArray(m?.tier_index) ? m.tier_index.map((x: any) => Number(x)) : [];
    const display = `[${tierIndex.join(' ')}]`;
    if (tierIndex.length !== tier_variation.length) {
      throw new Error(`tier_index length mismatch for model in position ${display}: expected ${tier_variation.length}, got ${tierIndex.length}`);
    }
    tierIndex.forEach((idx: number, axisIndex: number) => {
      const optionCount = Array.isArray(tier_variation[axisIndex]?.option_list)
        ? tier_variation[axisIndex].option_list.length
        : 0;
      if (!Number.isInteger(idx) || idx < 0 || idx >= optionCount) {
        throw new Error(`tier_index out of range for model in position ${display}: axis ${axisIndex} has ${optionCount} options`);
      }
    });
  });
}

function normalizeVariation(variation: any) {
  const tier_variation = normalizeTierVariation(variation);
  const model = Array.isArray(variation?.model) ? variation.model : [];
  if (!tier_variation.length || !model.length) return null;
  if (tier_variation.length > 2) throw new Error('variation tiers must be <= 2');
  if (model.length > 50) throw new Error('variation combinations must be <= 50');
  validateVariationTierIndexes(tier_variation, model);
  return { tier_variation, model };
}

function buildStandardiseTierVariation(tierVariation: any[]) {
  if (!Array.isArray(tierVariation) || !tierVariation.length) return [];
  return tierVariation.map((tier: any, tierIndex: number) => {
    const variation: any = {
      variation_id: tierIndex,
      variation_name: String(tier?.name || `Variation ${tierIndex + 1}`).trim(),
      variation_option_list: [],
    };
    const options = Array.isArray(tier?.option_list) ? tier.option_list : [];
    variation.variation_option_list = options.map((option: any, optionIndex: number) => {
      const entry: any = {
        variation_option_id: optionIndex,
        variation_option_name: String(option?.option || '').trim(),
      };
      if (option?.image?.image_id) entry.image_id = String(option.image.image_id);
      return entry;
    }).filter((option: any) => option.variation_option_name);
    return variation;
  }).filter((tier: any) => tier.variation_name && tier.variation_option_list.length);
}

// buildGlobalModels — v44: migrated from normal_stock (sunset 2024-10-23) to seller_stock.
// Also adds optional per-model weight (float, kg) and per-option image fields when provided.
// Probe gate flags (probe_per_model_weight_ok / probe_per_option_image_ok) are checked at the
// UI layer before calling register_cbsc; bridge always sends what it receives.
function buildGlobalModels(variation: any, fallbackPrice: number, fallbackStock: number) {
  const normalized = normalizeVariation(variation);
  if (!normalized) return [];
  return normalized.model.map((m: any) => {
    const stock = Number(m?.seller_stock?.[0]?.stock ?? m?.stock ?? fallbackStock ?? 0);
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
  if (model?.weight_g != null && Number(model.weight_g) > 0) {
    out.weight = Number(model.weight_g) / 1000;
  } else if (model?.weight != null && Number(model.weight) > 0) {
    out.weight = Number(model.weight);
  }
  if (model?.image_id) out.image_id = String(model.image_id);
  return out;
}

function buildAddGlobalModelPayload(global_item_id: number, models: any[], body: any = {}, target: any = {}) {
  const payload: any = {
    global_item_id,
    global_model: models.map(normalizeGlobalModelForAdd),
    days_to_ship: resolveGlobalProductDts(body),
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
  return {
    global_item_name: body.name,
    description: sanitizeShopeePlainTextDescription(body.description) || `${body.name}\n\nK-POP Official Merchandise. Ready stock.`,
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
    pre_order: { days_to_ship: resolveGlobalProductDts(body) },
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

function flattenGlobalAttributes(raw: any, region = ''): GlobalAttr[] {
  const src = raw?.response || raw || {};
  const regionCode = String(region || '').toUpperCase();
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
    const mandatoryRegions = Array.isArray(node?.attribute_info?.mandatory_region)
      ? node.attribute_info.mandatory_region.map((r: any) => String(r || '').toUpperCase())
      : [];
    const mandatory = !!(node.is_mandatory ?? node.mandatory ?? node.required)
      || (!!regionCode && mandatoryRegions.includes(regionCode));
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

function pickOptionForExistingValue(options: AttrOption[], valueName: string): AttrOption | null {
  const normalized = String(valueName || '').trim().toLowerCase();
  if (!normalized) return null;
  const keywords = [normalized];
  if (normalized.includes('south korea') || normalized === 'kr') keywords.push('korea');
  if (normalized === 'no') keywords.push('not applicable', 'n/a', 'na');
  return pickOptionByKeywords(options, keywords);
}

function normalizeAttributeList(input: any[]): any[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((a: any) => {
      const valueList = (Array.isArray(a?.attribute_value_list) ? a.attribute_value_list : [])
        .map((v: any) => {
          const rawValueId = Number(v?.value_id);
          const originalValueName = String(v?.original_value_name || v?.display_value_name || v?.value_name || v?.name || '').trim();
          const entry: any = {};
          if (Number.isFinite(rawValueId) && rawValueId >= 0) entry.value_id = rawValueId;
          else if (originalValueName) entry.value_id = 0;
          if (originalValueName) entry.original_value_name = originalValueName;
          if (v?.value_unit) entry.value_unit = String(v.value_unit);
          return entry;
        })
        .filter((v: any) => Number.isFinite(Number(v.value_id)));
      return {
        attribute_id: Number(a?.attribute_id),
        attribute_value_list: valueList,
      };
    })
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

async function buildCategoryAttributeList(region: string, categoryId: number, inputAttrs: any[], accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const normalized = normalizeAttributeList(inputAttrs);
  const byId = new Map<number, any>();
  normalized.forEach((a) => byId.set(Number(a.attribute_id), a));
  // Shopee Open Platform docs reference get_mtsku_attribute_tree with category_ids list
  // (sandbox path returns 404 in production — verified 2026-05-21). On the production
  // partner endpoint the correct path is /get_attribute_tree but the parameter must be
  // category_id_list (CSV/array), not category_id. Single-value category_id returns
  // an empty response{}; passing the list form fills attribute_list correctly.
  const attrTreeRes = await merchantApiCall(region, '/api/v2/global_product/get_attribute_tree', { query: { category_id_list: String(categoryId), language: 'en' }, account_key: accountKey });
  const treeAttrs = flattenGlobalAttributes(attrTreeRes, region);
  const missing: any[] = [];
  for (const attr of treeAttrs) {
    const existing = byId.get(attr.attribute_id);
    if (!existing || !Array.isArray(existing.attribute_value_list) || !attr.options?.length) continue;
    const patchedValues = existing.attribute_value_list.map((value: any) => {
      const valueId = Number(value?.value_id);
      if (Number.isFinite(valueId) && valueId > 0) return value;
      const valueName = String(value?.original_value_name || value?.display_value_name || value?.value_name || value?.name || '').trim();
      const picked = pickOptionForExistingValue(attr.options, valueName);
      if (!picked?.value_id) return value;
      return {
        value_id: Number(picked.value_id),
        original_value_name: picked.original_value_name || picked.display_value_name || picked.value_name || valueName,
        ...(value?.value_unit ? { value_unit: String(value.value_unit) } : {}),
      };
    });
    byId.set(attr.attribute_id, { ...existing, attribute_value_list: patchedValues });
  }
  for (const attr of treeAttrs.filter((a) => a.is_mandatory)) {
    const existing = byId.get(attr.attribute_id);
    const hasValue = !!(existing && Array.isArray(existing.attribute_value_list) && existing.attribute_value_list.length > 0);
    if (hasValue) continue;
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

async function buildCategoryAttributeListForRegions(baseRegion: string, regions: string[], categoryId: number, inputAttrs: any[], accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const uniqueRegions = Array.from(new Set([baseRegion, ...regions].map((x) => String(x || '').toUpperCase()).filter(Boolean)));
  let attributeList = normalizeAttributeList(inputAttrs);
  const missingByKey = new Map<string, any>();
  const attrTrees: any[] = [];
  for (const region of uniqueRegions) {
    const result = await buildCategoryAttributeList(region, categoryId, attributeList, accountKey);
    attrTrees.push({ region, raw: result.attr_tree_raw });
    attributeList = result.attribute_list;
    for (const missing of result.missing || []) {
      const key = `${missing.attribute_id || ''}:${missing.attribute_name || ''}`;
      missingByKey.set(key, { ...missing, region });
    }
    for (const attr of attributeList) {
      for (const key of Array.from(missingByKey.keys())) {
        if (key.startsWith(`${Number(attr.attribute_id)}:`)) missingByKey.delete(key);
      }
    }
  }
  return { attribute_list: attributeList, missing: Array.from(missingByKey.values()), attr_tree_raw: attrTrees };
}

async function getRegionShopId(region: string, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY): Promise<number> {
  const data = await getShopeeTokenRow(region, accountKey);
  const shopId = Number(data?.shop_id);
  if (!shopId) throw new Error(`no shop_id for account=${accountKey}, region ${region}`);
  return shopId;
}

async function getPublishLogistics(region: string, isPreOrder = false, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const result = await shopApiCall(region, '/api/v2/logistics/get_channel_list', { account_key: accountKey });
  const channels: any[] = result?.response?.logistics_channel_list || [];
  const pickId = (ch: any) => ch?.logistics_channel_id ?? ch?.logistic_id ?? ch?.channel_id ?? ch?.id;
  const pickName = (ch: any) => ch?.logistics_channel_name ?? ch?.logistic_name ?? ch?.name ?? `channel_${pickId(ch)}`;
  let enabled = channels.filter(ch => pickId(ch) != null && (ch.enabled ?? true));
  // Pre-order items can only use channels that explicitly support_pre_order=true.
  // (Verified 2026-05-22 — PH channel 48023 returned
  // "publish fail : channelID: 48023, msg:channel not support pre order".)
  if (isPreOrder) {
    enabled = enabled.filter(ch => ch.support_pre_order === true);
  }
  const deliveryOnly = enabled.filter((ch: any) => {
    const name = String(pickName(ch) || '').toLowerCase();
    return !isPickupOrLockerLogisticsName(name);
  });
  if (deliveryOnly.length) enabled = deliveryOnly;
  const out = enabled.map(ch => ({
    logistic_id: Number(pickId(ch)),
    logistic_name: String(pickName(ch)),
    enabled: true,
    is_free: false,
  }));
  return out.length ? out : [{ logistic_id: 80007, logistic_name: 'Default', enabled: true, is_free: false }];
}

function logisticsIdFrom(row: any): number {
  return Number(row?.logistics_channel_id ?? row?.logistic_id ?? row?.channel_id ?? row?.id);
}

function logisticsNameFrom(row: any): string {
  const id = logisticsIdFrom(row);
  return String(row?.logistics_channel_name ?? row?.logistic_name ?? row?.name ?? `channel_${id}`);
}

function isPickupOrLockerLogisticsName(name: string): boolean {
  return /(self\s*collection|self\s*collect|collection\s*points?|locker|pick[-\s]?up|xpress\s*collect)/i.test(String(name || ''));
}

function deliveryOnlyLogisticPatch(logistics: any[] = []) {
  const rows = (Array.isArray(logistics) ? logistics : [])
    .map((row: any) => {
      const logistic_id = logisticsIdFrom(row);
      if (!Number.isFinite(logistic_id) || logistic_id <= 0) return null;
      const logistic_name = logisticsNameFrom(row);
      const wasEnabled = row?.enabled !== false;
      const isPickup = isPickupOrLockerLogisticsName(logistic_name);
      const next: Record<string, unknown> = {
        logistic_id,
        enabled: wasEnabled && !isPickup,
        is_free: row?.is_free === true,
      };
      if (row?.shipping_fee !== undefined && row?.shipping_fee !== null && row?.shipping_fee !== '') {
        const shipping_fee = Number(row.shipping_fee);
        if (Number.isFinite(shipping_fee) && shipping_fee >= 0) next.shipping_fee = shipping_fee;
      }
      if (row?.size_id !== undefined && row?.size_id !== null && row?.size_id !== '') {
        const size_id = Number(row.size_id);
        if (Number.isFinite(size_id) && size_id >= 0) next.size_id = size_id;
      }
      return { next, wasEnabled, isPickup };
    })
    .filter(Boolean) as Array<{ next: Record<string, unknown>; wasEnabled: boolean; isPickup: boolean }>;
  const hasDeliveryEnabled = rows.some((row) => row.next.enabled === true);
  const changed = hasDeliveryEnabled && rows.some((row) => row.wasEnabled && row.isPickup);
  return {
    changed,
    reason: hasDeliveryEnabled ? null : 'no_delivery_channel_left_enabled',
    logistic_info: changed ? rows.map((row) => row.next) : [],
  };
}

async function repairPublishedItemLogisticsForGlobalItem(globalItemId: number, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY, lookupRegion = 'SG') {
  if (!globalItemId) return { ok: false, skipped: true, error: 'global_item_id required' };
  const publishedRes = await merchantApiCall(lookupRegion || 'SG', '/api/v2/global_product/get_published_list', { query: { global_item_id: globalItemId }, account_key: accountKey });
  const pubItems = Array.isArray(publishedRes?.response?.published_item) ? publishedRes.response.published_item : [];
  const repairs: any[] = [];
  await mapWithConcurrency(pubItems, 2, async (published: any) => {
    const itemId = Number(published?.item_id);
    const itemRegion = String(published?.shop_region || published?.region || '').toUpperCase();
    if (!itemId || !itemRegion) return;
    try {
      const infoRes = await shopApiCall(itemRegion, '/api/v2/product/get_item_base_info', { query: { item_id_list: itemId }, account_key: accountKey });
      const item = Array.isArray(infoRes?.response?.item_list) ? infoRes.response.item_list[0] : null;
      const patch = deliveryOnlyLogisticPatch(item?.logistic_info || item?.logistic || []);
      if (!patch.changed) {
        repairs.push({ ok: true, region: itemRegion, item_id: itemId, skipped: true, reason: patch.reason || 'already_delivery_only' });
        return;
      }
      const updateRes = await shopApiCall(itemRegion, '/api/v2/product/update_item', {
        method: 'POST',
        body: { item_id: itemId, logistic_info: patch.logistic_info },
        account_key: accountKey,
      });
      repairs.push({
        ok: !updateRes?.error,
        region: itemRegion,
        item_id: itemId,
        stage: 'repair_published_item_logistics',
        disabled_logistic_ids: patch.logistic_info.filter((row: any) => row.enabled === false).map((row: any) => row.logistic_id),
        kept_logistic_ids: patch.logistic_info.filter((row: any) => row.enabled === true).map((row: any) => row.logistic_id),
        error: updateRes?.error || null,
        message: updateRes?.message || null,
      });
    } catch (e: any) {
      repairs.push({ ok: false, region: itemRegion, item_id: itemId, stage: 'repair_published_item_logistics_exception', error: String(e?.message || e) });
    }
  });
  return { ok: repairs.every((row) => row.ok !== false), count: repairs.length, repairs };
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
  const description = sanitizeShopeePlainTextDescription(target.description ?? body.description)
    || `${body.name}\n\nK-POP Official Merchandise. Ready stock.`;
  const item: any = {
    item_name: body.name,
    description,
    item_status: body.item_status || 'NORMAL',
    original_price: price,
    image: imageBlockFrom(body),
    category_id: Number(body.category_id),
    logistic: logistics,
    logistic_info: logistics,
    pre_order: { is_pre_order: isPreOrder, days_to_ship: dts },
  };
  const attributeList = normalizeAttributeList(target.attribute_list || body.attribute_list);
  if (attributeList.length) item.attribute_list = attributeList;
  const publishVariation = normalizeVariation(target.variation || body.variation);
  if (publishVariation) {
    const standardiseTierVariation = buildStandardiseTierVariation(publishVariation.tier_variation);
    if (standardiseTierVariation.length) item.standardise_tier_variation = standardiseTierVariation;
    item.model = buildPublishModels(publishVariation, price);
  }
  return item;
}

function isPublishPending(task: any): boolean {
  const status = String(task?.response?.publish_status || task?.response?.status || task?.status || '');
  return /processing|pending|in_process|in progress/i.test(status);
}

function isTransientPublishTaskLookup(task: any): boolean {
  const text = `${task?.error || ''} ${task?.message || ''} ${task?.debug_message || ''}`.toLowerCase();
  return /task not found|cannot_get_publish_result|taking some time|system busy|try later|crossupload\.api error:partner does not have permission to operate shop/.test(text);
}

function isAmbiguousPublishFailure(task: any): boolean {
  const response = task?.response || {};
  const status = String(response.publish_status || response.status || '').toLowerCase();
  if (status !== 'failed') return false;
  const list = Array.isArray(response.publish_result) ? response.publish_result : [];
  const reasons = [
    response.failed?.failed_reason,
    response.failed?.message,
    response.failed?.error,
    ...list.flatMap((row: any) => [
      row?.failed?.failed_reason,
      row?.failed?.message,
      row?.failed?.error,
      row?.failed_reason,
      row?.message,
      row?.error,
    ]),
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const hasSuccess = !!(response.success?.item_id || list.some((row: any) => row?.success?.item_id || row?.item_id || row?.shop_item_id));
  return !hasSuccess && reasons.length === 0;
}

function shouldContinuePublishPolling(task: any): boolean {
  return isPublishPending(task) || isTransientPublishTaskLookup(task) || isAmbiguousPublishFailure(task);
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

async function verifyPublishedListOutcome(region: string, shopId: number, globalItemId: number, publishTaskId: number, task: any, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const retries = region === 'BR' ? 4 : ((region === 'TW') ? 4 : 3);
  const sleepMs = 5000;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) await new Promise(s => setTimeout(s, sleepMs));
    const verified = await verifyPublishedListOutcomeOnce(region, shopId, globalItemId, publishTaskId, task, accountKey, 'verified_via_published_list_retry_' + attempt);
    if (verified) return verified;
  }
  return null;
}

async function verifyPublishedListOutcomeOnce(region: string, shopId: number, globalItemId: number, publishTaskId: number, task: any, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY, status = 'verified_via_published_list') {
  const publishedRes = await merchantApiCall(region, '/api/v2/global_product/get_published_list', { query: { global_item_id: globalItemId, shop_id_list: String(shopId) }, account_key: accountKey });
  const pubItems = Array.isArray(publishedRes?.response?.published_item) ? publishedRes.response.published_item : [];
  const hit = pubItems.find((p: any) => Number(p.shop_id) === Number(shopId));
  if (hit && hit.item_id) {
    return {
      ok: true,
      region,
      global_item_id: globalItemId,
      shop_id: shopId,
      publish_task_id: publishTaskId,
      item_id: Number(hit.item_id),
      publish_status: status,
      error: null,
      task,
    };
  }
  return null;
}

async function reconcilePublishResultsWithPublishedList(globalItemId: number, targets: any[] = [], results: any[] = [], accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY, lookupRegion = 'SG', stageLogs?: string[]) {
  const requested = (targets || [])
    .map((target: any) => ({ target, region: String(target?.region || '').toUpperCase() }))
    .filter((row: any) => row.region);
  if (!globalItemId || !requested.length) return results;

  const byRegion = new Map<string, { row: any; index: number }>();
  (results || []).forEach((row: any, index: number) => {
    const region = String(row?.region || '').toUpperCase();
    if (region && !byRegion.has(region)) byRegion.set(region, { row, index });
  });
  const needsReconcile = requested.some(({ region }: any) => {
    const existing = byRegion.get(region)?.row;
    return !existing || !existing.ok || !existing.item_id;
  });
  if (!needsReconcile) return results;

  try {
    const shopIdsByRegion = new Map<string, number>();
    for (const { target, region } of requested) {
      const existing = byRegion.get(region)?.row;
      let shopId = Number(target?.shop_id || existing?.shop_id || 0);
      if (!shopId) {
        try { shopId = await getRegionShopId(region, accountKey); } catch (_) { shopId = 0; }
      }
      if (shopId) shopIdsByRegion.set(region, shopId);
    }
    const shopIds = uniquePositiveNumberList(Array.from(shopIdsByRegion.values()));
    const publishedQuery: Record<string, any> = { global_item_id: globalItemId };
    if (shopIds.length) publishedQuery.shop_id_list = shopIds.map((id) => String(id)).join(',');
    const publishedRes = await merchantApiCall(lookupRegion || 'SG', '/api/v2/global_product/get_published_list', { query: publishedQuery, account_key: accountKey });
    const pubItems = Array.isArray(publishedRes?.response?.published_item) ? publishedRes.response.published_item : [];
    if (!pubItems.length) return results;
    const next = (results || []).slice();
    for (const { target, region } of requested) {
      const existingInfo = byRegion.get(region);
      const existing = existingInfo?.row;
      if (existing?.ok && existing?.item_id) continue;
      let shopId = shopIdsByRegion.get(region) || Number(target?.shop_id || existing?.shop_id || 0);
      if (!shopId) {
        try { shopId = await getRegionShopId(region, accountKey); } catch (_) { shopId = 0; }
      }
      const hit = pubItems.find((item: any) =>
        (shopId && Number(item?.shop_id) === Number(shopId))
        || String(item?.shop_region || item?.region || '').toUpperCase() === region
      );
      if (!hit?.item_id) continue;
      const reconciled = {
        ...(existing || {}),
        ok: true,
        region,
        global_item_id: globalItemId,
        shop_id: Number(hit.shop_id || shopId || existing?.shop_id || 0) || null,
        item_id: Number(hit.item_id),
        publish_status: 'verified_via_final_published_list_reconcile',
        error: null,
        message: null,
        previous_result: existing || null,
      };
      if (existingInfo) next[existingInfo.index] = reconciled;
      else next.push(reconciled);
      if (stageLogs) stageLogs.push(`published_list_reconcile: ${region}:${hit.item_id}`);
    }
    return next;
  } catch (e: any) {
    if (stageLogs) stageLogs.push(`published_list_reconcile_failed: ${String(e?.message || e)}`);
    return results;
  }
}

async function verifyPublishedSkuOutcome(region: string, shopId: number, publishTaskId: number, task: any, sku: string, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const needle = shopeeSkuValue(sku);
  if (!needle) return null;
  const retries = (region === 'BR' || region === 'TW') ? 4 : 5;
  const sleepMs = 5000;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) await new Promise(s => setTimeout(s, sleepMs));
    const searchResult = await shopApiCall(region, '/api/v2/product/search_item', {
      query: { item_sku: needle, offset: 0, page_size: 20 },
      account_key: accountKey,
    });
    if (searchResult.error) continue;
    const searchIds = shopeeSearchItemIds(searchResult);
    const searched = await shopeeSkuHitFromItemIds(region, needle, searchIds, 'post_publish_search_item', shopId, accountKey);
    if (searched.hit?.shop_item_id) {
      return {
        ok: true,
        region,
        shop_id: shopId,
        publish_task_id: publishTaskId,
        item_id: Number(searched.hit.shop_item_id),
        publish_status: 'verified_via_sku_search_retry_' + attempt,
        error: null,
        task,
        sku_verification: searched.hit,
      };
    }
  }
  return null;
}

async function syncShopModelPricesAfterPublish(region: string, itemId: number, target: any, body: any, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const variation = normalizeVariation(target?.variation || body?.variation);
  const priceList: any[] = [];
  if (variation) {
    let modelsResult: any = null;
    let shopModels: any[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) await new Promise(s => setTimeout(s, 2000));
      modelsResult = await shopApiCall(region, '/api/v2/product/get_model_list', { query: { item_id: itemId }, account_key: accountKey });
      shopModels = Array.isArray(modelsResult?.response?.model) ? modelsResult.response.model : [];
      if (!modelsResult.error && shopModels.length) break;
    }
    if (modelsResult.error || !shopModels.length) {
      return { ok: false, stage: 'get_model_list', error: modelsResult.error || 'shop models not found', raw: modelsResult };
    }
    for (const sourceModel of variation.model) {
      const sku = String(sourceModel?.model_sku || sourceModel?.global_model_sku || '').trim();
      const tierKey = JSON.stringify(Array.isArray(sourceModel?.tier_index) ? sourceModel.tier_index.map((x: any) => Number(x)) : []);
      const shopModel = shopModels.find((m: any) => String(m?.model_sku || '').trim() === sku)
        || shopModels.find((m: any) => JSON.stringify(Array.isArray(m?.tier_index) ? m.tier_index.map((x: any) => Number(x)) : []) === tierKey);
      const price = Number(sourceModel?.original_price ?? target?.price ?? body?.price);
      const modelId = Number(shopModel?.model_id || 0);
      if (modelId > 0 && Number.isFinite(price) && price > 0) priceList.push({ model_id: modelId, original_price: price });
    }
  } else {
    const price = Number(target?.price ?? body?.price);
    if (Number.isFinite(price) && price > 0) priceList.push({ original_price: price });
  }
  if (!priceList.length) return { ok: false, stage: 'build_price_list', error: 'price_list empty' };
  const result = await shopApiCall(region, '/api/v2/product/update_price', { method: 'POST', body: { item_id: itemId, price_list: priceList }, account_key: accountKey });
  const failureList = Array.isArray(result?.response?.failure_list) ? result.response.failure_list : [];
  return { ok: !result.error && failureList.length === 0, sent_price_list: priceList, failure_list: failureList, raw: result };
}

function shopeeModelSkuForMapping(model: any): string {
  return String(model?.global_model_sku || model?.model_sku || model?.sku || '').trim();
}

function shopeeTierKeyForMapping(model: any): string {
  return JSON.stringify(Array.isArray(model?.tier_index) ? model.tier_index.map((x: any) => Number(x)) : []);
}

async function fetchShopeeModelMappingRowsForPublishedItem(region: string, itemId: number, target: any, body: any, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const variation = normalizeVariation(target?.variation || body?.variation);
  if (!variation || !Number.isFinite(itemId) || itemId <= 0) return [];

  const shopModelsResult = await shopApiCall(region, '/api/v2/product/get_model_list', {
    query: { item_id: itemId },
    account_key: accountKey,
  });
  const shopModels = Array.isArray(shopModelsResult?.response?.model) ? shopModelsResult.response.model : [];

  let globalModels: any[] = [];
  const globalItemId = Number(body?.global_item_id || target?.global_item_id || 0);
  if (Number.isFinite(globalItemId) && globalItemId > 0) {
    const globalModelsResult = await merchantApiCall(region, '/api/v2/global_product/get_global_model_list', {
      query: { global_item_id: globalItemId },
      account_key: accountKey,
    });
    globalModels = shopeeGlobalModelList(globalModelsResult);
  }

  return variation.model.map((sourceModel: any) => {
    const sku = shopeeModelSkuForMapping(sourceModel);
    const tierKey = shopeeTierKeyForMapping(sourceModel);
    const shopModel = shopModels.find((model: any) => shopeeSkuEquals(model?.model_sku, sku))
      || shopModels.find((model: any) => shopeeTierKeyForMapping(model) === tierKey)
      || {};
    const globalModel = globalModels.find((model: any) => shopeeSkuEquals(model?.global_model_sku || model?.model_sku, sku))
      || globalModels.find((model: any) => shopeeTierKeyForMapping(model) === tierKey)
      || {};
    return {
      sku,
      model_sku: sku,
      global_model_sku: sku,
      global_model_id: numberOrNull(sourceModel?.global_model_id) || numberOrNull(globalModel?.global_model_id || globalModel?.model_id),
      shop_model_id: numberOrNull(shopModel?.model_id || shopModel?.shop_model_id),
      raw_payload: {
        source: 'post_publish_model_mapping',
        shop_model: shopModel,
        global_model: globalModel,
      },
    };
  }).filter((row: any) => row.sku);
}

async function finalizePublishOutcomeAfterSuccess(outcome: any, region: string, target: any, body: any, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  if (!outcome?.ok || !outcome?.item_id) return outcome;
  if (outcome.price_sync?.ok) return outcome;
  try {
    outcome.price_sync = await syncShopModelPricesAfterPublish(region, Number(outcome.item_id), target, body, accountKey);
  } catch (e: any) {
    outcome.price_sync = { ok: false, stage: 'price_sync_exception', error: String(e?.message || e) };
  }
  if (outcome.price_sync?.ok === false) {
    const reason = outcome.price_sync.error || outcome.price_sync.stage || 'price sync failed';
    outcome.ok = false;
    outcome.stage = 'post_publish_price_sync';
    outcome.error = reason;
    outcome.price_sync_warning = reason;
  }
  try {
    const modelMappings = await fetchShopeeModelMappingRowsForPublishedItem(region, Number(outcome.item_id), target, body, accountKey);
    if (modelMappings.length) outcome.model_mappings = modelMappings;
  } catch (e: any) {
    outcome.model_mapping_warning = String(e?.message || e);
  }
  return outcome;
}

function shopeePublishResultMessage(info: any): string | null {
  const taskBody = info?.raw_task?.response || info?.task?.response || info?.raw_task || info?.task || {};
  const failedList = Array.isArray(taskBody.publish_result)
    ? taskBody.publish_result.filter((row: any) => row && (row.error || row.failed_reason || row.message))
    : [];
  const taskFailed = taskBody.failed || failedList[0];
  const failedReason = taskFailed?.failed_reason || taskFailed?.message || taskFailed?.error;
  const parts = [
    info?.error,
    info?.message,
    info?.stage ? `stage=${info.stage}` : '',
    failedReason ? `task_failed=${failedReason}` : '',
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return parts.length ? parts.join(' | ').slice(0, 1200) : null;
}

function shopeeRequestedRegionsFromPublishTargets(targets: any[] = [], results: any[] = [], fallbackRegion = 'SG'): string[] {
  const regions = [
    ...(targets || []).map((target: any) => target?.region),
    ...(results || []).map((row: any) => row?.region),
    fallbackRegion,
  ].map((value) => String(value || '').toUpperCase()).filter(Boolean);
  return [...new Set(regions)];
}

function buildShopeePublishMappingRows(globalItemId: number | null, body: any, targets: any[] = [], results: any[] = [], accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY, fallbackRegion = 'SG'): ShopeeRegistrationMappingInput[] {
  const variation = normalizeVariation(body?.variation);
  const variantModels = variation?.model || [];
  const resultByRegion = new Map<string, any>();
  for (const row of results || []) {
    const region = String(row?.region || '').toUpperCase();
    if (region && !resultByRegion.has(region)) resultByRegion.set(region, row);
  }
  const targetByRegion = new Map<string, any>();
  for (const target of targets || []) {
    const region = String(target?.region || '').toUpperCase();
    if (region && !targetByRegion.has(region)) targetByRegion.set(region, target);
  }

  const rows: ShopeeRegistrationMappingInput[] = [];
  const requestedRegions = shopeeRequestedRegionsFromPublishTargets(targets, results, fallbackRegion);
  for (const region of requestedRegions) {
    const info = resultByRegion.get(region) || { region, ok: false, error: 'no result from bridge', message: 'no result from bridge' };
    const target = targetByRegion.get(region) || {};
    const shopItemId = numberOrNull(info?.item_id ?? info?.shop_item_id);
    const rowGlobalItemId = Object.prototype.hasOwnProperty.call(info || {}, 'global_item_id')
      ? numberOrNull(info.global_item_id)
      : numberOrNull(globalItemId);
    const status = info?.ok === true && shopItemId ? 'mapped' : 'failed';
    const base = {
      account_key: accountKey,
      region,
      shop_id: numberOrNull(info?.shop_id || target?.shop_id),
      shop_item_id: shopItemId,
      global_item_id: rowGlobalItemId,
      status,
      last_error: status === 'mapped' ? null : shopeePublishResultMessage(info),
      days_to_ship: target?.days_to_ship || body?.days_to_ship || null,
      raw_payload: {
        source: 'bridge_publish_result',
        publish_result: info,
      },
    };
    if (variantModels.length) {
      const modelMappings = new Map<string, any>();
      for (const modelRow of info?.model_mappings || []) {
        const sku = shopeeModelSkuForMapping(modelRow);
        if (sku && !modelMappings.has(sku)) modelMappings.set(sku, modelRow);
      }
      for (const model of variantModels) {
        const sku = shopeeModelSkuForMapping(model);
        if (!sku) continue;
        const modelMapping = modelMappings.get(sku) || {};
        rows.push({
          ...base,
          product_id: model.product_id || model.productId || null,
          sku,
          model_sku: sku,
          global_model_sku: sku,
          shopee_global_model_sku: sku,
          global_model_id: numberOrNull(modelMapping.global_model_id) || numberOrNull(model.global_model_id),
          shop_model_id: numberOrNull(modelMapping.shop_model_id),
          raw_payload: {
            ...(base.raw_payload as any),
            source_model: model,
            model_mapping: modelMapping,
          },
        });
      }
      continue;
    }
    rows.push({
      ...base,
      product_id: body?.product_id || body?.productId || body?.source_product_id || body?.master_product_id || null,
      sku: body?.sku || body?.item_sku || null,
      item_sku: body?.sku || body?.item_sku || null,
    });
  }
  return rows;
}

function publishFailureText(...parts: any[]): string {
  return parts
    .map((part) => {
      if (!part) return '';
      if (typeof part === 'string') return part;
      try {
        return JSON.stringify(part);
      } catch (_) {
        return String(part);
      }
    })
    .join(' ')
    .toLowerCase();
}

function isVariationInvalidPublishFailure(...parts: any[]): boolean {
  const text = publishFailureText(...parts);
  return /variation/.test(text)
    && (/invalid/.test(text) || /current category/.test(text) || /under current category/.test(text));
}

function isVariationDuplicateNamePublishFailure(...parts: any[]): boolean {
  const text = publishFailureText(...parts);
  return /规格选项名称重复/.test(text)
    || /variation option name.*duplicate/.test(text)
    || /option name.*duplicate/.test(text)
    || /duplicate.*variation/.test(text);
}

function isCrossuploadPermissionPublishFailure(...parts: any[]): boolean {
  const text = publishFailureText(...parts);
  return /crossupload\.api error:partner does not have permission to operate shop/.test(text)
    || /partner does not have permission to operate shop/.test(text);
}

function isPriceRatioPublishFailure(...parts: any[]): boolean {
  const text = publishFailureText(...parts);
  return /most expensive sku.*cheapest sku.*limit/.test(text)
    || /price.*cheapest.*sku.*limit/.test(text)
    || /price[-_\s]?ratio/.test(text);
}

function isAmbiguousLocalPublishFailure(...parts: any[]): boolean {
  if (isPriceRatioPublishFailure(...parts)) return false;
  const text = publishFailureText(...parts);
  return /channel.*not available/.test(text)
    || /category.*invalid/.test(text)
    || /类别无效/.test(text)
    || /"failed_reason"\s*:\s*""/.test(text)
    || /publish fail(?:ed)?(?:\s|["':,}\]])/.test(text);
}

function hasOptionVariationPayload(target: any, body: any): boolean {
  const variation = target?.variation || body?.variation;
  return Array.isArray(variation?.tier_variation)
    && variation.tier_variation.length > 0
    && Array.isArray(variation?.model)
    && variation.model.length > 0;
}

function markBrOptionCrossuploadBlocked(outcome: any, task: any, publishRes: any, details: any = {}) {
  return {
    ...outcome,
    ok: false,
    error: 'BR_OPTION_CROSSUPLOAD_PERMISSION_BLOCKED',
    message: 'Shopee BR rejected direct CBSC option Global Product crossupload. The bridge will only retry the requested existing global_item_id; creating a replacement Global Product is intentionally disabled.',
    br_option_crossupload_blocked: true,
    new_global_fallback_suppressed: true,
    reuse_existing_global_item_only: true,
    retry_suppressed: !details?.minimal_item_retry,
    global_item_id: details?.global_item_id ?? outcome?.global_item_id ?? null,
    minimal_item_retry: details?.minimal_item_retry ?? outcome?.minimal_item_retry ?? null,
    raw_task: task || outcome?.raw_task || null,
    raw_create: publishRes || outcome?.raw_create || null,
  };
}

function shouldRetryMinimalPublish(...parts: any[]): boolean {
  return isVariationInvalidPublishFailure(...parts)
    || isVariationDuplicateNamePublishFailure(...parts)
    || isCrossuploadPermissionPublishFailure(...parts);
}

function shouldTryMinimalPublishFallback(...parts: any[]): boolean {
  return shouldRetryMinimalPublish(...parts)
    || isAmbiguousLocalPublishFailure(...parts);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const output: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(limit || 1), items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await worker(items[index], index);
    }
  }));
  return output;
}

async function retryMinimalPublish(globalItemId: number, shopId: number, target: any, body: any, logistics: any[], accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY, reason = 'minimal_publish_retry') {
  const region = String(target?.region || '').toUpperCase();
  const retryBody = { global_item_id: globalItemId, shop_id: shopId, shop_region: region, item: { logistic: logistics, logistic_info: logistics } };
  const retryCreate = await merchantApiCall(region, '/api/v2/global_product/create_publish_task', { method: 'POST', body: retryBody, account_key: accountKey });
  if (retryCreate.error || !retryCreate.response?.publish_task_id) {
    return { ok: false, region, shop_id: shopId, stage: 'minimal_publish_create', error: retryCreate.error || 'publish_task_id missing', message: retryCreate.message, raw_retry_create: retryCreate, minimal_retry_reason: reason };
  }
  const retryTaskId = Number(retryCreate.response.publish_task_id);
  let retryTask: any = null;
  let retryPollAttempts = 0;
  const maxPoll = 15;
  for (let i = 0; i < maxPoll; i += 1) {
    await new Promise(s => setTimeout(s, 2000));
    const taskRes = await merchantApiCall(region, '/api/v2/global_product/get_publish_task_result', { query: { publish_task_id: retryTaskId }, account_key: accountKey });
    retryTask = taskRes;
    retryPollAttempts = i + 1;
    if (!shouldContinuePublishPolling(taskRes)) break;
  }
  let retryOutcome: any = parsePublishOutcome(region, shopId, retryTaskId, retryTask);
  if (!retryOutcome.ok) {
    const verified = await verifyPublishedListOutcome(region, shopId, globalItemId, retryTaskId, retryTask, accountKey);
    if (verified) retryOutcome = verified;
  }
  if (!retryOutcome.ok) {
    const verified = await verifyPublishedSkuOutcome(region, shopId, retryTaskId, retryTask, body?.sku || target?.sku || '', accountKey);
    if (verified) retryOutcome = verified;
  }
  retryOutcome.minimal_item_retry = true;
  retryOutcome.minimal_retry_reason = reason;
  retryOutcome.raw_retry_create = retryCreate;
  retryOutcome.raw_retry_task = retryTask;
  retryOutcome.retry_poll_attempts = retryPollAttempts;
  if (retryOutcome.ok && retryOutcome.item_id) {
    try {
      retryOutcome.price_sync = await syncShopModelPricesAfterPublish(region, Number(retryOutcome.item_id), target, body, accountKey);
    } catch (e: any) {
      retryOutcome.price_sync = { ok: false, error: String(e?.message || e) };
    }
  }
  return retryOutcome;
}

async function publishBrOptionMinimalFirst(globalItemId: number, shopId: number, target: any, body: any, logistics: any[], accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const region = String(target?.region || '').toUpperCase();
  if (region !== 'BR' || !hasOptionVariationPayload(target, body)) return null;
  const minimalOutcome = await retryMinimalPublish(globalItemId, shopId, target, body, logistics, accountKey, 'br_option_minimal_first');
  if (minimalOutcome?.ok) {
    const finalized = await finalizePublishOutcomeAfterSuccess(minimalOutcome, region, target, body, accountKey);
    (finalized as any).br_option_minimal_first = true;
    return finalized;
  }
  const failed = {
    ...(minimalOutcome || {}),
    ok: false,
    region,
    shop_id: shopId,
    stage: minimalOutcome?.stage || 'br_option_minimal_first',
    br_option_minimal_first: true,
  };
  if (isCrossuploadPermissionPublishFailure(minimalOutcome, minimalOutcome?.raw_retry_create, minimalOutcome?.raw_retry_task)) {
    return markBrOptionCrossuploadBlocked(failed, minimalOutcome?.raw_retry_task || null, minimalOutcome?.raw_retry_create || null, {
      global_item_id: globalItemId,
      minimal_item_retry: minimalOutcome,
    });
  }
  return failed;
}

function variationModelStock(model: any, fallback = 0): number {
  const stock = Number(model?.seller_stock?.[0]?.stock ?? model?.stock ?? model?.normal_stock ?? fallback ?? 0);
  return Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : 0;
}

function variationModelGlobalPrice(model: any, fallback = 0): number {
  const price = Number(model?.global_original_price ?? model?.global_price ?? model?.original_price ?? fallback ?? 0);
  return Number.isFinite(price) && price > 0 ? price : Number(fallback || 0);
}

function variationModelTargetPrice(model: any, fallback = 0): number {
  const price = Number(model?.original_price ?? model?.price ?? fallback ?? 0);
  return Number.isFinite(price) && price > 0 ? price : Number(fallback || 0);
}

async function retryTwMinimalPublish(globalItemId: number, shopId: number, target: any, body: any, logistics: any[], accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const region = String(target?.region || '').toUpperCase();
  if (region !== 'TW') return null;
  const retryOutcome = await retryMinimalPublish(globalItemId, shopId, target, body, logistics, accountKey, 'tw_minimal_publish_retry');
  if (retryOutcome) retryOutcome.tw_minimal_item_retry = true;
  return retryOutcome;
}

// /list_items ??paginated get_item_list + batch get_item_base_info + per-item get_model_list (when has_model=true).
async function listItemsForRegion(region: string, item_status = 'NORMAL', max_items = 5000, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
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
    const r = await shopApiCall(region, '/api/v2/product/get_item_list', { query: { offset, page_size: 100, item_status }, account_key: accountKey });
    if (r.error) {
      if (page === 0 && /invalid|not_support|item_status/i.test(`${r.error} ${r.message || ''}`)) {
        const r2 = await shopApiCall(region, '/api/v2/product/get_item_list', { query: { offset: 0, page_size: 100 }, account_key: accountKey });
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
    const info = await shopApiCall(region, '/api/v2/product/get_item_base_info', { query: { item_id_list: ids }, account_key: accountKey });
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
        const r = await shopApiCall(region, '/api/v2/product/get_model_list', { query: { item_id: b.item_id }, account_key: accountKey });
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

const SHOPEE_SKU_LOOKUP_STATUSES = ['NORMAL', 'UNLIST'];

function shopeeSkuValue(value: unknown): string {
  return String(value ?? '').trim();
}

function shopeeSkuEquals(left: unknown, right: unknown): boolean {
  return shopeeSkuValue(left) === shopeeSkuValue(right);
}

function shopeeListedStatus(status: unknown): boolean {
  const value = String(status || '').toUpperCase();
  return !value || SHOPEE_SKU_LOOKUP_STATUSES.includes(value);
}

function shopeeLookupError(stage: string, raw: any): string {
  return `${stage}: ${raw?.error || 'error'} ${raw?.message || ''}`.trim();
}

function shopeeSkuLookupNameTerms(values: unknown[]): string[] {
  const out: string[] = [];
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const stripLifecycle = (value: string) => normalize(value.replace(/\b(PRE\s*[- ]?\s*ORDER|READY\s+STOCK)\b/ig, ' '));
  const push = (value: unknown) => {
    const raw = normalize(String(value ?? ''));
    if (!raw || raw.length < 3) return;
    const bracketContents = [...raw.matchAll(/\[([^\]]+)\]/g)]
      .map((match) => normalize(match[1] || ''))
      .filter((part) => part && !/^(PRE\s*[- ]?\s*ORDER|READY\s+STOCK)$/i.test(part));
    const afterLastBracket = raw.includes(']') ? normalize(raw.slice(raw.lastIndexOf(']') + 1)) : '';
    const bracketText = normalize(raw.replace(/[\[\]]/g, ' '));
    const variants = [
      raw,
      stripLifecycle(raw.replace(/\[\s*(PRE\s*[- ]?\s*ORDER|READY\s+STOCK)\s*\]/ig, ' ')),
      bracketText,
      stripLifecycle(bracketText),
      normalize(raw.replace(/\[[^\]]+\]/g, ' ')),
      stripLifecycle(bracketText.replace(/&/g, ' ')),
      stripLifecycle(bracketText.replace(/&\s*TEAM/ig, 'ANDTEAM').replace(/&/g, 'AND ')),
      ...bracketContents.map((part) => normalize([part, afterLastBracket].filter(Boolean).join(' '))),
    ];
    for (const term of variants) {
      if (term.length < 3) continue;
      const key = term.toLowerCase();
      if (!out.some((existing) => existing.toLowerCase() === key)) out.push(term);
    }
  };
  for (const value of values) push(value);
  return out.slice(0, 10);
}

function shopeeSearchItemIds(raw: any): number[] {
  const response = raw?.response || raw || {};
  const list =
    (Array.isArray(response.item_id_list) && response.item_id_list) ||
    (Array.isArray(response.item_list) && response.item_list) ||
    (Array.isArray(response.item) && response.item) ||
    [];
  return [...new Set(list
    .map((entry: any) => Number(entry?.item_id ?? entry))
    .filter((id: number) => Number.isFinite(id) && id > 0))];
}

function shopeeSkuLookupHit(region: string, sku: string, item: any, model: any, source: string, shopId: number | null) {
  const itemId = Number(item?.item_id || item?.shop_item_id || 0);
  const modelId = Number(model?.model_id || model?.shop_model_id || 0);
  const status = String(item?.item_status || item?.status || '').toUpperCase();
  return {
    region,
    sku,
    shop_id: shopId || null,
    shop_item_id: itemId || null,
    shop_model_id: modelId || null,
    global_item_id: null,
    item_status: status || null,
    item_sku: shopeeSkuValue(item?.item_sku),
    model_sku: model ? shopeeSkuValue(model?.model_sku) : null,
    base_sku: model ? shopeeSkuValue(item?.item_sku) : null,
    match_type: modelId ? 'model_sku' : 'item_sku',
    lookup_source: source,
  };
}

function shopeeGlobalItemList(raw: any): any[] {
  const response = raw?.response || raw || {};
  const list = response.global_item_list || response.item_list || raw?.global_item_list || [];
  return Array.isArray(list) ? list : [];
}

function shopeeGlobalModelList(raw: any): any[] {
  const response = raw?.response || raw || {};
  const list = response.global_model || response.global_model_list || response.model || raw?.global_model || [];
  return Array.isArray(list) ? list : [];
}

function shopeeGlobalItemIds(raw: any): number[] {
  return [...new Set(shopeeGlobalItemList(raw)
    .map((entry: any) => Number(entry?.global_item_id ?? entry?.item_id ?? entry))
    .filter((id: number) => Number.isFinite(id) && id > 0))];
}

function shopeeNormalizeLookupText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shopeeGlobalItemMatchesTerms(item: any, terms: string[]): boolean {
  if (!terms.length) return true;
  const haystack = shopeeNormalizeLookupText([
    item?.global_item_name,
    item?.item_name,
    item?.name,
    item?.global_item_sku,
    item?.item_sku,
    item?.description,
  ].filter(Boolean).join(' '));
  if (!haystack) return false;
  const hayWords = new Set(haystack.split(' ').filter(Boolean));
  return terms.some((term) => {
    const tokens = shopeeNormalizeLookupText(term)
      .split(' ')
      .filter((token) => token.length > 1 && !['the', 'and', 'ver', 'version', 'edition', 'album'].includes(token));
    if (!tokens.length) return false;
    const matched = tokens.filter((token) => hayWords.has(token) || haystack.includes(token)).length;
    return matched >= Math.min(2, tokens.length);
  });
}

function shopeeGlobalSkuLookupHit(sku: string, item: any, model: any, source: string) {
  const globalItemId = Number(item?.global_item_id || item?.item_id || 0);
  const globalModelId = Number(model?.global_model_id || model?.model_id || 0);
  return {
    region: 'GLOBAL',
    sku,
    shop_id: null,
    shop_item_id: null,
    shop_model_id: null,
    global_item_id: globalItemId || null,
    global_model_id: globalModelId || null,
    item_status: String(item?.global_item_status || item?.item_status || '').toUpperCase() || null,
    item_sku: shopeeSkuValue(item?.global_item_sku || item?.item_sku),
    global_item_sku: shopeeSkuValue(item?.global_item_sku || item?.item_sku),
    model_sku: model ? shopeeSkuValue(model?.global_model_sku || model?.model_sku) : null,
    global_model_sku: model ? shopeeSkuValue(model?.global_model_sku || model?.model_sku) : null,
    item_name: item?.global_item_name || item?.item_name || item?.name || '',
    match_type: model ? 'global_model_sku' : 'global_item_sku',
    lookup_source: source,
  };
}

function shopeePublishedItems(raw: any): any[] {
  const response = raw?.response || raw?.result?.response || raw || {};
  const list = response.published_item || response.published_list || raw?.published_item || raw?.published_list || [];
  return Array.isArray(list) ? list : [];
}

function shopeePublishedListedStatus(status: unknown): boolean {
  const text = String(status ?? '').toUpperCase();
  if (!text) return true;
  if (text === 'NORMAL' || text === 'ITEM_NORMAL' || text === 'UNLIST' || text === 'ITEM_UNLIST') return true;
  const numeric = Number(status);
  return Number.isFinite(numeric) && (numeric === 1 || numeric === 8);
}

async function lookupShopeePublishedGlobalSkuAcrossRegions(
  regions: string[],
  sku: string,
  globalHit: any,
  accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY,
) {
  const globalItemId = Number(globalHit?.global_item_id || 0);
  const globalModelId = Number(globalHit?.global_model_id || 0);
  const regionHits: any[] = [];
  const errors: string[] = [];
  if (!Number.isFinite(globalItemId) || globalItemId <= 0) {
    return { region_hits: regionHits, errors: ['global_item_id missing'] };
  }

  const published = await merchantApiCall('SG', '/api/v2/global_product/get_published_list', {
    query: { global_item_id: globalItemId },
    account_key: accountKey,
  });
  if (published.error) {
    errors.push(shopeeLookupError('get_published_list', published));
    return { region_hits: regionHits, errors };
  }

  const publishedItems = shopeePublishedItems(published);
  const wantedRegions = new Set(regions.map((r) => String(r || '').toUpperCase()).filter(Boolean));
  for (const r of wantedRegions) {
    const candidates = publishedItems.filter((entry: any) => {
      const entryRegion = String(entry?.shop_region || entry?.region || entry?.country || '').toUpperCase();
      const itemId = Number(entry?.item_id || entry?.shop_item_id || entry?.shopItemId || 0);
      return entryRegion === r && Number.isFinite(itemId) && itemId > 0 && shopeePublishedListedStatus(entry?.item_status ?? entry?.status);
    });
    for (const entry of candidates) {
      const itemId = Number(entry?.item_id || entry?.shop_item_id || entry?.shopItemId || 0);
      const shopId = Number(entry?.shop_id || entry?.shopId || 0);
      const found = await shopeeSkuHitFromItemIds(r, sku, [itemId], 'global_published_model_list', Number.isFinite(shopId) && shopId > 0 ? shopId : null, accountKey);
      errors.push(...found.errors);
      if (found.hit) {
        regionHits.push({
          ...found.hit,
          source: 'global_published_model_list',
          lookup_source: 'global_published_model_list',
          global_item_id: globalItemId,
          global_model_id: globalModelId || null,
          global_model_sku: globalHit?.global_model_sku || globalHit?.model_sku || null,
        });
        break;
      }
    }
  }

  return { region_hits: regionHits, errors };
}

async function fetchShopeeGlobalItemInfo(region: string, globalItemIds: number[], accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const items: any[] = [];
  const errors: string[] = [];
  for (let i = 0; i < globalItemIds.length; i += 20) {
    const chunk = globalItemIds.slice(i, i + 20);
    const info = await merchantApiCall(region, '/api/v2/global_product/get_global_item_info', {
      query: { global_item_id_list: chunk.join(',') },
      account_key: accountKey,
    });
    if (info.error) {
      errors.push(shopeeLookupError('get_global_item_info', info));
      continue;
    }
    items.push(...shopeeGlobalItemList(info));
  }
  return { items, errors };
}

async function lookupShopeeGlobalSkuInItem(region: string, sku: string, item: any, source: string, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  const globalItemId = Number(item?.global_item_id || item?.item_id || 0);
  const errors: string[] = [];
  if (!Number.isFinite(globalItemId) || globalItemId <= 0) return { hit: null, errors: ['global_item_id missing'] };
  if (shopeeSkuEquals(item?.global_item_sku || item?.item_sku, sku)) {
    return { hit: shopeeGlobalSkuLookupHit(sku, item, null, 'global_item_info'), errors };
  }
  const modelsResult = await merchantApiCall(region, '/api/v2/global_product/get_global_model_list', {
    query: { global_item_id: globalItemId },
    account_key: accountKey,
  });
  if (modelsResult.error) {
    errors.push(shopeeLookupError('get_global_model_list', modelsResult));
    return { hit: null, errors };
  }
  const models = shopeeGlobalModelList(modelsResult);
  const modelHit = models.find((model: any) => shopeeSkuEquals(model?.global_model_sku, sku));
  if (modelHit) return { hit: shopeeGlobalSkuLookupHit(sku, item, modelHit, source), errors };
  return { hit: null, errors };
}

async function lookupShopeeGlobalSku(region: string, sku: string, maxGlobalItems = 300, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY, options: { itemNameTerms?: string[]; globalItemIds?: number[] } = {}) {
  const r = String(region || 'SG').toUpperCase() === 'GLOBAL' ? 'SG' : String(region || 'SG').toUpperCase();
  const needle = shopeeSkuValue(sku);
  const errors: string[] = [];
  const scannedItemIds: number[] = [];
  const checkedItemIds = new Set<number>();
  const maxItems = Math.max(1, Math.min(Number.isFinite(maxGlobalItems) ? maxGlobalItems : 300, 1000));
  const explicitIds = [...new Set((options.globalItemIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];

  if (!needle) return { found: false, not_found: false, error: 'sku required', errors };

  if (explicitIds.length) {
    const info = await fetchShopeeGlobalItemInfo(r, explicitIds, accountKey);
    errors.push(...info.errors);
    for (const item of info.items) {
      const id = Number(item?.global_item_id || item?.item_id || 0);
      if (id) checkedItemIds.add(id);
      const found = await lookupShopeeGlobalSkuInItem(r, needle, item, 'global_item_id', accountKey);
      errors.push(...found.errors);
      if (found.hit) return { found: true, not_found: false, hit: found.hit, source: 'global_item_id', errors, scanned_count: explicitIds.length, checked_count: checkedItemIds.size };
    }
  }

  const itemTerms = shopeeSkuLookupNameTerms(options.itemNameTerms || []);
  const itemInfoRows: any[] = [];
  const seenOffsets = new Set<string>();
  let offset = '';
  let pages = 0;
  while (scannedItemIds.length < maxItems) {
    const query: Record<string, any> = { page_size: Math.min(50, maxItems - scannedItemIds.length) };
    if (offset && offset !== '0') query.offset = offset;
    const listResult = await merchantApiCall(r, '/api/v2/global_product/get_global_item_list', { query, account_key: accountKey });
    if (listResult.error) {
      errors.push(shopeeLookupError('get_global_item_list', listResult));
      break;
    }
    pages += 1;
    const pageIds = shopeeGlobalItemIds(listResult).filter((id) => !scannedItemIds.includes(id));
    if (!pageIds.length) break;
    scannedItemIds.push(...pageIds);
    const info = await fetchShopeeGlobalItemInfo(r, pageIds, accountKey);
    errors.push(...info.errors);
    itemInfoRows.push(...info.items);
    const candidateItems = info.items.filter((item) => shopeeGlobalItemMatchesTerms(item, itemTerms));
    for (const item of candidateItems) {
      const id = Number(item?.global_item_id || item?.item_id || 0);
      if (checkedItemIds.has(id)) continue;
      checkedItemIds.add(id);
      const found = await lookupShopeeGlobalSkuInItem(r, needle, item, 'global_model_list', accountKey);
      errors.push(...found.errors);
      if (found.hit) return { found: true, not_found: false, hit: found.hit, source: 'global_model_list', errors, scanned_count: scannedItemIds.length, checked_count: checkedItemIds.size, pages };
    }
    const response = listResult?.response || {};
    const nextOffset = String(response.offset || response.next_offset || '');
    if (!response.has_next_page || !nextOffset || seenOffsets.has(nextOffset) || nextOffset === offset) break;
    seenOffsets.add(nextOffset);
    offset = nextOffset;
  }

  // If name filtering was too narrow, do one bounded exact-SKU pass over the
  // item_info rows already fetched. This keeps Shopee-tab mapping correct
  // without letting price-sync callers infer fake shop ids.
  if (itemTerms.length) {
    for (const item of itemInfoRows) {
      const id = Number(item?.global_item_id || item?.item_id || 0);
      if (checkedItemIds.has(id)) continue;
      checkedItemIds.add(id);
      const found = await lookupShopeeGlobalSkuInItem(r, needle, item, 'global_model_list_scan', accountKey);
      errors.push(...found.errors);
      if (found.hit) return { found: true, not_found: false, hit: found.hit, source: 'global_model_list_scan', errors, scanned_count: scannedItemIds.length, checked_count: checkedItemIds.size, pages };
    }
  }

  return {
    found: false,
    not_found: true,
    errors,
    scanned_count: scannedItemIds.length,
    checked_count: checkedItemIds.size,
    pages,
  };
}

async function shopeeSkuHitFromItemIds(region: string, sku: string, itemIds: number[], source: string, shopId: number | null, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  if (!itemIds.length) return { hit: null, errors: [] as string[] };
  const errors: string[] = [];
  for (let i = 0; i < itemIds.length; i += 50) {
    const chunk = itemIds.slice(i, i + 50);
    const info = await shopApiCall(region, '/api/v2/product/get_item_base_info', { query: { item_id_list: chunk.join(',') }, account_key: accountKey });
    if (info.error) {
      errors.push(shopeeLookupError('get_item_base_info', info));
      continue;
    }
    const items = Array.isArray(info.response?.item_list) ? info.response.item_list : [];
    for (const item of items) {
      if (!shopeeListedStatus(item?.item_status || item?.status)) continue;
      if (shopeeSkuEquals(item?.item_sku, sku)) {
        return { hit: shopeeSkuLookupHit(region, sku, item, null, source, shopId), errors };
      }
      if (!item?.has_model) continue;
      const modelsResult = await shopApiCall(region, '/api/v2/product/get_model_list', { query: { item_id: item.item_id }, account_key: accountKey });
      if (modelsResult.error) {
        errors.push(shopeeLookupError('get_model_list', modelsResult));
        continue;
      }
      const models = Array.isArray(modelsResult.response?.model) ? modelsResult.response.model : [];
      const modelHit = models.find((model: any) => shopeeSkuEquals(model?.model_sku, sku));
      if (modelHit) {
        return { hit: shopeeSkuLookupHit(region, sku, item, modelHit, source, shopId), errors };
      }
    }
  }
  return { hit: null, errors };
}

async function lookupShopeeSkuInRegion(region: string, sku: string, maxScanItems = 5000, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY, options: { scanFallback?: boolean; itemNameTerms?: string[] } = {}) {
  const r = String(region || '').toUpperCase();
  const needle = shopeeSkuValue(sku);
  if (!r) return { region: r, found: false, not_found: false, error: 'region required' };
  if (!needle) return { region: r, found: false, not_found: false, error: 'sku required' };

  let shopId: number | null = null;
  try {
    shopId = await getRegionShopId(r, accountKey);
  } catch (_) {
    shopId = null;
  }

  const errors: string[] = [];
  const searchResult = await shopApiCall(r, '/api/v2/product/search_item', { query: { item_sku: needle, offset: 0, page_size: 100 }, account_key: accountKey });
  if (searchResult.error) {
    errors.push(shopeeLookupError('search_item', searchResult));
  } else {
    const searchIds = shopeeSearchItemIds(searchResult);
    const searched = await shopeeSkuHitFromItemIds(r, needle, searchIds, 'search_item', shopId, accountKey);
    errors.push(...searched.errors);
    if (searched.hit) return { region: r, found: true, hit: searched.hit, search_item_ids: searchIds, errors };
  }

  const searchedNameTerms: string[] = [];
  const searchedNameIds: number[] = [];
  for (const term of options.itemNameTerms || []) {
    searchedNameTerms.push(term);
    const nameSearch = await shopApiCall(r, '/api/v2/product/search_item', { query: { item_name: term, offset: 0, page_size: 100 }, account_key: accountKey });
    if (nameSearch.error) {
      errors.push(shopeeLookupError('search_item_name', nameSearch));
      continue;
    }
    const searchIds = shopeeSearchItemIds(nameSearch);
    searchedNameIds.push(...searchIds);
    const searched = await shopeeSkuHitFromItemIds(r, needle, searchIds, 'search_item_name', shopId, accountKey);
    errors.push(...searched.errors);
    if (searched.hit) return { region: r, found: true, hit: searched.hit, search_item_ids: searchIds, search_item_name: term, errors };
  }

  if (options.scanFallback !== false) for (const status of SHOPEE_SKU_LOOKUP_STATUSES) {
    const listed = await listItemsForRegion(r, status, maxScanItems, accountKey);
    if ((listed as any).error) {
      errors.push(shopeeLookupError(`list_items_${status}`, listed));
      continue;
    }
    const row = ((listed as any).items || []).find((entry: any) => shopeeSkuEquals(entry?.item_sku, needle));
    if (row) {
      const item = { item_id: row.item_id, item_sku: row.base_sku || row.item_sku, item_status: row.status, has_model: !!row.has_model };
      const model = row.model_id ? { model_id: row.model_id, model_sku: row.item_sku } : null;
      return {
        region: r,
        found: true,
        hit: shopeeSkuLookupHit(r, needle, item, model, `scan_${status.toLowerCase()}`, shopId),
        scanned_status: status,
        scanned_count: (listed as any).count || 0,
        errors,
      };
    }
  }

  return { region: r, found: false, not_found: true, errors, search_item_ids: [...new Set(searchedNameIds)], search_item_name: searchedNameTerms };
}

async function lookupShopeeSkuAcrossRegions(regions: string[], sku: string, maxScanItems = 5000, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY, options: { scanFallback?: boolean; itemNameTerms?: string[] } = {}) {
  const uniqueRegions = [...new Set(regions.map((r) => String(r || '').trim().toUpperCase()).filter((r) => OPERATING_REGIONS.includes(r)))];
  const regionResults = await Promise.all(uniqueRegions.map((r) => lookupShopeeSkuInRegion(r, sku, maxScanItems, accountKey, options)));
  const regionHits = regionResults
    .filter((result: any) => result?.found && result?.hit)
    .map((result: any) => result.hit);
  return {
    found: regionHits.length > 0,
    not_found: regionHits.length === 0 && regionResults.every((result: any) => result?.not_found),
    region_hits: regionHits,
    region_results: regionResults,
  };
}

function jsonResp(b: any, s = 200) { return new Response(JSON.stringify(b, null, 2), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } }); }

function requireInternalBridge(req: Request): Response | null {
  const expected = Deno.env.get('PLATFORM_BRIDGE_INTERNAL_TOKEN') || '';
  const actual = req.headers.get('x-platform-bridge-token') || '';
  if (!expected || actual !== expected) {
    return jsonResp({ ok: false, error: 'internal_bridge_required' }, 403);
  }
  return null;
}

async function requireBridgeTokenOrAuthenticatedUser(req: Request): Promise<Response | null> {
  const expected = Deno.env.get('PLATFORM_BRIDGE_INTERNAL_TOKEN') || '';
  const actual = req.headers.get('x-platform-bridge-token') || '';
  if (expected && actual === expected) return null;
  const authResult = await requireAuthenticatedUser(req);
  return authResult.response || null;
}

const SHOPEE_OAUTH_CALLBACK_TTL_SEC = 30 * 60;

function shopeeOAuthCallbackParams(url: URL) {
  return {
    account_key: normalizeAccountKey(url.searchParams.get('account_key') || url.searchParams.get('accountKey')),
    main_account_id: String(url.searchParams.get('main_account_id') || ''),
    shop_id: String(url.searchParams.get('shop_id') || ''),
    display_name: String(url.searchParams.get('display_name') || url.searchParams.get('displayName') || ''),
    layer_asset_path: String(url.searchParams.get('layer_asset_path') || url.searchParams.get('layerAssetPath') || ''),
    exp: String(url.searchParams.get('exp') || ''),
    nonce: String(url.searchParams.get('nonce') || ''),
  };
}

function shopeeOAuthCallbackBase(params: Record<string, string>) {
  return [
    ['account_key', params.account_key || DEFAULT_SHOPEE_ACCOUNT_KEY],
    ['display_name', params.display_name || ''],
    ['exp', params.exp || ''],
    ['layer_asset_path', params.layer_asset_path || ''],
    ['main_account_id', params.main_account_id || ''],
    ['nonce', params.nonce || ''],
    ['shop_id', params.shop_id || ''],
  ].map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}

async function signShopeeOAuthCallback(app: any, params: Record<string, string>) {
  return await hmac(app.partner_key, shopeeOAuthCallbackBase(params));
}

async function buildShopeeOAuthCallbackRedirect(baseUrl: string, app: any, params: Record<string, string>) {
  const exp = String(Math.floor(Date.now() / 1000) + SHOPEE_OAUTH_CALLBACK_TTL_SEC);
  const nonce = crypto.randomUUID();
  const signedParams = { ...params, exp, nonce };
  const sig = await signShopeeOAuthCallback(app, signedParams);
  const redirectUrl = new URL('/functions/v1/shopee-bridge/oauth_callback', baseUrl);
  for (const [key, value] of Object.entries(signedParams)) {
    if (value) redirectUrl.searchParams.set(key, String(value));
  }
  redirectUrl.searchParams.set('sig', sig);
  return redirectUrl.toString();
}

function buildShopeeOAuthRelayRedirect(targetUrl: string) {
  const relayBase = Deno.env.get('SHOPEE_OAUTH_RELAY_URL')
    || 'https://bpdafetvjyvvwbksvowu.supabase.co/functions/v1/shopee-oauth-relay';
  const relayUrl = new URL(relayBase);
  relayUrl.searchParams.set('target', targetUrl);
  return relayUrl.toString();
}

async function verifyShopeeOAuthCallbackSignature(url: URL, app: any) {
  const params = shopeeOAuthCallbackParams(url);
  const sig = String(url.searchParams.get('sig') || '');
  const exp = Number(params.exp || 0);
  if (!sig) return { ok: false, error: 'oauth_callback_sig_required' };
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: 'oauth_callback_expired' };
  }
  if (!params.main_account_id && !params.shop_id) {
    return { ok: false, error: 'oauth_callback_principal_required' };
  }
  const expected = await signShopeeOAuthCallback(app, params);
  return { ok: sig === expected, error: sig === expected ? null : 'oauth_callback_sig_invalid', params };
}

function sanitizedShopeeOAuthTokenResponse(raw: any) {
  if (!raw || typeof raw !== 'object') return raw;
  const { access_token, refresh_token, ...safeRaw } = raw;
  return {
    ...safeRaw,
    access_token_set: Boolean(access_token),
    refresh_token_set: Boolean(refresh_token),
  };
}

async function exchangeShopeeOAuthCode(url: URL, accountKey: string) {
  const code = url.searchParams.get('code') || '';
  const main_account_id = url.searchParams.get('main_account_id') || '';
  const shop_id = url.searchParams.get('shop_id') || '';
  const displayName = String(url.searchParams.get('display_name') || url.searchParams.get('displayName') || accountKey).trim() || accountKey;
  const layerAssetPath = String(url.searchParams.get('layer_asset_path') || url.searchParams.get('layerAssetPath') || '').trim();
  if (!code) return jsonResp({ ok: false, error: 'code required' }, 400);
  if (!main_account_id && !shop_id) return jsonResp({ ok: false, error: 'main_account_id or shop_id required' }, 400);
  const app = await getApp(accountKey);
  const path = '/api/v2/auth/token/get';
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}`);
  const body: any = { code, partner_id: Number(app.partner_id) };
  if (main_account_id) body.main_account_id = Number(main_account_id);
  if (shop_id) body.shop_id = Number(shop_id);
  const r = await fetch(`https://${host(app.is_sandbox)}${path}?partner_id=${app.partner_id}&timestamp=${ts}&sign=${sign}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error || !j.access_token) {
    return jsonResp({ ok: false, error: j.error || 'no_access_token', message: j.message || null, raw: sanitizedShopeeOAuthTokenResponse(j) }, 502);
  }
  // Persist merchant row (KRSC merchant token)
  const now = Math.floor(Date.now() / 1000);
  const expires_at = now + Number(j.expire_in || 14400);
  const merchant_id_list: number[] = Array.isArray(j.merchant_id_list) ? j.merchant_id_list.map((x: any) => Number(x)) : [];
  const merchant_id = merchant_id_list[0] || null;
  const updates: any[] = [];
  if (main_account_id || merchant_id || layerAssetPath) {
    const profilePayload: Record<string, unknown> = {
      account_key: accountKey,
      display_name: displayName,
      status: 'active',
      updated_at: new Date().toISOString(),
    };
    if (main_account_id) profilePayload.main_account_id = Number(main_account_id);
    if (merchant_id) profilePayload.merchant_id = merchant_id;
    if (layerAssetPath) profilePayload.layer_asset_path = layerAssetPath;
    const { error: profileErr } = await supabase
      .from('shopee_account_profiles')
      .upsert(profilePayload, { onConflict: 'account_key' });
    updates.push({ kind: 'account_profile', account_key: accountKey, error: profileErr?.message || null });
  }
  if (main_account_id && merchant_id) {
    const { error } = await supabase.from('shopee_tokens').upsert({
      account_key: accountKey, region: '_MERCHANT', shop_id: Number(main_account_id), merchant_id, access_token: j.access_token, refresh_token: j.refresh_token, expires_at,
    }, { onConflict: 'account_key,region' });
    updates.push({ kind: 'merchant', account_key: accountKey, region: '_MERCHANT', shop_id: main_account_id, error: error?.message || null });
  }
  const shop_id_list: number[] = Array.isArray(j.shop_id_list) ? j.shop_id_list.map((x: any) => Number(x)) : [];
  for (const sid of shop_id_list) {
    if (!sid) continue;
    try {
      const probe = await probeShopToken(app, j.access_token, sid);
      const shopRegion = String(probe.region || '').toUpperCase();
      if (!probe.ok || !shopRegion) {
        updates.push({ kind: 'shop', account_key: accountKey, shop_id: sid, ok: false, error: probe.error || 'shop_region_unresolved', message: probe.message || null });
        continue;
      }
      const shopTs = Math.floor(Date.now() / 1000);
      const shopSign = await hmac(app.partner_key, `${app.partner_id}${path}${shopTs}`);
      const shopTokenResp = await fetch(`https://${host(app.is_sandbox)}${path}?partner_id=${app.partner_id}&timestamp=${shopTs}&sign=${shopSign}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: j.refresh_token, partner_id: Number(app.partner_id), shop_id: sid }),
      });
      const shopToken = await shopTokenResp.json();
      if (shopToken.error || !shopToken.access_token || !shopToken.refresh_token) {
        updates.push({ kind: 'shop', account_key: accountKey, region: shopRegion, shop_id: sid, ok: false, error: shopToken.error || 'missing_shop_token', message: shopToken.message || null });
        continue;
      }
      const shopExpiresAt = Math.floor(Date.now() / 1000) + Number(shopToken.expire_in || 14400);
      const expiresIso = new Date(shopExpiresAt * 1000).toISOString();
      const shopPayload = {
        account_key: accountKey,
        shop_id: String(sid),
        region: shopRegion,
        shop_name: probe.shop_name || null,
        access_token: shopToken.access_token,
        refresh_token: shopToken.refresh_token,
        expires_at: expiresIso,
        status: 'active',
        authorized_at: new Date().toISOString(),
        merchant_id,
      };
      const { error: shopErr } = await supabase
        .from('shopee_shops')
        .upsert(shopPayload, { onConflict: 'shop_id' });
      const { error: tokenErr } = await supabase.from('shopee_tokens').upsert({
        account_key: accountKey,
        region: shopRegion,
        shop_id: sid,
        merchant_id,
        access_token: shopToken.access_token,
        refresh_token: shopToken.refresh_token,
        expires_at: shopExpiresAt,
        is_sandbox: false,
      }, { onConflict: 'account_key,region' });
      updates.push({ kind: 'shop', account_key: accountKey, region: shopRegion, shop_id: sid, ok: !shopErr && !tokenErr, shop_error: shopErr?.message || null, token_error: tokenErr?.message || null });
    } catch (e: any) {
      updates.push({ kind: 'shop', account_key: accountKey, shop_id: sid, ok: false, error: String(e?.message || e) });
    }
  }
  return jsonResp({ ok: true, account_key: accountKey, access_token_set: !!j.access_token, expires_at, merchant_id, merchant_id_list, shop_id_list, updates, raw: sanitizedShopeeOAuthTokenResponse(j) });
}

async function resolveHeadlessGlobalItemId(body: any, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY): Promise<{ ok: true; global_item_id: number; source: string; rows?: any[] } | { ok: false; status: number; error: string; rows?: any[] }> {
  const explicit = Number(body.global_item_id || body.globalItemId || 0);
  if (Number.isFinite(explicit) && explicit > 0) {
    return { ok: true, global_item_id: Math.floor(explicit), source: 'body.global_item_id' };
  }

  const productId = String(body.product_id || body.productId || '').trim();
  if (!productId) return { ok: false, status: 400, error: 'global_item_id or product_id required' };

  const { data, error } = await supabase
    .from('product_shopee_listings')
    .select('product_id,account_key,region,global_item_id,shop_id,shop_item_id,status')
    .eq('product_id', productId)
    .eq('account_key', accountKey)
    .not('global_item_id', 'is', null);
  if (error) return { ok: false, status: 500, error: `product_shopee_listings lookup failed: ${error.message}` };

  const rows = Array.isArray(data) ? data : [];
  const ids = [...new Set(rows.map((row: any) => Number(row.global_item_id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return { ok: false, status: 404, error: 'global_item_id mapping not found', rows };
  if (ids.length > 1) return { ok: false, status: 409, error: 'ambiguous_global_item_id_mapping', rows };
  return { ok: true, global_item_id: ids[0], source: 'product_shopee_listings', rows };
}

async function markShopeeGlobalItemDeleted(globalItemId: number, body: any, raw: any, accountKey = DEFAULT_SHOPEE_ACCOUNT_KEY) {
  if (body.reset_local === false || body.resetLocal === false) return null;
  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    status: 'deleted',
    last_error: null,
    last_synced_at: now,
    updated_at: now,
  };
  let query = supabase
    .from('product_shopee_listings')
    .update(update)
    .eq('global_item_id', globalItemId)
    .eq('account_key', accountKey)
    .select('product_id,account_key,region,global_item_id,shop_id,shop_item_id,status');
  const productId = String(body.product_id || body.productId || '').trim();
  if (productId) query = query.eq('product_id', productId);
  const { data, error } = await query;
  if (error) return { ok: false, error: error.message };
  return { ok: true, rows: data || [], raw };
}

type ShopeeRegistrationMappingInput = {
  product_id?: string | null;
  productId?: string | null;
  id?: string | null;
  product_sku?: string | null;
  sku?: string | null;
  item_sku?: string | null;
  model_sku?: string | null;
  shopee_global_model_sku?: string | null;
  global_model_sku?: string | null;
  account_key?: string | null;
  accountKey?: string | null;
  region?: string | null;
  global_item_id?: number | string | null;
  global_model_id?: number | string | null;
  shop_id?: number | string | null;
  shop_item_id?: number | string | null;
  item_id?: number | string | null;
  shop_model_id?: number | string | null;
  model_id?: number | string | null;
  status?: string | null;
  published_at?: string | null;
  last_error?: string | null;
  error?: string | null;
  message?: string | null;
  last_synced_price?: number | string | null;
  last_synced_at?: string | null;
  days_to_ship?: number | string | null;
  raw_payload?: any;
};

async function resolveProductIdForMapping(row: any): Promise<string> {
  const explicit = String(row?.product_id || row?.productId || row?.id || '').trim();
  if (explicit) return explicit;
  const candidates = [
    row?.product_sku,
    row?.sku,
    row?.model_sku,
    row?.shopee_global_model_sku,
    row?.global_model_sku,
    row?.item_sku,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  for (const sku of candidates) {
    const bySku = await supabase
      .from('products')
      .select('id')
      .eq('sku', sku)
      .maybeSingle();
    if (!bySku.error && bySku.data?.id) return String(bySku.data.id);
    const byModelSku = await supabase
      .from('products')
      .select('id')
      .eq('shopee_global_model_sku', sku)
      .maybeSingle();
    if (!byModelSku.error && byModelSku.data?.id) return String(byModelSku.data.id);
  }
  const globalItemId = Number(row?.global_item_id || 0);
  const globalModelId = Number(row?.global_model_id || 0);
  const shopItemId = Number(row?.shop_item_id || row?.item_id || 0);
  const shopModelId = Number(row?.shop_model_id || row?.model_id || 0);
  if (globalItemId || globalModelId || shopItemId || shopModelId) {
    let query = supabase
      .from('product_shopee_listings')
      .select('product_id')
      .limit(1);
    if (globalModelId) query = query.eq('global_model_id', globalModelId);
    else if (shopModelId) query = query.eq('shop_model_id', shopModelId);
    else if (shopItemId) query = query.eq('shop_item_id', shopItemId);
    else query = query.eq('global_item_id', globalItemId);
    const existing = await query.maybeSingle();
    if (!existing.error && existing.data?.product_id) return String(existing.data.product_id);
  }
  return '';
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function shopeeMappingError(row: any): string | null {
  const parts = [
    row?.last_error,
    row?.error,
    row?.message,
    row?.stage ? `stage=${row.stage}` : '',
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return parts.length ? parts.join(' | ').slice(0, 1200) : null;
}

function shopeeMappingStatus(row: any): string {
  const explicit = String(row?.status || '').trim();
  if (explicit) return explicit;
  const shopItemId = numberOrNull(row?.shop_item_id ?? row?.item_id);
  return shopItemId ? 'mapped' : 'failed';
}

async function persistShopeeRegistrationMappings(accountKey: string, listings: ShopeeRegistrationMappingInput[] = []) {
  const normalizedAccountKey = normalizeAccountKey(accountKey || DEFAULT_SHOPEE_ACCOUNT_KEY);
  const now = new Date().toISOString();
  const payload: any[] = [];
  const skipped: any[] = [];

  for (const row of listings || []) {
    const productId = await resolveProductIdForMapping(row);
    const region = String(row?.region || '').trim().toUpperCase();
    if (!productId || !region) {
      skipped.push({
        ok: false,
        error: 'product_id and region required',
        sku: row?.sku || row?.model_sku || row?.shopee_global_model_sku || row?.global_model_sku || row?.item_sku || null,
        region: row?.region || null,
      });
      continue;
    }
    const status = shopeeMappingStatus(row);
    payload.push({
      product_id: productId,
      account_key: normalizeAccountKey(row?.account_key || row?.accountKey || normalizedAccountKey),
      region,
      global_item_id: Object.prototype.hasOwnProperty.call(row || {}, 'global_item_id') ? numberOrNull(row.global_item_id) : null,
      global_model_id: numberOrNull(row?.global_model_id),
      shop_id: numberOrNull(row?.shop_id),
      shop_item_id: numberOrNull(row?.shop_item_id ?? row?.item_id),
      shop_model_id: numberOrNull(row?.shop_model_id ?? row?.model_id),
      status,
      published_at: row?.published_at || (status === 'mapped' ? now : null),
      last_error: status === 'mapped' ? null : shopeeMappingError(row),
      last_synced_price: row?.last_synced_price != null ? Number(row.last_synced_price) : null,
      last_synced_at: row?.last_synced_at || now,
      days_to_ship: row?.days_to_ship != null ? Number(row.days_to_ship) : null,
      raw_payload: row?.raw_payload || null,
      updated_at: now,
    });
  }

  if (!payload.length) {
    return {
      ok: skipped.length === 0,
      attempted: listings.length,
      saved_count: 0,
      skipped,
      rows: [],
    };
  }

  const { data, error } = await supabase
    .from('product_shopee_listings')
    .upsert(payload, { onConflict: 'product_id,account_key,region' })
    .select('product_id,account_key,region,global_item_id,global_model_id,shop_id,shop_item_id,shop_model_id,status,last_error');
  return {
    ok: !error && skipped.length === 0,
    attempted: listings.length,
    saved_count: Array.isArray(data) ? data.length : 0,
    skipped,
    rows: data || [],
    error: error?.message || null,
  };
}

async function recordRegistrationMapping(req: Request): Promise<Response> {
  const denied = requireInternalBridge(req);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const accountKey = normalizeAccountKey(body.account_key || body.accountKey || DEFAULT_SHOPEE_ACCOUNT_KEY);
  const globalItemId = Number(body.global_item_id || body.globalItemId || 0) || null;
  const productUpdates = Array.isArray(body.product_updates) ? body.product_updates : [];
  const listings = Array.isArray(body.listings) ? body.listings : [];
  const now = new Date().toISOString();
  const productResults: any[] = [];
  const listingResults: any[] = [];

  for (const row of productUpdates) {
    const productId = await resolveProductIdForMapping(row);
    if (!productId) {
      productResults.push({ ok: false, error: 'product_id required' });
      continue;
    }
    const update: Record<string, unknown> = {
      shopee_item_id: row.global_item_id ? Number(row.global_item_id) : globalItemId,
      shopee_publish_state: row.shopee_publish_state || body.shopee_publish_state || 'partial_published',
    };
    if (row.global_model_id != null) update.global_model_id = Number(row.global_model_id) || null;
    if (row.shopee_global_model_sku || row.global_model_sku) update.shopee_global_model_sku = String(row.shopee_global_model_sku || row.global_model_sku);
    const { data, error } = await supabase
      .from('products')
      .update(update)
      .eq('id', productId)
      .select('id,sku,shopee_item_id,shopee_publish_state,global_model_id,shopee_global_model_sku')
      .maybeSingle();
    productResults.push(error ? { ok: false, product_id: productId, error: error.message } : { ok: true, row: data });
  }

  if (listings.length) {
    const persisted = await persistShopeeRegistrationMappings(accountKey, listings.map((row: any) => ({
      ...row,
      global_item_id: Object.prototype.hasOwnProperty.call(row || {}, 'global_item_id') ? row.global_item_id : globalItemId,
    })));
    listingResults.push(persisted);
  }

  return jsonResp({
    ok: productResults.every((row) => row.ok) && listingResults.every((row) => row.ok !== false),
    account_key: accountKey,
    product_results: productResults,
    listing_results: listingResults,
  });
}

async function handleHeadlessDeleteGlobalItem(req: Request, url: URL): Promise<Response> {
  const denied = await requireBridgeTokenOrAuthenticatedUser(req);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const accountKey = normalizeAccountKey(body.account_key || body.accountKey || url.searchParams.get('account_key') || url.searchParams.get('accountKey'));
  body.account_key = accountKey;
  const dryRun = body.dry_run !== false && body.dryRun !== false;
  const region = String(body.region || url.searchParams.get('region') || 'SG').toUpperCase();
  const resolved = await resolveHeadlessGlobalItemId(body, accountKey);
  if (!resolved.ok) return jsonResp({ ok: false, error: resolved.error, rows: resolved.rows || [] }, resolved.status);

  if (dryRun) {
    return jsonResp({
      ok: true,
      dry_run: true,
      account_key: accountKey,
      region,
      global_item_id: resolved.global_item_id,
      source: resolved.source,
      mapped_rows: resolved.rows || [],
      reset_local: body.reset_local !== false && body.resetLocal !== false,
      command: '/api/v2/global_product/delete_global_item',
    });
  }

  const confirmed = body.confirm === SHOPEE_HEADLESS_DELETE_CONFIRM_PHRASE || body.confirm_delete === true;
  if (!confirmed) {
    return jsonResp({
      ok: false,
      error: 'confirm_required',
      message: `Set dry_run=false and confirm="${SHOPEE_HEADLESS_DELETE_CONFIRM_PHRASE}" to delete the Shopee global item.`,
      account_key: accountKey,
      region,
      global_item_id: resolved.global_item_id,
    }, 400);
  }

  // Official local doc: C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.delete_global_item.json
  const result = await merchantApiCall(region, '/api/v2/global_product/delete_global_item', {
    method: 'POST',
    body: { global_item_id: resolved.global_item_id },
    account_key: accountKey,
  });
  const failureList = Array.isArray(result?.response?.failure_delete_item) ? result.response.failure_delete_item : [];
  if (result.error || failureList.length) {
    return jsonResp({
      ok: false,
      account_key: accountKey,
      region,
      global_item_id: resolved.global_item_id,
      error: result.error || 'partial_delete_failure',
      message: result.message || '',
      failure_delete_item: failureList,
      raw: result,
    }, 502);
  }

  const persisted = await markShopeeGlobalItemDeleted(resolved.global_item_id, body, result, accountKey);
  return jsonResp({
    ok: true,
    dry_run: false,
    account_key: accountKey,
    region,
    global_item_id: resolved.global_item_id,
    deleted: true,
    persisted,
    raw: result,
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const action = url.pathname.split('/').filter(Boolean).pop() || '';
  const region = url.searchParams.get('region') || 'SG';
  const accountKey = normalizeAccountKey(url.searchParams.get('account_key') || url.searchParams.get('accountKey'));

  if (action === 'delete_global_item_headless' && req.method === 'POST') {
    return await handleHeadlessDeleteGlobalItem(req, url);
  }

  if (action === 'record_registration_mapping' && req.method === 'POST') {
    return await recordRegistrationMapping(req);
  }

  // Step 0 auth gate (plan v2.2): mutating routes require a signed-in user or
  // the private internal bridge token. Read-only PUBLIC_ACTIONS skip the check.
  if (!PUBLIC_ACTIONS.has(action)) {
    const authResponse = await requireBridgeTokenOrAuthenticatedUser(req);
    if (authResponse) {
      audit('auth_rejected', { action, reason: 'bridge_token_or_authenticated_user_failed' });
      return authResponse;
    }
    const authMode = req.headers.get('x-platform-bridge-token') ? 'internal_bridge' : 'authenticated_user';
    audit('auth_ok', { action, mode: authMode });
  }

  try {
    if (action === 'health') {
  const app = await getApp(accountKey);
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
      const data = await getShopeeTokenRow(region, accountKey);
      if (!data) return jsonResp({ ok: false, error: `no tokens for region ${region}` }, 404);
      const app = await getApp(accountKey);
      const path = '/api/v2/auth/access_token/get';
      const ts = Math.floor(Date.now() / 1000);
      const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}`);
      const url = `https://${host(app.is_sandbox)}${path}?partner_id=${app.partner_id}&timestamp=${ts}&sign=${sign}`;
      const variants: any[] = [
        { name: 'shop_id', body: { refresh_token: data.refresh_token, partner_id: app.partner_id, shop_id: data.shop_id } },
        { name: 'merchant_id', body: { refresh_token: data.refresh_token, partner_id: app.partner_id, merchant_id: data.merchant_id } },
        { name: 'main_account_id_constant', body: { refresh_token: data.refresh_token, partner_id: app.partner_id, main_account_id: await mainAccountIdForAccount(accountKey) } },
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
      return jsonResp({ ok: true, account_key: accountKey, region, MAIN_ACCOUNT_ID: await mainAccountIdForAccount(accountKey), results });
    }
    if (action === 'tokens') {
      const data = await getShopeeTokenRows(accountKey);
      const now = Math.floor(Date.now() / 1000);
      return jsonResp({ ok: true, account_key: accountKey, tokens: (data || []).map(r => ({ ...r, expires_in_sec: r.expires_at - now })) });
    }
    if (action === 'token_probe') {
      const app = await getApp(accountKey);
      const data = await getShopeeTokenRow(region, accountKey);
      if (!data) return jsonResp({ ok: false, region, error: 'token no' }, 404);
      const now = Math.floor(Date.now() / 1000);
      const probe = await probeShopToken(app, data.access_token, data.shop_id);
      return jsonResp({
        ok: probe.ok,
        account_key: accountKey,
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
      const app = await getApp(accountKey);
      const now = Math.floor(Date.now() / 1000);
      const data = await getShopeeTokenRows(accountKey, { regions: targetRegions, includeAccessToken: true });
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
            account_key: accountKey,
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
          account_key: accountKey,
          region: row.region,
          shop_id: row.shop_id,
          merchant_id: row.merchant_id,
          expires_in_sec: expiresIn,
          refresh_threshold_sec: refreshThresholdSec,
          next_refresh_due_in_sec: expiresIn - refreshThresholdSec,
        };

        const shopRow = await getShopeeShopRowByShopId(row.shop_id, accountKey);
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
          const refreshed = await refreshWithRetry(`shop:${accountKey}:${row.region}`, () => forceRefreshShopToken(row.region, accountKey), maxRefreshAttempts, retryBaseMs);
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
        const merchantRow = await getShopeeTokenRow('_MERCHANT', accountKey);
        if (!merchantRow) {
          counters.missing_token++;
          counters.merchant_fail++;
          merchantResult = {
            principal: 'merchant',
            account_key: accountKey,
            region: '_MERCHANT',
            ok: false,
            error: 'merchant_row_missing',
            refresh_skipped: 'missing_token_row',
          };
        } else {
          const expiresIn = Number(merchantRow.expires_at || 0) - now;
          merchantResult = {
            principal: 'merchant',
            account_key: accountKey,
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
            const refreshed = await refreshWithRetry(`merchant:${accountKey}:_MERCHANT`, () => refreshMerchantRowTokenStrict(accountKey), maxRefreshAttempts, retryBaseMs);
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
    if (action === 'shop_info') return jsonResp(await shopApiCall(region, '/api/v2/shop/get_shop_info', { account_key: accountKey }));
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
      const result = await shopApiCall(region, path, { query, account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region, path, query, result });
    }
    if (action === 'channels') {
      const result = await shopApiCall(region, '/api/v2/logistics/get_channel_list', { account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region, result });
    }
    if (action === 'categories') {
      const result = await shopApiCall(region, '/api/v2/product/get_category', { query: { language: 'en' }, account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region, result });
    }
    if (action === 'attributes') {
      const category_id = url.searchParams.get('category_id') || '';
      if (!category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      const result = await shopApiCall(region, '/api/v2/product/get_attributes', { query: { category_id, language: 'en' }, account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region, category_id, result });
    }
    if (action === 'brands') {
      const category_id = url.searchParams.get('category_id') || '';
      const status = url.searchParams.get('status') || '1';
      if (!category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      const result = await fetchBrandListPages(region, 'shop', category_id, status, accountKey);
      return jsonResp({ ...result, account_key: accountKey, region, category_id });
    }
    if (action === 'global_categories') {
      const result = await merchantApiCall(region, '/api/v2/global_product/get_category', { query: { language: 'en' }, account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region, result });
    }
    if (action === 'global_brands') {
      const category_id = url.searchParams.get('category_id') || '';
      const status = url.searchParams.get('status') || '1';
      if (!category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      const result = await fetchBrandListPages(region, 'merchant', category_id, status, accountKey);
      return jsonResp({ ...result, account_key: accountKey, region, category_id });
    }
    if (action === 'global_attributes') {
      const category_id = url.searchParams.get('category_id') || '';
      if (!category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      // Production /get_attribute_tree requires category_id_list (CSV), not single category_id.
      const result = await merchantApiCall(region, '/api/v2/global_product/get_attribute_tree', { query: { category_id_list: category_id, language: 'en' }, account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region, category_id, result });
    }
    // POST /add_global_item: create only the GlobalProduct source item. Variation/model setup is separate.
    if (action === 'add_global_item' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      body.account_key = reqAccountKey;
      const r = body.region || 'SG';
      if (!body.name) return jsonResp({ ok: false, error: 'name required' }, 400);
      if (!body.sku) return jsonResp({ ok: false, error: 'sku required' }, 400);
      if (!body.price && !body.global_price) return jsonResp({ ok: false, error: 'price required' }, 400);
      if (!body.category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      return withPublishRequestId(action, `${reqAccountKey}:${r}`, null, body, async () => {
        const payload = buildGlobalItemPayload(body);
        const result = await merchantApiCall(r, '/api/v2/global_product/add_global_item', { method: 'POST', body: payload, account_key: reqAccountKey });
        if (result.error) return jsonResp({ ok: false, account_key: reqAccountKey, region: r, error: result.error, message: result.message, sent: payload, raw: result }, 502);
        return jsonResp({ ok: true, account_key: reqAccountKey, region: r, global_item_id: result.response?.global_item_id, sent: payload, raw: result });
      });
    }
    if (action === 'init_tier_variation' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      body.account_key = reqAccountKey;
      const r = body.region || 'SG';
      const global_item_id = Number(body.global_item_id);
      let variation: any = null;
      try {
        variation = normalizeVariation(body.variation);
      } catch (e: any) {
        return jsonResp({ ok: false, account_key: reqAccountKey, region: r, stage: 'variation_preflight', error: 'invalid_variation', message: String(e?.message || e) }, 400);
      }
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      if (!variation) return jsonResp({ ok: false, error: 'variation required' }, 400);
      const models = buildGlobalModels(variation, Number(body.global_price ?? body.price), Number(body.stock || 0));
      if (!models.length) return jsonResp({ ok: false, error: 'global_model required' }, 400);
      return withPublishRequestId(action, `${reqAccountKey}:${r}`, null, body, async () => {
        const result = await merchantApiCall(r, '/api/v2/global_product/init_tier_variation', {
          method: 'POST',
          body: { global_item_id, tier_variation: variation.tier_variation, global_model: [models[0]] },
          account_key: reqAccountKey,
        });
        if (result.error) return jsonResp({ ok: false, account_key: reqAccountKey, region: r, error: result.error, message: result.message, raw: result }, 502);
        return jsonResp({ ok: true, account_key: reqAccountKey, region: r, global_item_id, sent_model: models[0], raw: result });
      });
    }
    if (action === 'add_global_model' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      body.account_key = reqAccountKey;
      const r = body.region || 'SG';
      const global_item_id = Number(body.global_item_id);
      let model_list: any[] = [];
      try {
        model_list = Array.isArray(body.model_list) ? body.model_list : buildGlobalModels(body.variation, Number(body.global_price ?? body.price), Number(body.stock || 0));
      } catch (e: any) {
        return jsonResp({ ok: false, account_key: reqAccountKey, region: r, stage: 'variation_preflight', error: 'invalid_variation', message: String(e?.message || e) }, 400);
      }
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      if (!model_list.length) return jsonResp({ ok: false, error: 'model_list required' }, 400);
      return withPublishRequestId(action, `${reqAccountKey}:${r}`, null, body, async () => {
        const addModelPayload = buildAddGlobalModelPayload(global_item_id, model_list, body, body);
        const result = await merchantApiCall(r, '/api/v2/global_product/add_global_model', {
          method: 'POST',
          body: addModelPayload,
          account_key: reqAccountKey,
        });
        if (result.error) return jsonResp({ ok: false, account_key: reqAccountKey, region: r, error: result.error, message: result.message, sent: addModelPayload, raw: result }, 502);
        return jsonResp({ ok: true, account_key: reqAccountKey, region: r, global_item_id, sent: addModelPayload, sent_model_list: addModelPayload.global_model, raw: result });
      });
    }
    // POST /create_publish_task: publish one global item to one shop/region.
    if (action === 'create_publish_task' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      body.account_key = reqAccountKey;
      const r = body.region || 'SG';
      const global_item_id = Number(body.global_item_id);
      const shop_id = Number(body.shop_id || await getRegionShopId(r, reqAccountKey));
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      if (!shop_id) return jsonResp({ ok: false, error: 'shop_id required' }, 400);
      return withPublishRequestId(action, `${reqAccountKey}:${r}`, shop_id, body, async () => {
        const logistics = await getPublishLogistics(r, false, reqAccountKey);
        const item = body.item || buildPublishItemPayload(body, body, logistics);
        if (!item.logistic) item.logistic = logistics;
        const sent = { global_item_id, shop_id, shop_region: r, item };
        const result = await merchantApiCall(r, '/api/v2/global_product/create_publish_task', { method: 'POST', body: sent, account_key: reqAccountKey });
        if (result.error) return jsonResp({ ok: false, account_key: reqAccountKey, region: r, error: result.error, message: result.message, sent, raw: result }, 502);
        return jsonResp({ ok: true, account_key: reqAccountKey, region: r, publish_task_id: result.response?.publish_task_id, sent, raw: result });
      });
    }
    if (action === 'publish_task_result') {
      const publish_task_id = url.searchParams.get('publish_task_id') || '';
      if (!publish_task_id) return jsonResp({ ok: false, error: 'publish_task_id required' }, 400);
      const result = await merchantApiCall(region, '/api/v2/global_product/get_publish_task_result', { query: { publish_task_id }, account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region, result });
    }
    if (action === 'publishable_shop') {
      const global_item_id = url.searchParams.get('global_item_id') || '';
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      const result = await merchantApiCall(region, '/api/v2/global_product/get_publishable_shop', { query: { global_item_id }, account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region, global_item_id, result });
    }
    if (action === 'shop_publishable_status') {
      const global_item_id = url.searchParams.get('global_item_id') || '';
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      const offset = url.searchParams.get('offset') || '0';
      const page_size = url.searchParams.get('page_size') || '50';
      const result = await merchantApiCall(region, '/api/v2/global_product/get_shop_publishable_status', { query: { global_item_id, offset, page_size }, account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region, global_item_id, result });
    }
    if (action === 'publish_to_region' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      body.account_key = reqAccountKey;
      const global_item_id = Number(body.global_item_id);
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      const targetInputs = (Array.isArray(body.targets) && body.targets.length ? body.targets : [body])
        .map((t: any) => ({ ...t, region: String(t.region || '').toUpperCase() }))
        .filter((t: any) => t.region);
      if (!targetInputs.length) return jsonResp({ ok: false, error: 'targets required' }, 400);
      const regionalTargetPriceAdjustments = normalizeRegionalTargetModelPriceRatio(targetInputs);
      const brTargetPriceAdjustments = regionalTargetPriceAdjustments.filter((adjustment: any) => String(adjustment?.region || '').toUpperCase() === 'BR');
      if (!body.name) return jsonResp({ ok: false, error: 'name required (publish item payload)' }, 400);
      if (!body.category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      const _isPreOrderRepublish = body.is_pre_order === true || body.lifecycle_state === 'pre_order';
      const shouldRepairPublishedLogistics = targetInputs.some((target: any) => String(target.region || '').toUpperCase() !== 'BR');
      const publishLogisticsRepair = shouldRepairPublishedLogistics
        ? await repairPublishedItemLogisticsForGlobalItem(global_item_id, reqAccountKey, region).catch((e: any) => ({
          ok: false,
          stage: 'repair_published_item_logistics_exception',
          error: String(e?.message || e),
        }))
        : { ok: true, skipped: true, reason: 'br_only_publish_no_existing_logistics_repair' };
      const results: any[] = [];
      await mapWithConcurrency(targetInputs, 2, async (target: any) => {
        const targetRegion = String(target.region || '').toUpperCase();
        const regionStartMs = Date.now();
        const regionTiming: Record<string, number> = {};
        try {
          const shop_id = target.shop_id ? Number(target.shop_id) : await getRegionShopId(targetRegion, reqAccountKey);
          const BRIDGE_BANNED_SHOP_IDS = new Set([1002269093]);
          if (BRIDGE_BANNED_SHOP_IDS.has(shop_id)) {
            results.push({ ok: false, region: targetRegion, shop_id, stage: 'banned_shop', error: 'shop_id is permanently banned' });
            return;
          }
          const logistics = await getPublishLogistics(targetRegion, _isPreOrderRepublish, reqAccountKey);
          const brMinimalFirst = await publishBrOptionMinimalFirst(global_item_id, shop_id, target, body, logistics, reqAccountKey).catch((e: any) => ({
            ok: false,
            region: targetRegion,
            shop_id,
            stage: 'br_option_minimal_first_exception',
            error: String(e?.message || e),
            br_option_minimal_first: true,
          }));
          if (brMinimalFirst) {
            results.push(brMinimalFirst);
            return;
          }
          const item = buildPublishItemPayload({ ...body, image_id: target.image_id || body.image_id, image_url: target.image_url || body.image_url, image_id_list: target.image_id_list || body.image_id_list, image_url_list: target.image_url_list || body.image_url_list }, target, logistics);
          const publishBody = { global_item_id, shop_id, shop_region: targetRegion, item };
          const createPublishStartMs = Date.now();
          const publishRes = await merchantApiCall(targetRegion, '/api/v2/global_product/create_publish_task', { method: 'POST', body: publishBody, account_key: reqAccountKey });
          regionTiming.create_publish_task = elapsedMs(createPublishStartMs);
          if (publishRes.error) {
            const createFailure: any = { ok: false, region: targetRegion, shop_id, stage: 'create_publish_task', error: publishRes.error, message: publishRes.message, raw: publishRes, timing_ms: { ...regionTiming, total: elapsedMs(regionStartMs) } };
            if (targetRegion === 'BR' && hasOptionVariationPayload(target, body) && isCrossuploadPermissionPublishFailure(createFailure, publishRes)) {
              const retryOutcome = await retryMinimalPublish(global_item_id, shop_id, target, body, logistics, reqAccountKey, 'br_existing_global_crossupload_create_retry').catch((e: any) => ({ ok: false, region: targetRegion, shop_id, stage: 'minimal_publish_exception', error: String(e?.message || e) }));
              if (retryOutcome?.ok) results.push(await finalizePublishOutcomeAfterSuccess(retryOutcome, targetRegion, target, body, reqAccountKey));
              else results.push(markBrOptionCrossuploadBlocked({ ...createFailure, minimal_item_retry: retryOutcome }, null, publishRes, { global_item_id, minimal_item_retry: retryOutcome }));
              return;
            }
            if (shouldTryMinimalPublishFallback(createFailure, publishRes)) {
              const retryReason = isCrossuploadPermissionPublishFailure(createFailure, publishRes)
                ? 'crossupload_permission_create_retry'
                : isAmbiguousLocalPublishFailure(createFailure, publishRes)
                  ? 'ambiguous_local_publish_create_retry'
                  : 'variation_invalid_create_retry';
              const retryOutcome = await retryMinimalPublish(global_item_id, shop_id, target, body, logistics, reqAccountKey, retryReason).catch((e: any) => ({ ok: false, region: targetRegion, shop_id, stage: 'minimal_publish_exception', error: String(e?.message || e) }));
              if (retryOutcome?.ok) results.push(await finalizePublishOutcomeAfterSuccess(retryOutcome, targetRegion, target, body, reqAccountKey));
              else results.push({ ...createFailure, minimal_item_retry: retryOutcome });
              return;
            }
            results.push(createFailure);
            return;
          }
          const publish_task_id = Number(publishRes.response?.publish_task_id);
          let task: any = null;
          let pollAttempts = 0;
          let pollWaitMs = 0;
          let earlyPublishedOutcome: any = null;
          // BR publish async is slower — double the polling window for BR only
          const maxPoll = (targetRegion === 'BR') ? SHOPEE_BR_MAX_PUBLISH_POLLS : 30;
          const pollingStartMs = Date.now();
          for (let i = 0; i < maxPoll; i++) {
            const pollDelayMs = nextPublishTaskPollDelayMs(i, targetRegion);
            pollWaitMs += pollDelayMs;
            await sleep(pollDelayMs);
            const taskRes = await merchantApiCall(targetRegion, '/api/v2/global_product/get_publish_task_result', { query: { publish_task_id }, account_key: reqAccountKey });
            task = taskRes;
            pollAttempts = i + 1;
            if (shouldVerifyPublishedListDuringPublishPolling(targetRegion, pollAttempts)) {
              earlyPublishedOutcome = await verifyPublishedListOutcomeOnce(targetRegion, shop_id, global_item_id, publish_task_id, task, reqAccountKey, 'verified_via_early_published_list_' + pollAttempts).catch(() => null);
              if (earlyPublishedOutcome) break;
            }
            if (isCrossuploadPermissionPublishFailure(taskRes)) break;
            if (!shouldContinuePublishPolling(taskRes)) break;
          }
          regionTiming.publish_task_polling = elapsedMs(pollingStartMs);
          regionTiming.publish_task_poll_wait = pollWaitMs;
          let outcome = earlyPublishedOutcome || parsePublishOutcome(targetRegion, shop_id, publish_task_id, task);
          if (!outcome.ok && targetRegion === 'BR' && hasOptionVariationPayload(target, body) && isCrossuploadPermissionPublishFailure(outcome, task, publishRes)) {
            const retryOutcome = await retryMinimalPublish(global_item_id, shop_id, target, body, logistics, reqAccountKey, 'br_existing_global_crossupload_task_retry').catch((e: any) => ({ ok: false, region: targetRegion, shop_id, stage: 'minimal_publish_exception', error: String(e?.message || e) }));
            outcome = retryOutcome?.ok
              ? retryOutcome
              : markBrOptionCrossuploadBlocked({ ...outcome, minimal_item_retry: retryOutcome }, task, publishRes, { global_item_id, minimal_item_retry: retryOutcome });
          }
          if (!outcome.ok && !(outcome as any).br_option_crossupload_blocked && shouldTryMinimalPublishFallback(outcome, task, publishRes)) {
            const retryReason = isCrossuploadPermissionPublishFailure(outcome, task, publishRes)
              ? 'crossupload_permission_task_retry'
              : isAmbiguousLocalPublishFailure(outcome, task, publishRes)
                ? 'ambiguous_local_publish_task_retry'
                : 'variation_invalid_task_retry';
            const retryOutcome = await retryMinimalPublish(global_item_id, shop_id, target, body, logistics, reqAccountKey, retryReason).catch((e: any) => ({ ok: false, region: targetRegion, shop_id, stage: 'minimal_publish_exception', error: String(e?.message || e) }));
            if (retryOutcome?.ok) outcome = retryOutcome;
            else (outcome as any).minimal_item_retry = retryOutcome;
          }
          // Fallback verification: query published_list — BR gets 3 retries (5s apart), others get 1
          let fallbackVerificationStartMs = 0;
          if (!outcome.ok) {
            fallbackVerificationStartMs = Date.now();
            const fbRetries = (targetRegion === 'BR') ? 3 : 1;
            const fbSleep = (targetRegion === 'BR') ? 5000 : 0;
            for (let r = 0; r < fbRetries; r++) {
              if (r > 0) await sleep(fbSleep);
              try {
                const publishedRes = await merchantApiCall(targetRegion, '/api/v2/global_product/get_published_list', { query: { global_item_id, shop_id_list: String(shop_id) }, account_key: reqAccountKey });
                const pubItems = Array.isArray(publishedRes?.response?.published_item) ? publishedRes.response.published_item : [];
                const hit = pubItems.find((p: any) => Number(p.shop_id) === Number(shop_id));
                if (hit && hit.item_id) {
                  outcome = { ok: true, region: targetRegion, shop_id, publish_task_id, item_id: Number(hit.item_id), publish_status: 'verified_via_published_list_retry_' + r, error: null, task };
                  break;
                }
              } catch (_) {}
            }
            regionTiming.fallback_verification = elapsedMs(fallbackVerificationStartMs);
          }
          if (!outcome.ok) {
            const verified = await verifyPublishedListOutcome(targetRegion, shop_id, global_item_id, publish_task_id, task, reqAccountKey).catch(() => null);
            if (verified) outcome = verified;
          }
          if (!outcome.ok) {
            const verified = await verifyPublishedSkuOutcome(targetRegion, shop_id, publish_task_id, task, body?.sku || target?.sku || '', reqAccountKey).catch(() => null);
            if (verified) outcome = verified;
          }
          if (!outcome.ok && targetRegion === 'TW' && !(outcome as any).minimal_item_retry) {
            const retryOutcome = await retryTwMinimalPublish(global_item_id, shop_id, target, body, logistics, reqAccountKey).catch((e: any) => ({ ok: false, region: targetRegion, shop_id, stage: 'tw_minimal_publish_exception', error: String(e?.message || e) }));
            if (retryOutcome?.ok) outcome = retryOutcome;
            else (outcome as any).tw_minimal_item_retry = retryOutcome;
          }
          // BR-only: if still failing and no minimal retry ran, re-issue create_publish_task for the same global_item_id once more.
          if (!outcome.ok && targetRegion === 'BR' && !(outcome as any).minimal_item_retry) {
            try {
              const retryPublishRes = await merchantApiCall(targetRegion, '/api/v2/global_product/create_publish_task', { method: 'POST', body: publishBody, account_key: reqAccountKey });
              if (retryPublishRes.response?.publish_task_id) {
                const retryTaskId = Number(retryPublishRes.response.publish_task_id);
                // Give BR 15s for async resolution before final published_list check
                await sleep(15000);
                const finalPubRes = await merchantApiCall(targetRegion, '/api/v2/global_product/get_published_list', { query: { global_item_id, shop_id_list: String(shop_id) }, account_key: reqAccountKey });
                const finalItems = Array.isArray(finalPubRes?.response?.published_item) ? finalPubRes.response.published_item : [];
                const finalHit = finalItems.find((p: any) => Number(p.shop_id) === Number(shop_id));
                if (finalHit && finalHit.item_id) {
                  outcome = { ok: true, region: 'BR', shop_id, publish_task_id: retryTaskId, item_id: Number(finalHit.item_id), publish_status: 'verified_via_br_retry', error: null, task: retryPublishRes };
                }
              }
            } catch (_) {}
          }
          const finalizeStartMs = Date.now();
          outcome = await finalizePublishOutcomeAfterSuccess(outcome, targetRegion, target, body, reqAccountKey);
          regionTiming.finalize_publish_success = elapsedMs(finalizeStartMs);
          outcome.raw_create = publishRes;
          outcome.raw_task = task;
          outcome.poll_attempts = pollAttempts;
          outcome.timing_ms = { ...regionTiming, total: elapsedMs(regionStartMs) };
          results.push(outcome);
        } catch (e: any) {
          results.push({ ok: false, region: targetRegion, stage: 'publish_exception', error: String(e?.message || e), timing_ms: { ...regionTiming, total: elapsedMs(regionStartMs) } });
        }
      });
      const reconciledResults = await reconcilePublishResultsWithPublishedList(global_item_id, targetInputs, results, reqAccountKey, region);
      const responseResults = reconciledResults.map((row) => ({ account_key: reqAccountKey, ...row }));
      let mappingResults: any = null;
      try {
        const mappingRows = buildShopeePublishMappingRows(global_item_id, { ...body, global_item_id }, targetInputs, responseResults, reqAccountKey, region);
        mappingResults = await persistShopeeRegistrationMappings(reqAccountKey, mappingRows);
      } catch (e: any) {
        mappingResults = { ok: false, error: String(e?.message || e) };
      }
      return jsonResp({ ok: responseResults.every((row: any) => row.ok === true), account_key: reqAccountKey, global_item_id, logistics_repairs: publishLogisticsRepair, regional_target_price_adjustments: regionalTargetPriceAdjustments, br_target_price_adjustments: brTargetPriceAdjustments, results: responseResults, mapping_results: mappingResults });
    }
    if (action === 'oauth_exchange') {
      const app = await getApp(accountKey);
      const verified = await verifyShopeeOAuthCallbackSignature(url, app);
      if (url.searchParams.get('sig') && !verified.ok) {
        return jsonResp({ ok: false, error: verified.error }, 403);
      }
      return await exchangeShopeeOAuthCode(url, accountKey);
    }
    if (action === 'oauth_callback') {
      const app = await getApp(accountKey);
      const verified = await verifyShopeeOAuthCallbackSignature(url, app);
      if (!verified.ok) return jsonResp({ ok: false, error: verified.error }, 403);
      return await exchangeShopeeOAuthCode(url, accountKey);
    }
    if (action === 'merchant_shops') {
      const r = url.searchParams.get('region') || 'SG';
      const result = await merchantApiCall(r, '/api/v2/merchant/get_shop_list_by_merchant', { query: { page_no: 1, page_size: 100 }, account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region: r, result });
    }
    if (action === 'oauth_url') {
      const app = await getApp(accountKey);
      const path = '/api/v2/shop/auth_partner';
      const ts = Math.floor(Date.now() / 1000);
      const base = `${app.partner_id}${path}${ts}`;
      const sign = await hmac(app.partner_key, base);
      const callbackMode = url.searchParams.get('callback') === '1';
      const callbackBaseUrl = Deno.env.get('SUPABASE_URL') || 'https://mgqlwgnmwegzsjelbrih.supabase.co';
      const callbackRedirect = callbackMode
        ? await buildShopeeOAuthCallbackRedirect(callbackBaseUrl, app, {
          account_key: accountKey,
          main_account_id: String(url.searchParams.get('main_account_id') || await mainAccountIdForAccount(accountKey)),
          shop_id: String(url.searchParams.get('shop_id') || ''),
          display_name: String(url.searchParams.get('display_name') || url.searchParams.get('displayName') || accountKey),
          layer_asset_path: String(url.searchParams.get('layer_asset_path') || url.searchParams.get('layerAssetPath') || ''),
        })
        : '';
      const redirect = callbackMode
        ? buildShopeeOAuthRelayRedirect(callbackRedirect)
        : (url.searchParams.get('redirect') || 'https://shopee-dashboard-kohl.vercel.app/v2/');
      const oauthUrl = `https://${host(app.is_sandbox)}${path}?partner_id=${app.partner_id}&timestamp=${ts}&sign=${sign}&redirect=${encodeURIComponent(redirect)}`;
      return jsonResp({ ok: true, account_key: accountKey, oauth_url: oauthUrl, partner_id: app.partner_id, timestamp: ts, path, redirect, callback_redirect: callbackRedirect || null, callback_mode: callbackMode });
    }
    if (action === 'force_refresh_all') {
      const regions = (url.searchParams.get('regions') || 'SG,TW,TH,MY,PH,BR').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      const results: any[] = [];
      let merchant: any = null;
      try {
        merchant = await refreshMerchantRowToken(accountKey);
      } catch (e) {
        merchant = { error: String((e as any)?.message || e) };
      }
      for (const r of regions) {
        try {
          const refreshed = await forceRefreshShopToken(r, accountKey);
          results.push({ account_key: accountKey, region: r, ok: true, shop_id: refreshed.shop_id, expires_at: refreshed.expires_at });
        } catch (e) {
          results.push({ account_key: accountKey, region: r, ok: false, error: String((e as any)?.message || e) });
        }
      }
      return jsonResp({ ok: true, account_key: accountKey, merchant, shops: results });
    }
    if (action === 'account_profile' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      const displayName = String(body.display_name || body.displayName || reqAccountKey).trim() || reqAccountKey;
      const layerAssetPath = String(body.layer_asset_path || body.layerAssetPath || '').trim();
      const rawRegions = Array.isArray(body.enabled_regions || body.enabledRegions)
        ? (body.enabled_regions || body.enabledRegions)
        : String(body.enabled_regions || body.enabledRegions || '').split(',');
      const enabledRegions = [...new Set(rawRegions.map((v: any) => String(v || '').trim().toUpperCase()).filter((v: string) => OPERATING_REGION_SET.has(v)))];
      const mainAccountId = Number(body.main_account_id || body.mainAccountId || 0);
      const merchantId = Number(body.merchant_id || body.merchantId || 0);
      const partnerId = Number(body.partner_id || body.partnerId || 0);
      const partnerKeySecretName = String(body.partner_key_secret_name || body.partnerKeySecretName || '').trim().toUpperCase();
      const isSandbox = body.is_sandbox === true || body.isSandbox === true;

      if (!layerAssetPath) return jsonResp({ ok: false, error: 'layer_asset_path required' }, 400);
      if ((body.partner_id || body.partnerId || partnerKeySecretName) && (!Number.isFinite(partnerId) || partnerId <= 0)) {
        return jsonResp({ ok: false, error: 'valid partner_id required when credential is provided' }, 400);
      }
      if ((body.partner_id || body.partnerId || partnerId) && !/^[A-Z0-9_]{3,128}$/.test(partnerKeySecretName)) {
        return jsonResp({ ok: false, error: 'valid partner_key_secret_name required when credential is provided' }, 400);
      }

      const profilePayload: Record<string, unknown> = {
        account_key: reqAccountKey,
        display_name: displayName,
        layer_asset_path: layerAssetPath,
        enabled_regions: enabledRegions.length ? enabledRegions : OPERATING_REGIONS,
        status: String(body.status || 'active'),
        updated_at: new Date().toISOString(),
      };
      if (Number.isFinite(mainAccountId) && mainAccountId > 0) profilePayload.main_account_id = mainAccountId;
      if (Number.isFinite(merchantId) && merchantId > 0) profilePayload.merchant_id = merchantId;
      const { error: profileErr } = await supabase
        .from('shopee_account_profiles')
        .upsert(profilePayload, { onConflict: 'account_key' });
      if (profileErr) return jsonResp({ ok: false, error: profileErr.message, stage: 'profile_upsert' }, 500);

      let credential: any = null;
      if (Number.isFinite(partnerId) && partnerId > 0 && partnerKeySecretName) {
        const credentialPayload = {
          account_key: reqAccountKey,
          partner_id: partnerId,
          partner_key_secret_name: partnerKeySecretName,
          is_sandbox: isSandbox,
          updated_at: new Date().toISOString(),
        };
        const { error: credErr } = await supabase
          .from('shopee_account_credentials')
          .upsert(credentialPayload, { onConflict: 'account_key' });
        if (credErr) return jsonResp({ ok: false, error: credErr.message, stage: 'credential_upsert' }, 500);
        credential = {
          account_key: reqAccountKey,
          partner_id: partnerId,
          partner_key_secret_name: partnerKeySecretName,
          is_sandbox: isSandbox,
          secret_present: !!Deno.env.get(partnerKeySecretName),
        };
      }
      return jsonResp({ ok: true, account_key: reqAccountKey, profile: profilePayload, credential });
    }
    // POST /register_cbsc: high-level GlobalProduct registration and region publish orchestration.
    // v44: accepts body.idempotency_token (UUID) forwarded from UI card — used as request_id
    //      for the withPublishRequestId gate so duplicate browser submits are blocked.
    //      body.variation.model[] now supports per-model weight_g and image_id fields (§6-1, §2-2).
    if (action === 'register_cbsc' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const accountKey = normalizeAccountKey(body.account_key || body.accountKey || url.searchParams.get('account_key') || url.searchParams.get('accountKey'));
      body.account_key = accountKey;
      // Keep older UI callers protected by the publish_request_id idempotency gate.
      if (!body.publish_request_id && body.idempotency_token) body.publish_request_id = String(body.idempotency_token);
      const targetInputs = (Array.isArray(body.targets) && body.targets.length ? body.targets : [body])
        .map((t: any) => ({ ...t, region: t.region || r }))
        .filter((t: any) => t.region);
      if (!body.name) return jsonResp({ ok: false, error: 'name required' }, 400);
      if (!body.category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      if (!targetInputs.length) return jsonResp({ ok: false, error: 'targets required' }, 400);
      const regionalGlobalPriceAdjustments = normalizeRegionalGlobalModelPriceRatio(body, targetInputs);
      const regionalTargetPriceAdjustments = normalizeRegionalTargetModelPriceRatio(targetInputs);
      const brGlobalPriceAdjustments = regionalGlobalPriceAdjustments.filter((adjustment: any) => (adjustment?.regions || []).includes('BR'));
      const brTargetPriceAdjustments = regionalTargetPriceAdjustments.filter((adjustment: any) => String(adjustment?.region || '').toUpperCase() === 'BR');

      let preflightVariation: any = null;
      try {
        const variationCandidates = [body.variation, ...targetInputs.map((t: any) => t.variation)].filter(Boolean);
        for (const candidate of variationCandidates) {
          const normalized = normalizeVariation(candidate);
          if (normalized && !preflightVariation) preflightVariation = normalized;
        }
      } catch (e: any) {
        return jsonResp({
          ok: false,
          region: r,
          stage: 'variation_preflight',
          error: 'invalid_variation',
          message: String(e?.message || e),
        }, 400);
      }
      const isOptionGroupRegistration = String(body.registration_kind || '').toLowerCase() === 'option_group' || !!preflightVariation;
      if (!body.sku && !isOptionGroupRegistration) return jsonResp({ ok: false, error: 'sku required' }, 400);
      if (!hasShopeeProductImageInput(body)) {
        return jsonResp({
          ok: false,
          region: r,
          stage: 'image_preflight',
          error: 'image_id_list_required',
          message: 'Product image_id_list or image_url is required before Shopee registration.',
        }, 400);
      }
      const stockPreflightMessage = validateRegisterStockInput(body, preflightVariation, targetInputs);
      if (stockPreflightMessage) {
        return jsonResp({
          ok: false,
          region: r,
          stage: 'stock_preflight',
          error: 'invalid_stock',
          message: stockPreflightMessage,
        }, 400);
      }
      const pricePreflightMessage = validateRegisterPriceInput(body, preflightVariation, targetInputs);
      if (pricePreflightMessage) {
        return jsonResp({
          ok: false,
          region: r,
          stage: 'price_preflight',
          error: 'invalid_price',
          message: pricePreflightMessage,
        }, 400);
      }

      return withPublishRequestId(action, `${accountKey}:${r}`, null, body, async () => {
      const registrationTiming = createShopeeTimingRecorder();
      const stage_logs: string[] = [];
      if (regionalGlobalPriceAdjustments.length) {
        const firstAdjustment = regionalGlobalPriceAdjustments[0] || {};
        const regions = (firstAdjustment.regions || []).join(',') || 'unknown';
        stage_logs.push(`regional_global_model_price_ratio_normalized: ${regionalGlobalPriceAdjustments.length} model(s), regions=${regions}, ratio=${firstAdjustment.ratio || 'unknown'}, min=${firstAdjustment.min_price || 'unknown'}->${firstAdjustment.to || 'unknown'}, max=${firstAdjustment.max_price || 'unknown'}, safe_ratio=${firstAdjustment.safe_ratio || 'unknown'}`);
      }
      if (regionalTargetPriceAdjustments.length) {
        const firstAdjustment = regionalTargetPriceAdjustments[0] || {};
        stage_logs.push(`regional_target_model_price_ratio_normalized: ${regionalTargetPriceAdjustments.length} model(s), region=${firstAdjustment.region || 'unknown'}, ratio=${firstAdjustment.ratio || 'unknown'}, min=${firstAdjustment.min_price || 'unknown'}->${firstAdjustment.to || 'unknown'}, max=${firstAdjustment.max_price || 'unknown'}, safe_ratio=${firstAdjustment.safe_ratio || 'unknown'}`);
      }
      const categoryAttributeStartMs = Date.now();
      const catAttrs = await buildCategoryAttributeListForRegions(r, targetInputs.map((target: any) => target.region), Number(body.category_id), Array.isArray(body.attribute_list) ? body.attribute_list : [], accountKey);
      registrationTiming.mark('category_attributes', categoryAttributeStartMs);
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

      // Global Product DTS is fixed by lifecycle: Ready Stock=1,
      // Pre-Order=10. Per-region DTS is applied separately in each
      // create_publish_task call.
      const _isPreOrderRegister = body.is_pre_order === true || body.lifecycle_state === 'pre_order';
      const _globalDts = resolveGlobalProductDts({ ...body, is_pre_order: _isPreOrderRegister });
      const addPayload = buildGlobalItemPayload({
        ...body,
        attribute_list: catAttrs.attribute_list,
        price: Number(body.global_price ?? body.price ?? targetInputs[0]?.price),
        stock: Number(body.stock ?? targetInputs[0]?.stock ?? 0),
        weight_g: Number(body.weight_g ?? targetInputs[0]?.weight_g ?? 100),
        days_to_ship: _globalDts,
        is_pre_order: _isPreOrderRegister,
      });
      const addGlobalItemStartMs = Date.now();
      const addRes = await merchantApiCall(r, '/api/v2/global_product/add_global_item', { method: 'POST', body: addPayload, account_key: accountKey });
      registrationTiming.mark('add_global_item', addGlobalItemStartMs);
      if (addRes.error) {
        const dbg = String(addRes?.debug_message || '');
        if (/Attribute is mandatory/i.test(dbg) || /CD,\s*DVD\s*&\s*Bluray\s*Type/i.test(`${addRes?.message || ''} ${dbg}`)) {
          const parsed = parseMandatoryFromDebug(`${addRes?.message || ''} ${dbg}`);
          const miss = (parsed.length ? parsed : catAttrs.missing).map((a: any) => ({
            attribute_id: a.attribute_id ?? null,
            attribute_name: a.attribute_name || a.name || 'unknown',
            options: a.options || [],
          }));
          return jsonResp({
            ok: false,
            region: r,
            stage: 'add_global_item',
            error: addRes.error,
            message: addRes.message,
            missing_attributes: miss,
            sent: addPayload,
            raw: addRes,
          }, 502);
        }
        if (addRes.error) return jsonResp({ ok: false, region: r, stage: 'add_global_item', error: addRes.error, message: addRes.message, sent: addPayload, raw: addRes }, 502);
      }
      const global_item_id = addRes.response?.global_item_id;
      if (!global_item_id) return jsonResp({ ok: false, region: r, stage: 'add_global_item', error: 'no global_item_id', raw: addRes }, 502);
      body.global_item_id = global_item_id;
      stage_logs.push(`add_global_item ok: global_item_id=${global_item_id}`);

      // §6-1 failure state machine: variation setup with explicit stage tracking.
      // init_tier_variation failure → auto delete_global_item (cleanup orphan).
      // add_global_model partial failure → no auto cleanup (dangerous), return partial_published.
      const baseVariation = preflightVariation;
      if (baseVariation) {
        const globalModels = buildGlobalModels(baseVariation, Number(body.global_price ?? body.price ?? targetInputs[0]?.price), Number(body.stock ?? 0));
        const initTierVariationStartMs = Date.now();
        const initRes = await merchantApiCall(r, '/api/v2/global_product/init_tier_variation', {
          method: 'POST',
          body: { global_item_id, tier_variation: baseVariation.tier_variation, global_model: [globalModels[0]] },
          account_key: accountKey,
        });
        registrationTiming.mark('init_tier_variation', initTierVariationStartMs);
        if (initRes.error) {
          // §6-1: init_tier_variation failed → orphan global_item exists. Auto-cleanup.
          stage_logs.push(`init_tier_variation FAILED: ${initRes.error} — attempting delete_global_item cleanup`);
          let cleanupState = 'cleanup_required';
          try {
            const delRes = await merchantApiCall(r, '/api/v2/global_product/delete_global_item', {
              method: 'POST',
              body: { global_item_id },
              account_key: accountKey,
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
          const addGlobalModelStartMs = Date.now();
          const addModelRes = await merchantApiCall(r, '/api/v2/global_product/add_global_model', {
            method: 'POST',
            body: addModelPayload,
            account_key: accountKey,
          });
          registrationTiming.mark('add_global_model', addGlobalModelStartMs);
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
        const psRes = await merchantApiCall(r, '/api/v2/global_product/get_publishable_shop', { query: { global_item_id }, account_key: accountKey });
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
        const stRes = await merchantApiCall(r, '/api/v2/global_product/get_shop_publishable_status', { query: { global_item_id, offset: 0, page_size: 100 }, account_key: accountKey });
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
      const publishRegionsStartMs = Date.now();
      await mapWithConcurrency(targetInputs, 2, async (target: any) => {
        const targetRegion = String(target.region || '').toUpperCase();
        const regionStartMs = Date.now();
        const regionTiming: Record<string, number> = {};
        try {
          // Prefer caller-provided shop_id; only fall back to region default when omitted.
          // Ignoring the caller's shop_id (old behaviour) would publish to the wrong shop
          // when an explicit non-default shop is passed (e.g. a second shop in the same region).
          const shop_id = target.shop_id ? Number(target.shop_id) : await getRegionShopId(targetRegion, accountKey);
          // Defense-in-depth: block permanently-banned shop IDs even inside the bridge.
          const BRIDGE_BANNED_SHOP_IDS = new Set([1002269093]);
          if (BRIDGE_BANNED_SHOP_IDS.has(shop_id)) {
            results.push({ ok: false, region: targetRegion, shop_id, stage: 'banned_shop', error: 'shop_id is permanently banned', message: `shop_id ${shop_id} is banned and cannot be published to` });
            return;
          }
          // Pre-check: if KRSC reported this shop as unpublishable, surface the
          // reason verbatim instead of letting create_publish_task return a
          // generic failure with a misleading message.
          const blockedReason = unpublishableByShop.get(shop_id);
          if (blockedReason) {
            results.push({ ok: false, region: targetRegion, shop_id, stage: 'shop_unpublishable', error: 'shop_unpublishable', message: blockedReason });
            return;
          }
          const logistics = await getPublishLogistics(targetRegion, _isPreOrderRegister, accountKey);
          const brMinimalFirst = await publishBrOptionMinimalFirst(global_item_id, shop_id, target, body, logistics, accountKey).catch((e: any) => ({
            ok: false,
            region: targetRegion,
            shop_id,
            stage: 'br_option_minimal_first_exception',
            error: String(e?.message || e),
            br_option_minimal_first: true,
          }));
          if (brMinimalFirst) {
            results.push(brMinimalFirst);
            return;
          }
          const item = buildPublishItemPayload({ ...body, image_id: target.image_id || body.image_id, image_url: target.image_url || body.image_url, image_id_list: target.image_id_list || body.image_id_list, image_url_list: target.image_url_list || body.image_url_list }, target, logistics);
          const publishBody = { global_item_id, shop_id, shop_region: targetRegion, item };
          const createPublishStartMs = Date.now();
          const publishRes = await merchantApiCall(targetRegion, '/api/v2/global_product/create_publish_task', { method: 'POST', body: publishBody, account_key: accountKey });
          regionTiming.create_publish_task = elapsedMs(createPublishStartMs);
          if (publishRes.error) {
            if (/published this global item to the same shop already/i.test(`${publishRes.message || ''} ${publishRes.debug_message || ''}`)) {
              const verified = await verifyPublishedListOutcome(targetRegion, shop_id, global_item_id, 0, publishRes, accountKey).catch(() => null);
              if (verified) {
                verified.publish_status = 'verified_via_already_published_create_error';
                verified.raw_create = publishRes;
                results.push(await finalizePublishOutcomeAfterSuccess(verified, targetRegion, target, body, accountKey));
                return;
              }
            }
            const createFailure: any = { ok: false, region: targetRegion, shop_id, stage: 'create_publish_task', error: publishRes.error, message: publishRes.message, raw: publishRes, timing_ms: { ...regionTiming, total: elapsedMs(regionStartMs) } };
            if (targetRegion === 'BR' && hasOptionVariationPayload(target, body) && isCrossuploadPermissionPublishFailure(createFailure, publishRes)) {
              const retryOutcome = await retryMinimalPublish(global_item_id, shop_id, target, body, logistics, accountKey, 'br_existing_global_crossupload_create_retry').catch((e: any) => ({ ok: false, region: targetRegion, shop_id, stage: 'minimal_publish_exception', error: String(e?.message || e) }));
              if (retryOutcome?.ok) results.push(await finalizePublishOutcomeAfterSuccess(retryOutcome, targetRegion, target, body, accountKey));
              else results.push(markBrOptionCrossuploadBlocked({ ...createFailure, minimal_item_retry: retryOutcome }, null, publishRes, { global_item_id, minimal_item_retry: retryOutcome }));
              return;
            }
            if (shouldTryMinimalPublishFallback(createFailure, publishRes)) {
              const retryReason = isCrossuploadPermissionPublishFailure(createFailure, publishRes)
                ? 'crossupload_permission_create_retry'
                : isAmbiguousLocalPublishFailure(createFailure, publishRes)
                  ? 'ambiguous_local_publish_create_retry'
                  : 'variation_invalid_create_retry';
              const retryOutcome = await retryMinimalPublish(global_item_id, shop_id, target, body, logistics, accountKey, retryReason).catch((e: any) => ({ ok: false, region: targetRegion, shop_id, stage: 'minimal_publish_exception', error: String(e?.message || e) }));
              if (retryOutcome?.ok) results.push(await finalizePublishOutcomeAfterSuccess(retryOutcome, targetRegion, target, body, accountKey));
              else results.push({ ...createFailure, minimal_item_retry: retryOutcome });
              return;
            }
            results.push(createFailure);
            return;
          }
          const publish_task_id = Number(publishRes.response?.publish_task_id);
          console.log(`[register_cbsc] region=${targetRegion} shop_id=${shop_id} publish_task_id=${publish_task_id} create_publish_task_response=${JSON.stringify(publishRes).slice(0, 800)}`);
          let task: any = null;
          let pollAttempts = 0;
          let pollWaitMs = 0;
          let earlyPublishedOutcome: any = null;
          // BR publish async is slower — double the polling window for BR only
          const maxPoll = (targetRegion === 'BR') ? SHOPEE_BR_MAX_PUBLISH_POLLS : 30;
          const pollingStartMs = Date.now();
          for (let i = 0; i < maxPoll; i++) {
            const pollDelayMs = nextPublishTaskPollDelayMs(i, targetRegion);
            pollWaitMs += pollDelayMs;
            await sleep(pollDelayMs);
            const taskRes = await merchantApiCall(targetRegion, '/api/v2/global_product/get_publish_task_result', { query: { publish_task_id }, account_key: accountKey });
            task = taskRes;
            pollAttempts = i + 1;
            if (shouldVerifyPublishedListDuringPublishPolling(targetRegion, pollAttempts)) {
              earlyPublishedOutcome = await verifyPublishedListOutcomeOnce(targetRegion, shop_id, global_item_id, publish_task_id, task, accountKey, 'verified_via_early_published_list_' + pollAttempts).catch(() => null);
              if (earlyPublishedOutcome) break;
            }
            if (isCrossuploadPermissionPublishFailure(taskRes)) break;
            if (!shouldContinuePublishPolling(taskRes)) break;
          }
          regionTiming.publish_task_polling = elapsedMs(pollingStartMs);
          regionTiming.publish_task_poll_wait = pollWaitMs;
          console.log(`[register_cbsc] region=${targetRegion} publish_task_id=${publish_task_id} poll_attempts=${pollAttempts} final_task=${JSON.stringify(task).slice(0, 1200)}`);
          let outcome = earlyPublishedOutcome || parsePublishOutcome(targetRegion, shop_id, publish_task_id, task);
          if (!outcome.ok && targetRegion === 'BR' && hasOptionVariationPayload(target, body) && isCrossuploadPermissionPublishFailure(outcome, task, publishRes)) {
            const retryOutcome = await retryMinimalPublish(global_item_id, shop_id, target, body, logistics, accountKey, 'br_existing_global_crossupload_task_retry').catch((e: any) => ({ ok: false, region: targetRegion, shop_id, stage: 'minimal_publish_exception', error: String(e?.message || e) }));
            outcome = retryOutcome?.ok
              ? retryOutcome
              : markBrOptionCrossuploadBlocked({ ...outcome, minimal_item_retry: retryOutcome }, task, publishRes, { global_item_id, minimal_item_retry: retryOutcome });
          }
          if (!outcome.ok && !(outcome as any).br_option_crossupload_blocked && shouldTryMinimalPublishFallback(outcome, task, publishRes)) {
            const retryReason = isCrossuploadPermissionPublishFailure(outcome, task, publishRes)
              ? 'crossupload_permission_task_retry'
              : isAmbiguousLocalPublishFailure(outcome, task, publishRes)
                ? 'ambiguous_local_publish_task_retry'
                : 'variation_invalid_task_retry';
            const retryOutcome = await retryMinimalPublish(global_item_id, shop_id, target, body, logistics, accountKey, retryReason).catch((e: any) => ({ ok: false, region: targetRegion, shop_id, stage: 'minimal_publish_exception', error: String(e?.message || e) }));
            if (retryOutcome?.ok) outcome = retryOutcome;
            else (outcome as any).minimal_item_retry = retryOutcome;
          }
          outcome.raw_create = publishRes;
          outcome.raw_task = task;
          outcome.poll_attempts = pollAttempts;
          // Fallback verification: if parser declared failure but the task may still be
          // resolving async on Shopee's side, query published_list and check whether the
          // global_item_id has actually surfaced as a shop item.
          // BR gets 3 retries (5s apart), other regions get 1 attempt.
          let fallbackVerificationStartMs = 0;
          if (!outcome.ok) {
            fallbackVerificationStartMs = Date.now();
            const fbRetries = (targetRegion === 'BR') ? 3 : 1;
            const fbSleep = (targetRegion === 'BR') ? 5000 : 0;
            for (let r = 0; r < fbRetries; r++) {
              if (r > 0) await sleep(fbSleep);
              try {
                const publishedRes = await merchantApiCall(targetRegion, '/api/v2/global_product/get_published_list', { query: { global_item_id, shop_id_list: String(shop_id) }, account_key: accountKey });
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
          if (fallbackVerificationStartMs) regionTiming.fallback_verification = elapsedMs(fallbackVerificationStartMs);
          if (!outcome.ok) {
            const verified = await verifyPublishedListOutcome(targetRegion, shop_id, global_item_id, publish_task_id, task, accountKey).catch(() => null);
            if (verified) outcome = verified;
          }
          if (!outcome.ok) {
            const verified = await verifyPublishedSkuOutcome(targetRegion, shop_id, publish_task_id, task, body?.sku || target?.sku || '', accountKey).catch(() => null);
            if (verified) outcome = verified;
          }
          if (!outcome.ok && targetRegion === 'TW' && !(outcome as any).minimal_item_retry) {
            const retryOutcome = await retryTwMinimalPublish(global_item_id, shop_id, target, body, logistics, accountKey).catch((e: any) => ({ ok: false, region: targetRegion, shop_id, stage: 'tw_minimal_publish_exception', error: String(e?.message || e) }));
            if (retryOutcome?.ok) outcome = retryOutcome;
            else (outcome as any).tw_minimal_item_retry = retryOutcome;
          }
          // BR-only: if still failing and no minimal retry ran, re-issue create_publish_task for the same global_item_id once more.
          if (!outcome.ok && targetRegion === 'BR' && !(outcome as any).minimal_item_retry) {
            try {
              stage_logs.push('BR retry: re-creating publish_task');
              const retryPublishRes = await merchantApiCall(targetRegion, '/api/v2/global_product/create_publish_task', { method: 'POST', body: publishBody, account_key: accountKey });
              if (retryPublishRes.response?.publish_task_id) {
                const retryTaskId = Number(retryPublishRes.response.publish_task_id);
                // Give BR 15s for async resolution before final published_list check
                await sleep(15000);
                const finalPubRes = await merchantApiCall(targetRegion, '/api/v2/global_product/get_published_list', { query: { global_item_id, shop_id_list: String(shop_id) }, account_key: accountKey });
                const finalItems = Array.isArray(finalPubRes?.response?.published_item) ? finalPubRes.response.published_item : [];
                const finalHit = finalItems.find((p: any) => Number(p.shop_id) === Number(shop_id));
                if (finalHit && finalHit.item_id) {
                  outcome = { ok: true, region: 'BR', shop_id, publish_task_id: retryTaskId, item_id: Number(finalHit.item_id), publish_status: 'verified_via_br_retry', error: null, task: retryPublishRes };
                }
              }
            } catch (_) {}
          }
          const finalizeStartMs = Date.now();
          outcome = await finalizePublishOutcomeAfterSuccess(outcome, targetRegion, target, body, accountKey);
          regionTiming.finalize_publish_success = elapsedMs(finalizeStartMs);
          outcome.timing_ms = { ...regionTiming, total: elapsedMs(regionStartMs) };
          results.push(outcome);
        } catch (e: any) {
          results.push({ ok: false, region: target.region || r, stage: 'publish_exception', error: String(e?.message || e), timing_ms: { ...regionTiming, total: elapsedMs(regionStartMs) } });
        }
      });
      registrationTiming.mark('publish_regions', publishRegionsStartMs);
      const reconciledResults = await reconcilePublishResultsWithPublishedList(global_item_id, targetInputs, results, accountKey, r, stage_logs);
      const responseResults = reconciledResults.map((row) => ({ account_key: accountKey, ...row }));
      let mappingResults: any = null;
      const mappingStartMs = Date.now();
      try {
        const mappingRows = buildShopeePublishMappingRows(global_item_id, body, targetInputs, responseResults, accountKey, r);
        mappingResults = await persistShopeeRegistrationMappings(accountKey, mappingRows);
      } catch (e: any) {
        mappingResults = { ok: false, error: String(e?.message || e) };
      }
      registrationTiming.mark('mapping', mappingStartMs);
      return jsonResp({ ok: responseResults.every((row: any) => row.ok === true), account_key: accountKey, region: r, global_item_id, stage_logs, regional_global_price_adjustments: regionalGlobalPriceAdjustments, regional_target_price_adjustments: regionalTargetPriceAdjustments, br_global_price_adjustments: brGlobalPriceAdjustments, br_target_price_adjustments: brTargetPriceAdjustments, results: responseResults, mapping_results: mappingResults, publishable_shops, publishable_status, timing_ms: registrationTiming.snapshot() });
      }); // end withPublishRequestId for register_cbsc
    }
    if (action === 'item_info') {
      const item_id = parseInt(url.searchParams.get('item_id') || '0');
      if (!item_id) return jsonResp({ ok: false, error: 'item_id required' }, 400);
      const result = await shopApiCall(region, '/api/v2/product/get_item_base_info', { query: { item_id_list: item_id }, account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region, item_id, result });
    }
    if (action === 'lookup-sku' && req.method === 'POST') {
      const sku = shopeeSkuValue(url.searchParams.get('sku'));
      if (!sku) return jsonResp({ ok: false, error: 'sku required' }, 400);
      const requestedRegions = String(url.searchParams.get('regions') || url.searchParams.get('region') || region || 'SG')
        .split(',')
        .map((r) => r.trim().toUpperCase())
        .filter(Boolean);
      const requestedMaxScanItems = parseInt(url.searchParams.get('max_scan_items') || '5000');
      const maxScanItems = Number.isFinite(requestedMaxScanItems) ? Math.max(1, Math.min(requestedMaxScanItems, 5000)) : 5000;
      const lookup = await lookupShopeeSkuAcrossRegions(requestedRegions, sku, maxScanItems, accountKey);
      return jsonResp({
        ok: true,
        account_key: accountKey,
        sku,
        regions: requestedRegions,
        found: lookup.found,
        not_found: lookup.not_found,
        region_hits: lookup.region_hits,
        region_results: lookup.region_results,
        source_docs: [
          'docs_ai/apis/product/v2.product.search_item.json:item_sku',
          'docs_ai/apis/product/v2.product.get_model_list.json:model_sku',
        ],
      });
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
        itemInfoResult = await shopApiCall(r, '/api/v2/product/get_item_base_info', { query: { item_id_list: item_id }, account_key: accountKey });
        if (itemInfoResult.error) {
          return jsonResp({ ok: false, account_key: accountKey, region: r, item_id, error: itemInfoResult.error, result: itemInfoResult }, 500);
        }
        const itemList = itemInfoResult.response?.item_list || [];
        itemInfo = Array.isArray(itemList) ? itemList[0] || null : null;
        category_id = Number(itemInfo?.category_id || 0);
        if (!category_id) {
          return jsonResp({ ok: false, account_key: accountKey, region: r, item_id, error: 'category_id not found for item', result: itemInfoResult }, 404);
        }
      }
      const result = await shopApiCall(r, '/api/v2/product/get_item_limit', { query: { category_id }, account_key: accountKey });
      if (result.error) {
        return jsonResp({ ok: false, account_key: accountKey, region: r, category_id, item_id: item_id || null, error: result.error, result }, 500);
      }
      const dts_limit = result.response?.dts_limit || result.dts_limit || null;
      const range = dts_limit?.days_to_ship_limit || null;
      const min_limit = Number(range?.min_limit);
      const max_limit = Number(range?.max_limit);
      const non_pre_order_days_to_ship = Number(dts_limit?.non_pre_order_days_to_ship);
      const support_pre_order = dts_limit?.support_pre_order !== false;
      return jsonResp({
        ok: true,
        account_key: accountKey,
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
      const r = await listItemsForRegion(region, item_status, max_items, accountKey);
      if ((r as any).error) return jsonResp({ ok: false, account_key: accountKey, region, ...r }, 502);
      return jsonResp({ ok: true, account_key: accountKey, region, count: (r as any).count, items: (r as any).items });
    }
    if (action === 'lookup-sku' && req.method === 'GET') {
      const sku = String(url.searchParams.get('sku') || '').trim();
      if (!sku) return jsonResp({ ok: false, error: 'sku required' }, 400);
      const requestedRegions = parseTargetRegions(url.searchParams.get('regions') || url.searchParams.get('region'));
      const rawMaxItems = parseInt(url.searchParams.get('max_items') || '5000');
      const max_items = Math.max(1, Math.min(5000, Number.isFinite(rawMaxItems) ? rawMaxItems : 5000));
      const rawMaxGlobalItems = parseInt(url.searchParams.get('max_global_items') || '300');
      const max_global_items = Math.max(1, Math.min(1000, Number.isFinite(rawMaxGlobalItems) ? rawMaxGlobalItems : 300));
      const allowRemoteScan = ['1', 'true', 'yes'].includes(String(url.searchParams.get('remote') || url.searchParams.get('scan') || '').toLowerCase());
      const region_results: any[] = [];
      const region_hits: any[] = [];
      const global_region_hits: any[] = [];
      let global_lookup: any = null;

      const productRows: any[] = [];
      const primary = await supabase
        .from('products')
        .select('id,sku,shopee_item_id,global_model_id,shopee_global_model_sku,product_name,option_name')
        .eq('sku', sku);
      if (!primary.error && Array.isArray(primary.data)) productRows.push(...primary.data);
      const modelSku = await supabase
        .from('products')
        .select('id,sku,shopee_item_id,global_model_id,shopee_global_model_sku,product_name,option_name')
        .eq('shopee_global_model_sku', sku);
      if (!modelSku.error && Array.isArray(modelSku.data)) {
        for (const row of modelSku.data) {
          if (!productRows.some((p) => String(p.id) === String(row.id))) productRows.push(row);
        }
      }

      let listingRows: any[] = [];
      if (productRows.length) {
        const productById = new Map(productRows.map((row: any) => [String(row.id), row]));
        const listingResult = await supabase
          .from('product_shopee_listings')
          .select('product_id,account_key,region,shop_id,shop_item_id,shop_model_id,global_item_id,global_model_id,status,last_synced_price,last_synced_at')
          .eq('account_key', accountKey)
          .in('product_id', productRows.map((row: any) => row.id))
          .in('region', requestedRegions);
        if (listingResult.error) {
          return jsonResp({ ok: false, account_key: accountKey, sku, error: listingResult.error.message || 'listing lookup failed' }, 500);
        }
        listingRows = listingResult.data || [];
        const byRegion = new Map<string, any[]>();
        for (const row of listingRows) {
          const r = String(row.region || '').toUpperCase();
          if (!r || !row.shop_item_id) continue;
          const product = productById.get(String(row.product_id)) || {};
          const hit = {
            source: 'product_shopee_listings',
            region: r,
            shop_id: row.shop_id || null,
            shop_item_id: row.shop_item_id,
            item_id: row.shop_item_id,
            shop_model_id: row.shop_model_id || null,
            model_id: row.shop_model_id || null,
            global_item_id: row.global_item_id || null,
            global_model_id: row.global_model_id || null,
            item_sku: product.sku || sku,
            base_sku: product.sku || null,
            item_name: [product.product_name, product.option_name].filter(Boolean).join(' - '),
            current_price: row.last_synced_price ?? null,
            original_price: row.last_synced_price ?? null,
            currency: '',
            status: row.status || 'mapped',
            item_status: row.status || 'mapped',
            has_model: !!row.shop_model_id,
            last_synced_at: row.last_synced_at || null,
          };
          if (!byRegion.has(r)) byRegion.set(r, []);
          byRegion.get(r)!.push(hit);
        }
        for (const r of requestedRegions) {
          const matches = byRegion.get(r) || [];
          const hit = matches[0] || null;
          if (hit) region_hits.push(hit);
          region_results.push({ region: r, ok: true, source: 'product_shopee_listings', hit, matches, count: matches.length });
        }
      }
      const remoteSearchTerms = shopeeSkuLookupNameTerms([
        ...url.searchParams.getAll('item_name'),
        url.searchParams.get('product_name'),
        url.searchParams.get('name'),
        ...productRows.flatMap((row: any) => [
        row?.product_name,
        [row?.product_name, row?.option_name].filter(Boolean).join(' '),
        ]),
      ]);
      const globalItemIds = [
        ...url.searchParams.getAll('global_item_id').flatMap((value) => String(value || '').split(',')),
        ...productRows.map((row: any) => row?.shopee_item_id),
        ...listingRows.map((row: any) => row?.global_item_id),
      ]
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0);
      global_lookup = await lookupShopeeGlobalSku('SG', sku, max_global_items, accountKey, {
        itemNameTerms: remoteSearchTerms,
        globalItemIds,
      });
      if (global_lookup?.found && global_lookup.hit) {
        for (const r of requestedRegions) {
          global_region_hits.push({
            ...global_lookup.hit,
            source: global_lookup.hit.lookup_source || 'global_model_list',
            region: r,
          });
        }
        const publishedLookup = await lookupShopeePublishedGlobalSkuAcrossRegions(requestedRegions, sku, global_lookup.hit, accountKey);
        for (const hit of publishedLookup.region_hits || []) region_hits.push(hit);
        if (Array.isArray(publishedLookup.errors) && publishedLookup.errors.length) {
          global_lookup.published_errors = publishedLookup.errors;
        }
      }

      const hitRegions = new Set(region_hits.map((hit: any) => String(hit?.region || '').toUpperCase()).filter(Boolean));
      const remoteRegions = requestedRegions.filter((r) => !hitRegions.has(r));
      if (remoteRegions.length) {
        const lookup = await lookupShopeeSkuAcrossRegions(remoteRegions, sku, max_items, accountKey, { scanFallback: allowRemoteScan, itemNameTerms: remoteSearchTerms });
        for (const hit of lookup.region_hits || []) region_hits.push(hit);
        const remoteByRegion = new Map((lookup.region_results || []).map((row: any) => [String(row?.region || '').toUpperCase(), row]));
        for (const r of remoteRegions) {
          const result: any = remoteByRegion.get(r) || { region: r, found: false, not_found: true, errors: [] };
          const hit = result?.hit || null;
          const lookupSource = String(hit?.lookup_source || '');
          const source = lookupSource.startsWith('scan_') ? 'remote_list_items' : (lookupSource || (allowRemoteScan ? 'remote_list_items' : 'remote_search_item'));
          const matches = hit ? [hit] : [];
          const existingIndex = region_results.findIndex((row: any) => String(row?.region || '').toUpperCase() === r);
          const row = {
            region: r,
            ok: !result?.error,
            source,
            hit,
            matches,
            count: matches.length,
            not_found: result?.not_found === true,
            errors: result?.errors || [],
            search_item_ids: result?.search_item_ids || [],
            search_item_name: result?.search_item_name || null,
            scanned_status: result?.scanned_status || null,
            scanned_count: result?.scanned_count || null,
          };
          if (existingIndex >= 0) region_results[existingIndex] = row;
          else region_results.push(row);
        }
      } else if (!region_results.length) {
        for (const r of requestedRegions) {
          region_results.push({ region: r, ok: true, source: 'product_shopee_listings', hit: null, matches: [], count: 0 });
        }
      }

      return jsonResp({
        ok: true,
        account_key: accountKey,
        sku,
        regions: requestedRegions,
        found: region_hits.length > 0 || global_region_hits.length > 0,
        not_found: region_hits.length === 0 && global_region_hits.length === 0 && region_results.every((row: any) => row?.not_found === true || row?.count === 0),
        region_hits,
        global_region_hits,
        global_lookup,
        region_results,
        source_docs: [
          'docs_ai/apis/product/v2.product.search_item.json:item_sku',
          'docs_ai/apis/product/v2.product.search_item.json:item_name',
          'docs_ai/apis/product/v2.product.get_model_list.json:model_sku',
          'docs_ai/apis/global_product/v2.global_product.get_global_item_list.json:global_item_id',
          'docs_ai/apis/global_product/v2.global_product.get_global_item_info.json:global_item_sku',
          'docs_ai/apis/global_product/v2.global_product.get_global_model_list.json:global_model_sku',
          'docs_ai/apis/global_product/v2.global_product.get_published_list.json:item_id',
        ],
      });
    }
    if (action === 'batch_update_outlet_price' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      const r = normalizeRegion(body.region || region);
      if (!r) return jsonResp({ ok: false, error: 'invalid_region', allowed_regions: OPERATING_REGIONS }, 400);

      const normalized = normalizeBatchOutletPriceItemList(body.item_list);
      if (!normalized.ok) return jsonResp({ ok: false, error: 'invalid_item_list', errors: normalized.errors }, 400);

      const requestPayload = { account_key: reqAccountKey, item_list: normalized.item_list };
      const payloadHash = await sha256Hex({ action, account_key: reqAccountKey, region: r, request_payload: requestPayload });
      if (body.dry_run === true) {
        return jsonResp({
          ok: true,
          dry_run: true,
          account_key: reqAccountKey,
          region: r,
          sent_item_list: normalized.item_list,
          payload_hash: payloadHash,
          will_call_shopee_price_api: false,
          source_docs: ['docs_ai/apis/product/v2.product.batch_update_outlet_price.json'],
          confirmation_required_for_live: {
            confirm_live_batch_update_outlet_price: SHOPEE_BATCH_PRICE_CONFIRMATION,
          },
        });
      }
      if (String(body.confirm_live_batch_update_outlet_price || '') !== SHOPEE_BATCH_PRICE_CONFIRMATION) {
        return jsonResp({
          ok: false,
          error: 'live_batch_price_confirmation_required',
          message: `Set confirm_live_batch_update_outlet_price="${SHOPEE_BATCH_PRICE_CONFIRMATION}" to call Shopee batch_update_outlet_price.`,
          account_key: reqAccountKey,
          region: r,
          payload_hash: payloadHash,
          will_call_shopee_price_api: false,
        }, 428);
      }

      const previous = await findOkMutation(payloadHash);
      if (previous) {
        audit('batch_update_outlet_price_idempotent_skip', { account_key: reqAccountKey, region: r, payload_hash: payloadHash, previous_log_id: previous.id });
        return jsonResp({
          ok: true,
          skipped: true,
          previous_log_id: previous.id,
          account_key: reqAccountKey,
          region: r,
          sent_item_list: normalized.item_list,
          payload_hash: payloadHash,
          rollback_policy: V2_ROLLBACK_POLICY,
        });
      }

      const started = Date.now();
      const result = await shopApiCall(r, '/api/v2/product/batch_update_outlet_price', {
        method: 'POST',
        body: { item_list: normalized.item_list },
        account_key: reqAccountKey,
      });
      const durationMs = Date.now() - started;
      const taskId = result?.response?.task_id || null;
      const ok = !result.error && !!taskId;
      const errorMsg = ok ? null : `${result?.error || 'missing_task_id'} ${result?.message || ''}`.trim();
      const log = await insertMutationLog({
        action: 'batch_update_outlet_price',
        region: r,
        payloadHash,
        requestPayload,
        status: ok ? 'ok' : 'error',
        response: result,
        errorMsg,
        requestId: result?.request_id || null,
        durationMs,
        body: { ...body, account_key: reqAccountKey },
      });
      return jsonResp({
        ok,
        account_key: reqAccountKey,
        region: r,
        task_id: taskId,
        sent_item_list: normalized.item_list,
        result,
        payload_hash: payloadHash,
        log_id: log.id || null,
        rollback_policy: V2_ROLLBACK_POLICY,
      });
    }
    if (action === 'batch_task_result' && req.method === 'GET') {
      const r = normalizeRegion(url.searchParams.get('region') || region);
      const task_type = Number(url.searchParams.get('task_type') || '0');
      const task_id = String(url.searchParams.get('task_id') || '').trim();
      if (!r) return jsonResp({ ok: false, error: 'invalid_region', allowed_regions: OPERATING_REGIONS }, 400);
      if (!Number.isInteger(task_type) || task_type < 1 || task_type > 4) {
        return jsonResp({ ok: false, error: 'task_type must be 1, 2, 3, or 4' }, 400);
      }
      if (!task_id) return jsonResp({ ok: false, error: 'task_id required' }, 400);
      const result = await shopApiCall(r, '/api/v2/product/get_batch_task_result', {
        query: { task_type, task_id },
        account_key: accountKey,
      });
      return jsonResp({
        ok: !result.error,
        account_key: accountKey,
        region: r,
        task_type,
        task_id,
        result,
        source_docs: ['docs_ai/apis/product/v2.product.get_batch_task_result.json'],
      });
    }
    if (action === 'update_price' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      const normalized = normalizeUpdatePriceRow(body, body.region || 'SG');
      if (!normalized.ok) return jsonResp({ ok: false, error: normalized.error }, 400);
      const row = normalized.row;
      const result = await executeShopUpdatePriceMutation({
        accountKey: reqAccountKey,
        region: row.region,
        itemId: row.item_id,
        priceList: row.price_list,
        body,
        clientRef: row.client_ref,
      });
      return jsonResp(result);
    }
    if (action === 'update_price_batch' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      const normalized = normalizeUpdatePriceBatchRows(body);
      if (!normalized.ok) {
        return jsonResp({ ok: false, error: normalized.error }, normalized.status || 400);
      }

      const started = Date.now();
      const results = await mapWithConcurrency(normalized.rows, UPDATE_PRICE_BATCH_PARALLELISM, async (row: any) => {
        try {
          return await executeShopUpdatePriceMutation({
            accountKey: reqAccountKey,
            region: row.region,
            itemId: row.item_id,
            priceList: row.price_list,
            body,
            clientRef: row.client_ref,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            account_key: reqAccountKey,
            region: row.region,
            item_id: row.item_id,
            client_ref: row.client_ref || null,
            sent_price_list: row.price_list,
            failure_list: [],
            error: message,
            rollback_policy: V2_ROLLBACK_POLICY,
          };
        }
      });
      const failureCount = results.filter((result: any) => result?.ok !== true).length;
      const response = {
        ok: failureCount === 0,
        account_key: reqAccountKey,
        results,
        ok_count: results.length - failureCount,
        failure_count: failureCount,
        duration_ms: Date.now() - started,
        rollback_policy: V2_ROLLBACK_POLICY,
      };
      audit('shop_update_price_batch_complete', {
        account_key: reqAccountKey,
        update_count: results.length,
        ok_count: response.ok_count,
        failure_count: failureCount,
        duration_ms: response.duration_ms,
      });
      return jsonResp(response);
    }
    if (action === 'update_item_logistics' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      const r = body.region || 'SG';
      const item_id = parseInt(body.item_id);
      const logisticInfo = Array.isArray(body.logistic_info) ? body.logistic_info : [];
      const cleaned = logisticInfo
        .map((row: any) => {
          const logistic_id = Number(row?.logistic_id || row?.logistics_channel_id || row?.channel_id);
          if (!Number.isFinite(logistic_id) || logistic_id <= 0) return null;
          const next: Record<string, unknown> = {
            logistic_id,
            enabled: row?.enabled === true,
          };
          if (row?.is_free !== undefined) next.is_free = row.is_free === true;
          if (row?.shipping_fee !== undefined && row?.shipping_fee !== null && row?.shipping_fee !== '') {
            const shipping_fee = Number(row.shipping_fee);
            if (Number.isFinite(shipping_fee) && shipping_fee >= 0) next.shipping_fee = shipping_fee;
          }
          if (row?.size_id !== undefined && row?.size_id !== null && row?.size_id !== '') {
            const size_id = Number(row.size_id);
            if (Number.isFinite(size_id) && size_id >= 0) next.size_id = size_id;
          }
          return next;
        })
        .filter((row: Record<string, unknown> | null): row is Record<string, unknown> => !!row);
      if (!item_id) return jsonResp({ ok: false, error: 'item_id required' }, 400);
      if (!cleaned.length) return jsonResp({ ok: false, error: 'logistic_info required' }, 400);
      const payload = { item_id, logistic_info: cleaned };
      const result = await shopApiCall(r, '/api/v2/product/update_item', {
        method: 'POST',
        body: payload,
        account_key: reqAccountKey,
      });
      return jsonResp({ ok: !result.error, account_key: reqAccountKey, region: r, item_id, sent_logistic_info: cleaned, result });
    }
    if (action === 'update_item_sku' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      const r = body.region || 'SG';
      const item_id = parseInt(body.item_id);
      const item_sku = typeof body.item_sku === 'string' ? body.item_sku.trim() : '';
      if (!item_id) return jsonResp({ ok: false, error: 'item_id required' }, 400);
      if (!item_sku) return jsonResp({ ok: false, error: 'item_sku required' }, 400);
      const result = await shopApiCall(r, '/api/v2/product/update_item', { method: 'POST', body: { item_id, item_sku }, account_key: reqAccountKey });
      return jsonResp({ ok: !result.error, account_key: reqAccountKey, region: r, item_id, item_sku, result });
    }
    if (action === 'update_model_sku' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
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
      const result = await shopApiCall(r, '/api/v2/product/update_model', { method: 'POST', body: { item_id, model: cleaned }, account_key: reqAccountKey });
      return jsonResp({ ok: !result.error, account_key: reqAccountKey, region: r, item_id, sent_model: cleaned, result });
    }
    if (action === 'published_list') {
      const global_item_id = parseInt(url.searchParams.get('global_item_id') || '0');
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      const shop_id_list = String(url.searchParams.get('shop_id_list') || url.searchParams.get('shop_id') || '').trim();
      const query: Record<string, any> = { global_item_id };
      if (shop_id_list) query.shop_id_list = shop_id_list;
      const result = await merchantApiCall(region, '/api/v2/global_product/get_published_list', { query, account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region, global_item_id, shop_id_list: shop_id_list || null, result });
    }
    if (action === 'shop_model_list') {
      const item_id = parseInt(url.searchParams.get('item_id') || '0');
      if (!item_id) return jsonResp({ ok: false, error: 'item_id required' }, 400);
      const result = await shopApiCall(region, '/api/v2/product/get_model_list', { query: { item_id }, account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region, item_id, result });
    }
    if (action === 'update_global_dts' && req.method === 'POST') {
      // Plan: plans/shopee-dts-bulk-update-plan.md. Single API call applies DTS to all
      // published shops (KRSC seller — global_product API only).
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
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
        account_key: reqAccountKey,
      });
      return jsonResp({ ok: !result.error, account_key: reqAccountKey, region, global_item_id, days_to_ship, is_pre_order, result });
    }
    if (action === 'update_shop_item_dts' && req.method === 'POST') {
      // Shop-level DTS update — tries shopApiCall (KRSC may block; we'll see the error).
      // Body: { region, item_id, days_to_ship, is_pre_order }
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
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
        account_key: reqAccountKey,
      });
      return jsonResp({ ok: !result.error, account_key: reqAccountKey, region: r, item_id, days_to_ship, is_pre_order, result });
    }
    if (action === 'set_dts_sync' && req.method === 'POST') {
      // Enable days_to_ship sync from global → shop for a list of shops. Required when
      // shop_sync_list[].days_to_ship is false (default in some setups), otherwise
      // update_global_item.pre_order.days_to_ship does NOT propagate to shop listings.
      // Body: { shops: [{shop_id, shop_region}, ...] }
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
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
        account_key: reqAccountKey,
      });
      return jsonResp({ ok: !result.error, account_key: reqAccountKey, region, sent: shop_sync_list, result });
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
      const result = await merchantApiCall(merchantRegion, '/api/v2/global_product/get_global_item_list', { query, account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region, query, keyword: keyword || null, result });
    }
    if (action === 'global_item_info') {
      const merchantRegion = String(region || '').toUpperCase() === 'GLOBAL' ? 'SG' : region;
      const ids = url.searchParams.getAll('global_item_id').map(s => parseInt(s)).filter(n => Number.isFinite(n));
      if (ids.length === 0) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      const result = await merchantApiCall(merchantRegion, '/api/v2/global_product/get_global_item_info', { query: { global_item_id_list: ids.join(',') }, account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region, global_item_id_list: ids, result });
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
          account_key: accountKey,
        });
        if (itemInfoResult.error) {
          return jsonResp({ ok: false, account_key: accountKey, region, global_item_id, error: itemInfoResult.error, result: itemInfoResult }, 500);
        }
        const itemList = itemInfoResult.response?.global_item_list || itemInfoResult.response?.item_list || [];
        itemInfo = Array.isArray(itemList) ? itemList[0] || null : null;
        category_id = Number(itemInfo?.category_id || 0);
        if (!category_id) {
          return jsonResp({ ok: false, account_key: accountKey, region, global_item_id, error: 'category_id not found for global item', result: itemInfoResult }, 404);
        }
      }
      const result = await merchantApiCall(region, '/api/v2/global_product/get_global_item_limit', {
        query: { category_id },
        account_key: accountKey,
      });
      if (result.error) {
        return jsonResp({ ok: false, account_key: accountKey, region, category_id, global_item_id: global_item_id || null, error: result.error, result }, 500);
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
        account_key: accountKey,
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
      const result = await merchantApiCall(merchantRegion, '/api/v2/global_product/get_global_model_list', { query: { global_item_id }, account_key: accountKey });
      return jsonResp({ ok: !result.error, account_key: accountKey, region, global_item_id, result });
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
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      const r = body.region || 'SG';
      const global_item_id = parseInt(body.global_item_id);
      const global_price_list = body.global_price_list || [];
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      if (!Array.isArray(global_price_list) || !global_price_list.length) return jsonResp({ ok: false, error: 'global_price_list required' }, 400);
      const result = await merchantApiCall(r, '/api/v2/global_product/update_price', { method: 'POST', body: { global_item_id, global_price_list }, account_key: reqAccountKey });
      return jsonResp({ ok: !result.error, account_key: reqAccountKey, region: r, global_item_id, sent_global_price_list: global_price_list, result });
    }

    // Update SKU at the merchant (CBSC global product) level.
    // - Use `update_global_item` to change the parent item SKU (no variants).
    // - Use `update_global_model` to change variant SKUs in bulk.
    // Single edge call per item or per item-with-models — frontend chunks the
    // requested edits so we don't hold a long-running request open.
    if (action === 'update_global_item' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      const r = body.region || 'SG';
      const global_item_id = parseInt(body.global_item_id);
      const global_item_sku = typeof body.global_item_sku === 'string' ? body.global_item_sku.trim() : '';
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      if (!global_item_sku) return jsonResp({ ok: false, error: 'global_item_sku required' }, 400);
      return withPublishRequestId(action, `${reqAccountKey}:${r}`, null, body, async () => {
        const result = await merchantApiCall(r, '/api/v2/global_product/update_global_item', {
          method: 'POST',
          body: { global_item_id, global_item_sku },
          account_key: reqAccountKey,
        });
        return jsonResp({ ok: !result.error, account_key: reqAccountKey, region: r, global_item_id, global_item_sku, result });
      });
    }

    if (action === 'update_global_model' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      const r = body.region || 'SG';
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
        .filter((m: any) => Number.isFinite(m.global_model_id) && m.global_model_id > 0 && m.global_model_sku);
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      if (cleaned.length === 0) return jsonResp({ ok: false, error: 'global_model[] required (global_model_id + global_model_sku, plus optional weight)' }, 400);
      return withPublishRequestId(action, `${reqAccountKey}:${r}`, null, body, async () => {
        const result = await merchantApiCall(r, '/api/v2/global_product/update_global_model', {
          method: 'POST',
          body: { global_item_id, global_model: cleaned },
          account_key: reqAccountKey,
        });
        return jsonResp({ ok: !result.error, account_key: reqAccountKey, region: r, global_item_id, sent_global_model: cleaned, result });
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
      const accountKey = normalizeAccountKey(body.account_key || body.accountKey || url.searchParams.get('account_key') || url.searchParams.get('accountKey'));
      body.account_key = accountKey;

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
        ? await sha256Hex({ accountKey, sourceUrl, mainImageUrl, layerVersion, outputHash, region: r })
        : '';
      const payloadHash = hasGeneratedKey
        ? `upload_image:${idempotencyKeyHash}:${Math.floor(Date.now() / GENERATED_UPLOAD_CACHE_TTL_MS)}`
        : await sha256Hex({ action: 'upload_image', accountKey, region: r, outputHash: outputHash || await sha256Hex(decoded.bytes), bytes: decoded.bytes.byteLength });
      const requestPayload = {
        account_key: accountKey,
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
        const cached = await findRecentGeneratedUpload(idempotencyKeyHash, r, accountKey);
        const cachedResponse = cached?.response || null;
        if (cachedResponse?.image_id) {
          audit('upload_image_cache_hit', { account_key: accountKey, region: r, idempotency_key_hash: idempotencyKeyHash, log_id: cached.id });
          return jsonResp({
            ok: true,
            account_key: accountKey,
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
        account_key: accountKey,
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
      audit('upload_image_ok', { account_key: accountKey, region: r, image_id: imageInfo.image_id, request_id: imageInfo.request_id, log_id: log.id || null, auth_shape: uploadJson.auth_shape || null });
      return jsonResp({ ok: true, account_key: accountKey, region: r, image_url: imageInfo.image_url, image_id: imageInfo.image_id, request_id: imageInfo.request_id, cached: false });
    }

    // POST /add_item ??create a new Shopee product listing (shop-level, unlisted by default)
    // Body: { region, name, description?, sku, price, stock, weight_g, category_id, image_id_list?, image_url, condition?, item_status? }
    // Returns: { ok, item_id }
    if (action === 'add_item' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      const r = body.region || 'SG';
      const {
        name, sku, price, stock = 0, weight_g = 100,
        category_id, image_url, image_url_list, image_id, image_id_list, condition = 'NEW', description, variation,
        item_status = 'UNLIST',
        days_to_ship = 2, brand,
        package_length_cm = 20, package_width_cm = 15, package_height_cm = 5,
        attribute_list = [], wholesale_list = [],
      } = body;
      if (!name) return jsonResp({ ok: false, error: 'name required' }, 400);
      if (!sku) return jsonResp({ ok: false, error: 'sku required' }, 400);
      if (!price) return jsonResp({ ok: false, error: 'price required' }, 400);
      if (!category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      const normalizedItemStatus = String(item_status || 'UNLIST').toUpperCase();
      if (!['UNLIST', 'NORMAL'].includes(normalizedItemStatus)) {
        return jsonResp({ ok: false, error: 'item_status must be UNLIST or NORMAL' }, 400);
      }

      // Fetch available logistics channels. Field per Shopee SDK is logistic_info[] with logistic_id+logistic_name+enabled+is_free.
      const logisticsResp = await shopApiCall(r, '/api/v2/logistics/get_channel_list', { account_key: reqAccountKey });
      const allCh: any[] = logisticsResp.response?.logistics_channel_list || [];
      const pickId = (ch: any) => ch?.logistics_channel_id ?? ch?.logistic_id ?? ch?.channel_id ?? ch?.id;
      const pickName = (ch: any) => ch?.logistics_channel_name ?? ch?.logistic_name ?? ch?.name ?? `channel_${pickId(ch)}`;
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
      const imageIds = stringArray(image_id_list);
      const imageUrls = stringArray(image_url_list);
      if (imageIds.length) imageBlock.image_id_list = imageIds;
      else if (image_id) imageBlock.image_id_list = [String(image_id)];
      else if (imageUrls.length) imageBlock.image_url_list = imageUrls;
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
        item_status: normalizedItemStatus,
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
          seller_stock: [{ stock: Number(m?.seller_stock?.[0]?.stock ?? m?.stock ?? stock) }],
        }));
      }

      const result = await shopApiCall(r, '/api/v2/product/add_item', { method: 'POST', body: payload, account_key: reqAccountKey });
      if (result.error) return jsonResp({ ok: false, account_key: reqAccountKey, region: r, error: result.error, message: result.message, sent: payload, raw: result }, 502);
      const itemId = Number(result.response?.item_id);
      let shopId: number | null = null;
      try { shopId = await getRegionShopId(r, reqAccountKey); } catch (_) { shopId = null; }
      let mappingRows: ShopeeRegistrationMappingInput[] = [];
      try {
        const modelRows = await fetchShopeeModelMappingRowsForPublishedItem(r, itemId, body, body, reqAccountKey);
        mappingRows = modelRows.length
          ? modelRows.map((row: any) => ({
            ...row,
            account_key: reqAccountKey,
            region: r,
            shop_id: shopId,
            shop_item_id: Number(result.response?.item_id),
            status: 'mapped',
            raw_payload: { source: 'product.add_item', raw: result, model_mapping: row.raw_payload || null },
          }))
          : [{
            product_id: body.product_id || body.productId || body.source_product_id || body.master_product_id || null,
            sku,
            item_sku: sku,
            account_key: reqAccountKey,
            region: r,
            shop_id: shopId,
            shop_item_id: Number(result.response?.item_id),
            status: 'mapped',
            raw_payload: { source: 'product.add_item', raw: result },
          }];
      } catch (_) {
        mappingRows = [{
          product_id: body.product_id || body.productId || body.source_product_id || body.master_product_id || null,
          sku,
          item_sku: sku,
          account_key: reqAccountKey,
          region: r,
          shop_id: shopId,
          shop_item_id: Number(result.response?.item_id),
          status: 'mapped',
          raw_payload: { source: 'product.add_item', raw: result },
        }];
      }
      const mappingResults = await persistShopeeRegistrationMappings(reqAccountKey, mappingRows);
      return jsonResp({ ok: true, account_key: reqAccountKey, region: r, item_id: result.response?.item_id, mapping_results: mappingResults, sent: payload, raw: result });
    }

    // POST /unlist_item: publish/unpublish an existing shop-level item.
    // Official local doc:
    // C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.unlist_item.json
    if (action === 'unlist_item' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      const r = String(body.region || region || 'SG').toUpperCase();
      const sourceList = Array.isArray(body.item_list) && body.item_list.length
        ? body.item_list
        : [{ item_id: body.item_id, unlist: body.unlist }];
      const item_list = sourceList
        .map((row: any) => {
          const unlist = row?.unlist;
          return {
            item_id: Number(row?.item_id),
            unlist: unlist === true,
            has_unlist: typeof unlist === 'boolean',
          };
        })
        .filter((row: any) => Number.isFinite(row.item_id) && row.item_id > 0 && row.has_unlist)
        .map(({ item_id, unlist }: any) => ({ item_id, unlist }));
      if (!item_list.length) return jsonResp({ ok: false, error: 'item_list[] or item_id and boolean unlist required' }, 400);
      const result = await shopApiCall(r, '/api/v2/product/unlist_item', {
        method: 'POST',
        body: { item_list },
        account_key: reqAccountKey,
      });
      const failureList = Array.isArray(result?.response?.failure_list)
        ? result.response.failure_list
        : (Array.isArray(result?.response?.failed_list) ? result.response.failed_list : []);
      return jsonResp({
        ok: !result.error && failureList.length === 0,
        account_key: reqAccountKey,
        region: r,
        sent_item_list: item_list,
        failure_list: failureList,
        result,
      }, result.error ? 502 : 200);
    }

    // POST /delete_item: cleanup helper for shop-level registration rollback.
    // Requires confirm_delete=true to avoid accidental destructive calls.
    // Official local doc:
    // C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.delete_item.json
    if (action === 'delete_item' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      const r = String(body.region || region || 'SG').toUpperCase();
      const item_id = Number(body.item_id);
      if (!item_id) return jsonResp({ ok: false, error: 'item_id required' }, 400);
      if (body.confirm_delete !== true) {
        return jsonResp({ ok: false, error: 'confirm_delete required' }, 400);
      }
      const result = await shopApiCall(r, '/api/v2/product/delete_item', {
        method: 'POST',
        body: { item_id },
        account_key: reqAccountKey,
      });
      return jsonResp({
        ok: !result.error,
        account_key: reqAccountKey,
        region: r,
        item_id,
        result,
      }, result.error ? 502 : 200);
    }

    return jsonResp({ ok: false, error: `unknown: ${action}` }, 404);
  } catch (e: any) {
    audit('request_unhandled_error', { action, error: String(e?.message || e), stack: e?.stack ? String(e.stack).slice(0, 800) : null });
    return jsonResp({ ok: false, error: 'internal_error', message: 'Unexpected shopee-bridge error' }, 500);
  }
});
