// Shopee Bridge — v23: merchantApiCall uses getValidToken instead of always refreshing (prevents race condition on token rotation).
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
  if (j.error) throw new Error(`merchant refresh: ${j.error} ${j.message || ''}`);
  const newExpiry = Math.floor(Date.now() / 1000) + (j.expire_in || 14400);
  await supabase.from('shopee_tokens').update({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: newExpiry }).eq('region', region);
  return { access_token: j.access_token, merchant_id: data.merchant_id, shop_id: data.shop_id, expires_at: newExpiry, raw: j };
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
  if (j.error) throw new Error(`refresh: ${j.error} ${j.message || ''}`);
  const newExpiry = Math.floor(Date.now() / 1000) + (j.expire_in || 14400);
  await supabase.from('shopee_tokens').update({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: newExpiry }).eq('region', region);
  return { access_token: j.access_token, shop_id: data.shop_id, merchant_id: data.merchant_id, expires_at: newExpiry };
}

async function shopApiCall(region: string, path: string, opts: any = {}) {
  const app = await getApp();
  const t = await getValidToken(region, 'shop');
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}${t.access_token}${t.shop_id}`);
  const baseQuery: Record<string, string> = { partner_id: String(app.partner_id), timestamp: String(ts), access_token: t.access_token, shop_id: String(t.shop_id), sign };
  if (opts.query) for (const [k, v] of Object.entries(opts.query)) baseQuery[k] = String(v);
  const url = `https://${host(app.is_sandbox)}${path}?${new URLSearchParams(baseQuery)}`;
  const r = await fetch(url, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { http_status: r.status, ...(await r.json()) };
}

async function merchantApiCall(region: string, path: string, opts: any = {}) {
  const app = await getApp();
  const t = await getValidToken(region, 'merchant');
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(app.partner_key, `${app.partner_id}${path}${ts}${t.access_token}${t.merchant_id}`);
  const baseQuery: Record<string, string> = { partner_id: String(app.partner_id), timestamp: String(ts), access_token: t.access_token, merchant_id: String(t.merchant_id), sign };
  if (opts.query) for (const [k, v] of Object.entries(opts.query)) baseQuery[k] = String(v);
  const url = `https://${host(app.is_sandbox)}${path}?${new URLSearchParams(baseQuery)}`;
  const r = await fetch(url, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { http_status: r.status, ...(await r.json()) };
}

// /list_items — paginated get_item_list + batch get_item_base_info + per-item get_model_list (when has_model=true).
async function listItemsForRegion(region: string, item_status = 'NORMAL', max_items = 5000) {
  const items: { item_id: number, item_status: string }[] = [];
  let offset = 0;
  for (let page = 0; page < 50 && items.length < max_items; page++) {
    const r = await shopApiCall(region, '/api/v2/product/get_item_list', { query: { offset, page_size: 100, item_status } });
    if (r.error) {
      if (page === 0 && /invalid|not_support|item_status/i.test(`${r.error} ${r.message || ''}`)) {
        const r2 = await shopApiCall(region, '/api/v2/product/get_item_list', { query: { offset: 0, page_size: 100 } });
        if (r2.error) return { error: `get_item_list: ${r2.error} ${r2.message || ''}` };
        for (const it of (r2.response?.item || [])) items.push({ item_id: it.item_id, item_status: it.item_status });
        if (!r2.response?.has_next_page) break;
        offset = r2.response.next_offset || 0;
        continue;
      }
      return { error: `get_item_list: ${r.error} ${r.message || ''}` };
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
        item_name: base.item_name + (m.model_name ? ` · ${m.model_name}` : ''),
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
      return jsonResp({ ok: true, service: 'shopee-bridge', version: 23, env: { partner_id: app.partner_id, is_sandbox: app.is_sandbox, has_env_partner_id: !!ENV_PARTNER_ID, has_env_partner_key: !!ENV_PARTNER_KEY } });
    }
    if (action === 'tokens') {
      const { data } = await supabase.from('shopee_tokens').select('region, shop_id, merchant_id, expires_at, is_sandbox');
      const now = Math.floor(Date.now() / 1000);
      return jsonResp({ ok: true, tokens: (data || []).map(r => ({ ...r, expires_in_sec: r.expires_at - now })) });
    }
    if (action === 'shop_info') return jsonResp(await shopApiCall(region, '/api/v2/shop/get_shop_info'));
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
      if ((r as any).error) return jsonResp({ ok: false, region, error: (r as any).error }, 502);
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
    if (action === 'global_items') {
      const page_size = parseInt(url.searchParams.get('page_size') || '50');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const update_time_from = url.searchParams.get('update_time_from');
      const update_time_to = url.searchParams.get('update_time_to');
      const query: Record<string, any> = { page_size, offset };
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

    // --- v20: product registration helpers ---

    // GET /proxy_image?url=<encoded> — proxy StarOneMall images with CORS headers for browser canvas use
    if (action === 'proxy_image') {
      const imageUrl = url.searchParams.get('url') || '';
      if (!imageUrl) return jsonResp({ ok: false, error: 'url required' }, 400);
      if (!imageUrl.startsWith('https://')) return jsonResp({ ok: false, error: 'only https urls allowed' }, 400);
      try {
        const r = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Starphotocard/1.0)' } });
        if (!r.ok) return jsonResp({ ok: false, error: `upstream ${r.status}` }, 502);
        const ct = r.headers.get('content-type') || 'image/jpeg';
        const buf = await r.arrayBuffer();
        return new Response(buf, { status: 200, headers: { 'Content-Type': ct, ...CORS } });
      } catch (e: any) {
        return jsonResp({ ok: false, error: String(e?.message || e) }, 502);
      }
    }

    // POST /upload_image — decode base64 JPEG and upload to Shopee media space
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
      // Response format: response.image_url_list[0].url or response.image_url_list[0].image_url
      const list = uploadJson.response?.image_url_list || [];
      const image_url = list[0]?.url || list[0]?.image_url || uploadJson.response?.image_url || '';
      return jsonResp({ ok: true, region: r, image_url, raw: uploadJson });
    }

    // POST /add_item — create a new Shopee product listing (shop-level, unlisted by default)
    // Body: { region, name, description?, sku, price, stock, weight_g, category_id, image_url, condition? }
    // Returns: { ok, item_id }
    if (action === 'add_item' && req.method === 'POST') {
      const body = await req.json();
      const r = body.region || 'SG';
      const { name, sku, price, stock = 0, weight_g = 100, category_id, image_url, condition = 'NEW', description } = body;
      if (!name) return jsonResp({ ok: false, error: 'name required' }, 400);
      if (!sku) return jsonResp({ ok: false, error: 'sku required' }, 400);
      if (!price) return jsonResp({ ok: false, error: 'price required' }, 400);
      if (!category_id) return jsonResp({ ok: false, error: 'category_id required' }, 400);

      const CURRENCIES: Record<string, string> = { SG: 'SGD', MY: 'MYR', TW: 'TWD', TH: 'THB', PH: 'PHP', BR: 'BRL' };
      const currency = CURRENCIES[r] || 'SGD';

      // Fetch available logistics channels; enable all that are enabled, or first available
      const logisticsResp = await shopApiCall(r, '/api/v2/logistics/get_channel_list');
      const allCh: any[] = logisticsResp.response?.logistics_channel_list || [];
      let logistics = allCh.filter(ch => ch.enabled).map(ch => ({ logistic_id: ch.logistic_id, enabled: true }));
      if (logistics.length === 0 && allCh.length > 0) logistics = [{ logistic_id: allCh[0].logistic_id, enabled: true }];

      const item_desc = description || `${name}\n\nK-POP Official Merchandise. Ready stock, ships within 1-3 business days.`;
      const payload: any = {
        item_name: name,
        description: item_desc,
        item_sku: sku,
        category_id: Number(category_id),
        condition,
        weight: Number(weight_g) / 1000,
        image: { image_url_list: image_url ? [image_url] : [] },
        price_info: [{ currency, original_price: Number(price) }],
        stock_info_v2: { seller_stock: [{ stock: Number(stock) }] },
        logistics: logistics.length > 0 ? logistics : [{ logistic_id: 80007, enabled: true }],
        item_status: 'UNLIST',
      };

      const result = await shopApiCall(r, '/api/v2/product/add_item', { method: 'POST', body: payload });
      if (result.error) return jsonResp({ ok: false, region: r, error: result.error, message: result.message, raw: result }, 502);
      return jsonResp({ ok: true, region: r, item_id: result.response?.item_id, sent: payload, raw: result });
    }

    return jsonResp({ ok: false, error: `unknown: ${action}` }, 404);
  } catch (e: any) {
    return jsonResp({ ok: false, error: String(e?.message || e), stack: e?.stack }, 500);
  }
});
