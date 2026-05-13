// Shopee Bridge ??v40: GlobalProduct registration uses add_global_item -> init_tier_variation/add_global_model -> create_publish_task -> get_publish_task_result.
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
async function refreshMerchantRowToken(): Promise<{ access_token: string; merchant_id: number } | null> {
  const { data } = await supabase.from('shopee_tokens').select('*').eq('region', '_MERCHANT').single();
  if (!data || !data.refresh_token || !data.merchant_id) return null;
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
    return null;
  }
  const newExpiry = Math.floor(Date.now() / 1000) + (j.expire_in || 14400);
  await supabase.from('shopee_tokens').update({
    access_token: j.access_token,
    refresh_token: j.refresh_token || data.refresh_token,
    expires_at: newExpiry,
  }).eq('region', '_MERCHANT');
  audit('merchant_row_refresh_ok', { merchant_id: data.merchant_id, expire_in: j.expire_in });
  return { access_token: j.access_token, merchant_id: data.merchant_id };
}

// Get valid merchant token from _MERCHANT row, refreshing if needed.
async function getValidMerchantToken(): Promise<{ access_token: string; merchant_id: number } | null> {
  const { data } = await supabase.from('shopee_tokens').select('*').eq('region', '_MERCHANT').single();
  if (!data || !data.access_token || !data.merchant_id) return null;
  const now = Math.floor(Date.now() / 1000);
  if (data.expires_at && now < data.expires_at - 60) {
    return { access_token: data.access_token, merchant_id: data.merchant_id };
  }
  return await refreshMerchantRowToken();
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

async function sha256Hex(value: unknown): Promise<string> {
  const text = typeof value === 'string' ? value : JSON.stringify(canonicalize(value));
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
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
    const item_name = typeof body.item_name === 'string' ? body.item_name.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (global_item_sku) requestPayload.global_item_sku = global_item_sku;
    if (item_name) requestPayload.item_name = item_name;
    if (description) requestPayload.description = description;
    if (!global_item_id) return { ok: false, error: 'global_item_id required' };
    if (!global_item_sku && !item_name && !description) return { ok: false, error: 'at least one of global_item_sku, item_name, description required' };

    const preflight = await enforceV2ProbePreflight(action, requestPayload, body);
    if (!preflight.ok) return { ok: false, ...preflight };
    const finalPayload = preflight.requestPayload;
    if (!finalPayload.global_item_sku && !finalPayload.item_name && !finalPayload.description) {
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
  if (action === 'set_price_sync_on') {
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

  const item_id = parseInt(body.item_id || body.shop_item_id);
  const days_to_ship = Number(body.days_to_ship);
  if (!item_id) return { ok: false, error: 'shop_item_id required' };
  if (!Number.isFinite(days_to_ship) || days_to_ship < 1 || days_to_ship > 30) {
    return { ok: false, error: 'days_to_ship must be between 1 and 30' };
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
  return Math.max(1, Math.min(30, Number.isFinite(n) ? n : 2));
}

function imageBlockFrom(body: any) {
  const image: any = {};
  if (body?.image_id) image.image_id_list = [String(body.image_id)];
  else if (body?.image_url) image.image_url_list = [String(body.image_url)];
  return image;
}

function normalizeTierVariation(variation: any) {
  if (!variation?.tier_variation?.length) return [];
  return variation.tier_variation.slice(0, 2).map((t: any) => ({
    name: String(t?.name || '').trim(),
    option_list: Array.isArray(t?.option_list)
      ? t.option_list.map((o: any) => ({ option: String(o?.option || '').trim() })).filter((o: any) => o.option)
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

function buildGlobalModels(variation: any, fallbackPrice: number, fallbackStock: number) {
  const normalized = normalizeVariation(variation);
  if (!normalized) return [];
  return normalized.model.map((m: any) => ({
    tier_index: Array.isArray(m?.tier_index) ? m.tier_index.map((x: any) => Number(x)) : [],
    global_model_sku: String(m?.global_model_sku || m?.model_sku || '').trim(),
    original_price: Number(m?.global_original_price ?? m?.original_price ?? fallbackPrice),
    normal_stock: Number(m?.stock ?? fallbackStock ?? 0),
  }));
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
    normal_stock: Number(body.stock || 0),
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
  const roots = [
    ...(Array.isArray(src.attribute_list) ? src.attribute_list : []),
    ...(Array.isArray(src.attributes) ? src.attributes : []),
    ...(Array.isArray(src.attribute_tree) ? src.attribute_tree : []),
    ...(Array.isArray(src.children) ? src.children : []),
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
  const attrTreeRes = await merchantApiCall(region, '/api/v2/global_product/get_attribute_tree', { query: { category_id: categoryId, language: 'en' } });
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

async function getPublishLogistics(region: string) {
  const result = await shopApiCall(region, '/api/v2/logistics/get_channel_list');
  const channels: any[] = result?.response?.logistics_channel_list || [];
  const pickId = (ch: any) => ch?.logistic_id ?? ch?.logistics_channel_id ?? ch?.channel_id ?? ch?.id;
  const pickName = (ch: any) => ch?.logistic_name ?? ch?.name ?? `channel_${pickId(ch)}`;
  const enabled = channels.filter(ch => pickId(ch) != null && (ch.enabled ?? true));
  const out = enabled.map(ch => ({
    logistic_id: Number(pickId(ch)),
    logistic_name: String(pickName(ch)),
    enabled: true,
    is_free: false,
  }));
  return out.length ? out : [{ logistic_id: 80007, logistic_name: 'Default', enabled: true, is_free: false }];
}

function buildPublishItemPayload(body: any, target: any, logistics: any[]) {
  const dts = clampDaysToShip(target.days_to_ship ?? body.days_to_ship);
  const price = Number(target.price ?? body.price);
  const item: any = {
    item_name: body.name,
    description: body.description || `${body.name}\n\nK-POP Official Merchandise. Ready stock.`,
    item_status: body.item_status || 'UNLIST',
    original_price: price,
    image: imageBlockFrom(body),
    category_id: Number(body.category_id),
    logistic: logistics,
    pre_order: { is_pre_order: false, days_to_ship: dts },
  };
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

  try {
    if (action === 'health') {
      const app = await getApp();
      return jsonResp({ ok: true, service: 'shopee-bridge', version: 40, env: { partner_id: app.partner_id, is_sandbox: app.is_sandbox, has_env_partner_id: !!ENV_PARTNER_ID, has_env_partner_key: !!ENV_PARTNER_KEY } });
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
      const { data } = await supabase
        .from('shopee_tokens')
        .select('region, shop_id, merchant_id, expires_at, is_sandbox, access_token')
        .order('region', { ascending: true });
      const now = Math.floor(Date.now() / 1000);
      const rows = data || [];
      const results: any[] = [];
      const counters = {
        total: rows.length,
        probe_ok: 0,
        probe_fail: 0,
        refresh_ok: 0,
        refresh_fail: 0,
        principal_mismatch: 0,
      };
      for (const row of rows) {
        const probe = await probeShopToken(await getApp(), row.access_token, row.shop_id);
        if (probe.ok) counters.probe_ok++;
        else counters.probe_fail++;
        const out: any = {
          region: row.region,
          shop_id: row.shop_id,
          merchant_id: row.merchant_id,
          expires_in_sec: row.expires_at - now,
          probe_ok: probe.ok,
          probe_error: probe.error || null,
          probe_message: probe.message || null,
        };
        if (runRefresh && !probe.ok) {
          try {
            const refreshed = await forceRefreshShopToken(row.region);
            counters.refresh_ok++;
            out.refresh_ok = true;
            out.refreshed_expires_at = refreshed.expires_at;
          } catch (e: any) {
            const msg = String(e?.message || e);
            if (msg.includes('principal mismatch')) counters.principal_mismatch++;
            counters.refresh_fail++;
            out.refresh_ok = false;
            out.refresh_error = msg;
          }
        }
        results.push(out);
      }
      audit('token_health_scan', { run_refresh: runRefresh, ...counters });
      return jsonResp({ ok: true, run_refresh: runRefresh, counters, results });
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
      const result = await merchantApiCall(region, '/api/v2/global_product/get_attribute_tree', { query: { category_id, language: 'en' } });
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
      const payload = buildGlobalItemPayload(body);
      const result = await merchantApiCall(r, '/api/v2/global_product/add_global_item', { method: 'POST', body: payload });
      if (result.error) return jsonResp({ ok: false, region: r, error: result.error, message: result.message, sent: payload, raw: result }, 502);
      return jsonResp({ ok: true, region: r, global_item_id: result.response?.global_item_id, sent: payload, raw: result });
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
      const result = await merchantApiCall(r, '/api/v2/global_product/init_tier_variation', {
        method: 'POST',
        body: { global_item_id, tier_variation: variation.tier_variation, global_model: [models[0]] },
      });
      if (result.error) return jsonResp({ ok: false, region: r, error: result.error, message: result.message, raw: result }, 502);
      return jsonResp({ ok: true, region: r, global_item_id, sent_model: models[0], raw: result });
    }
    if (action === 'add_global_model' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const global_item_id = Number(body.global_item_id);
      const model_list = Array.isArray(body.model_list) ? body.model_list : buildGlobalModels(body.variation, Number(body.global_price ?? body.price), Number(body.stock || 0));
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      if (!model_list.length) return jsonResp({ ok: false, error: 'model_list required' }, 400);
      const result = await merchantApiCall(r, '/api/v2/global_product/add_global_model', {
        method: 'POST',
        body: { global_item_id, model_list },
      });
      if (result.error) return jsonResp({ ok: false, region: r, error: result.error, message: result.message, raw: result }, 502);
      return jsonResp({ ok: true, region: r, global_item_id, sent_model_list: model_list, raw: result });
    }
    // POST /create_publish_task: publish one global item to one shop/region.
    if (action === 'create_publish_task' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const global_item_id = Number(body.global_item_id);
      const shop_id = Number(body.shop_id || await getRegionShopId(r));
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      if (!shop_id) return jsonResp({ ok: false, error: 'shop_id required' }, 400);
      const logistics = await getPublishLogistics(r);
      const item = body.item || buildPublishItemPayload(body, body, logistics);
      if (!item.logistic) item.logistic = logistics;
      const sent = { global_item_id, shop_id, shop_region: r, item };
      const result = await merchantApiCall(r, '/api/v2/global_product/create_publish_task', { method: 'POST', body: sent });
      if (result.error) return jsonResp({ ok: false, region: r, error: result.error, message: result.message, sent, raw: result }, 502);
      return jsonResp({ ok: true, region: r, publish_task_id: result.response?.publish_task_id, sent, raw: result });
    }
    if (action === 'publish_task_result') {
      const publish_task_id = url.searchParams.get('publish_task_id') || '';
      if (!publish_task_id) return jsonResp({ ok: false, error: 'publish_task_id required' }, 400);
      const result = await merchantApiCall(region, '/api/v2/global_product/get_publish_task_result', { query: { publish_task_id } });
      return jsonResp({ ok: !result.error, region, result });
    }
    // POST /register_cbsc: high-level GlobalProduct registration and region publish orchestration.
    if (action === 'register_cbsc' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const targetInputs = (Array.isArray(body.targets) && body.targets.length ? body.targets : [body])
        .map((t: any) => ({ ...t, region: t.region || r }))
        .filter((t: any) => t.region);
      if (!body.name) return jsonResp({ ok: false, error: 'name required' }, 400);
      if (!body.sku) return jsonResp({ ok: false, error: 'sku required' }, 400);
      if (!body.category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);
      if (!targetInputs.length) return jsonResp({ ok: false, error: 'targets required' }, 400);

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

      const addPayload = buildGlobalItemPayload({
        ...body,
        attribute_list: catAttrs.attribute_list,
        price: Number(body.global_price ?? body.price ?? targetInputs[0]?.price),
        stock: Number(body.stock ?? targetInputs[0]?.stock ?? 0),
        weight_g: Number(body.weight_g ?? targetInputs[0]?.weight_g ?? 100),
        days_to_ship: targetInputs[0]?.days_to_ship ?? body.days_to_ship,
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

      const baseVariation = normalizeVariation(body.variation || targetInputs.find((t: any) => t.variation)?.variation);
      if (baseVariation) {
        const globalModels = buildGlobalModels(baseVariation, Number(body.global_price ?? body.price ?? targetInputs[0]?.price), Number(body.stock ?? 0));
        const initRes = await merchantApiCall(r, '/api/v2/global_product/init_tier_variation', {
          method: 'POST',
          body: { global_item_id, tier_variation: baseVariation.tier_variation, global_model: [globalModels[0]] },
        });
        if (initRes.error) return jsonResp({ ok: false, region: r, stage: 'init_tier_variation', global_item_id, error: initRes.error, message: initRes.message, raw: initRes }, 502);
        stage_logs.push(`init_tier_variation ok: 1/${globalModels.length} models`);
        if (globalModels.length > 1) {
          const addModelRes = await merchantApiCall(r, '/api/v2/global_product/add_global_model', {
            method: 'POST',
            body: { global_item_id, model_list: globalModels.slice(1) },
          });
          if (addModelRes.error) return jsonResp({ ok: false, region: r, stage: 'add_global_model', global_item_id, error: addModelRes.error, message: addModelRes.message, raw: addModelRes }, 502);
          stage_logs.push(`add_global_model ok: ${globalModels.length - 1} models`);
        }
      }

      const results: any[] = [];
      for (const target of targetInputs) {
        const targetRegion = String(target.region || '').toUpperCase();
        try {
          const shop_id = await getRegionShopId(targetRegion);
          const logistics = await getPublishLogistics(targetRegion);
          const item = buildPublishItemPayload({ ...body, image_id: body.image_id, image_url: body.image_url }, target, logistics);
          const publishBody = { global_item_id, shop_id, shop_region: targetRegion, item };
          const publishRes = await merchantApiCall(targetRegion, '/api/v2/global_product/create_publish_task', { method: 'POST', body: publishBody });
          if (publishRes.error) {
            results.push({ ok: false, region: targetRegion, shop_id, stage: 'create_publish_task', error: publishRes.error, message: publishRes.message, raw: publishRes });
            continue;
          }
          const publish_task_id = Number(publishRes.response?.publish_task_id);
          let task: any = null;
          for (let i = 0; i < 8; i++) {
            await new Promise(s => setTimeout(s, 1500));
            const taskRes = await merchantApiCall(targetRegion, '/api/v2/global_product/get_publish_task_result', { query: { publish_task_id } });
            task = taskRes;
            if (taskRes.error || !isPublishPending(taskRes)) break;
          }
          results.push(parsePublishOutcome(targetRegion, shop_id, publish_task_id, task));
        } catch (e: any) {
          results.push({ ok: false, region: target.region || r, stage: 'publish_exception', error: String(e?.message || e) });
        }
      }
      return jsonResp({ ok: true, region: r, global_item_id, stage_logs, results });
    }
    if (action === 'item_info') {
      const item_id = parseInt(url.searchParams.get('item_id') || '0');
      if (!item_id) return jsonResp({ ok: false, error: 'item_id required' }, 400);
      const result = await shopApiCall(region, '/api/v2/product/get_item_base_info', { query: { item_id_list: item_id } });
      return jsonResp({ ok: !result.error, region, item_id, result });
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
      return jsonResp({ ok: !result.error, region: r, item_id, sent_price_list: price_list, result });
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
    if (action === 'global_items') {
      const page_size = parseInt(url.searchParams.get('page_size') || '50');
      const offset = url.searchParams.get('offset') || '';
      const update_time_from = url.searchParams.get('update_time_from');
      const update_time_to = url.searchParams.get('update_time_to');
      const query: Record<string, any> = { page_size };
      if (offset && offset !== '0') query.offset = offset;
      if (update_time_from) query.update_time_from = update_time_from;
      if (update_time_to) query.update_time_to = update_time_to;
      const result = await merchantApiCall(region, '/api/v2/global_product/get_global_item_list', { query });
      return jsonResp({ ok: !result.error, region, query, result });
    }
    if (action === 'global_item_info') {
      const ids = url.searchParams.getAll('global_item_id').map(s => parseInt(s)).filter(n => Number.isFinite(n));
      if (ids.length === 0) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      const result = await merchantApiCall(region, '/api/v2/global_product/get_global_item_info', { query: { global_item_id_list: ids.join(',') } });
      return jsonResp({ ok: !result.error, region, global_item_id_list: ids, result });
    }
    if (action === 'global_model_list') {
      const global_item_id = parseInt(url.searchParams.get('global_item_id') || '0');
      if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
      const result = await merchantApiCall(region, '/api/v2/global_product/get_global_model_list', { query: { global_item_id } });
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
      const result = await merchantApiCall(r, '/api/v2/global_product/update_global_item', {
        method: 'POST',
        body: { global_item_id, global_item_sku },
      });
      return jsonResp({ ok: !result.error, region: r, global_item_id, global_item_sku, result });
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
      const result = await merchantApiCall(r, '/api/v2/global_product/update_global_model', {
        method: 'POST',
        body: { global_item_id, global_model: cleaned },
      });
      return jsonResp({ ok: !result.error, region: r, global_item_id, sent_global_model: cleaned, result });
    }

    // --- v20: product registration helpers ---

    // GET /proxy_image?url=<encoded> ??proxy StarOneMall images with CORS headers for browser canvas use
    if (action === 'proxy_image') {
      const imageUrlRaw = url.searchParams.get('url') || '';
      if (!imageUrlRaw) return jsonResp({ ok: false, error: 'url required' }, 400);
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

          const referers = Array.from(new Set([
            `${upstream.protocol}//${upstream.hostname}/`,
            'https://www.staronemall.com/',
            'http://www.staronemall.com/',
          ]));

          for (const referer of referers) {
            let r: Response;
            try {
              r = await fetch(imageUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                  'Referer': referer,
                },
              });
            } catch (e: any) {
              lastErr = `fetch exception (url=${imageUrl}, referer=${referer}): ${String(e?.message || e)}`;
              continue;
            }
            if (r.ok) {
              const ct = r.headers.get('content-type') || 'image/jpeg';
              const buf = await r.arrayBuffer();
              return new Response(buf, { status: 200, headers: { 'Content-Type': ct, ...CORS } });
            }
            lastErr = `upstream ${r.status} (url=${imageUrl}, referer=${referer})`;
          }
        }
        return jsonResp({ ok: false, error: lastErr }, 502);
      } catch (e: any) {
        return jsonResp({ ok: false, error: String(e?.message || e) }, 502);
      }
    }

    // POST /upload_image ??decode base64 JPEG and upload to Shopee media space
    // Body: { region, image_base64 }  Returns: { ok, image_url }
    if (action === 'upload_image' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const raw_b64: string = body.image_base64 || '';
      if (!raw_b64) return jsonResp({ ok: false, error: 'image_base64 required' }, 400);
      // Strip data URL prefix if present
      const b64 = raw_b64.replace(/^data:[^;]+;base64,/, '');
      const binaryStr = atob(b64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

      const app = await getApp();
      const t = await getValidToken(r, 'shop');
      const path = '/api/v2/media_space/upload_image';
      const ts = Math.floor(Date.now() / 1000);
      const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}${t.access_token}${t.shop_id}`);
      const qp = new URLSearchParams({
        partner_id: String(app.partner_id), timestamp: String(ts),
        access_token: t.access_token, shop_id: String(t.shop_id), sign,
      });
      const uploadUrl = `https://${host(app.is_sandbox)}${path}?${qp}`;
      const formData = new FormData();
      formData.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'product.jpg');
      const uploadResp = await fetch(uploadUrl, { method: 'POST', body: formData });
      const uploadJson = await uploadResp.json();
      if (uploadJson.error) return jsonResp({ ok: false, region: r, error: uploadJson.error, message: uploadJson.message, raw: uploadJson }, 502);
      // Response shape: response.image_info.image_url_list[]{image_url_region, image_url} (newer format),
      // older format: response.image_url_list[]{url|image_url}, or response.image_url
      const info = uploadJson.response?.image_info || uploadJson.response || {};
      const list = info.image_url_list || uploadJson.response?.image_url_list || [];
      const matched = list.find((e: any) => String(e.image_url_region || '').toUpperCase() === r);
      const image_url = matched?.image_url || matched?.url
        || list[0]?.image_url || list[0]?.url
        || uploadJson.response?.image_url || '';
      const image_id = info.image_id || uploadJson.response?.image_id || '';
      return jsonResp({ ok: true, region: r, image_url, image_id, raw: uploadJson });
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
    return jsonResp({ ok: false, error: String(e?.message || e), stack: e?.stack }, 500);
  }
});
