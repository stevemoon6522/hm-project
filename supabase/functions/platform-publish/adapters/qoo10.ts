// @ts-nocheck
// Qoo10 adapter for platform-publish.

import type { AdapterContext, AdapterResult, PlatformAdapter } from '../_shared/contract.ts';

const SUPABASE_URL = (Deno as any).env.get('SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = (Deno as any).env.get('SUPABASE_ANON_KEY') || '';
const QOO10_BRIDGE_URL = (Deno as any).env.get('QOO10_BRIDGE_URL') || (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/qoo10-bridge` : '');

function norm(value: unknown): string {
  return String(value || '').trim();
}

function normalizeQoo10PriceEnding90(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const whole = Math.ceil(n);
  const sameHundred90 = Math.floor(whole / 100) * 100 + 90;
  return whole <= sameHundred90 ? sameHundred90 : sameHundred90 + 100;
}

function sameSku(a: unknown, b: unknown): boolean {
  return norm(a) === norm(b);
}

function qoo10Payload(ctx: AdapterContext) {
  return ((ctx as any).qoo10 || {}) as Record<string, any>;
}

function lifecycleOf(master: Record<string, any> = {}, overrides: Record<string, any> = {}): string {
  const lifecycle = norm(overrides.lifecycle_state || master.lifecycle_state).toLowerCase();
  return lifecycle === 'pre_order' ? 'pre_order' : 'ready_stock';
}

function lifecyclePrefix(lifecycle: string): string {
  return lifecycle === 'pre_order' ? '[PRE ORDER]' : '[READY STOCK]';
}

function stripLifecycleTags(value: unknown): string {
  return norm(value).replace(/\s*\[(?:PRE\s*[- ]?\s*ORDER|READY\s*[- ]?\s*STOCK|ON\s*HAND|FAST\s*DELIVERY)\]\s*/gi, ' ').replace(/\s+/g, ' ').trim();
}

function lifecycleProductName(value: unknown, lifecycle: string, fallback = ''): string {
  const body = stripLifecycleTags(value) || stripLifecycleTags(fallback) || norm(fallback);
  return `${lifecyclePrefix(lifecycle)} ${body}`.replace(/\s+/g, ' ').trim();
}

function titleFrom(ctx: AdapterContext, qoo10: Record<string, any>): string {
  const explicitTitle = norm(qoo10.title);
  if (explicitTitle) return explicitTitle.slice(0, 100);
  const master = (ctx.masterProduct || {}) as Record<string, any>;
  return lifecycleProductName(master.product_name, lifecycleOf(master, qoo10), master.sku).slice(0, 100);
}

function categoryFrom(ctx: AdapterContext, qoo10: Record<string, any>): string {
  return norm(qoo10.category_id || ctx.masterProduct?.qoo10_category_id);
}

function shippingNoFrom(ctx: AdapterContext, qoo10: Record<string, any>): string {
  return norm(qoo10.shipping_no || ctx.masterProduct?.qoo10_shipping_no);
}

function brandNoFrom(ctx: AdapterContext, qoo10: Record<string, any>): string {
  const raw = norm(qoo10.brand_no || ctx.masterProduct?.qoo10_brand_no);
  return raw.replace(/\D/g, '') || raw;
}

function availableDateFrom(ctx: AdapterContext, qoo10: Record<string, any>) {
  const lifecycle = lifecycleOf((ctx.masterProduct || {}) as Record<string, any>, qoo10);
  const explicitType = norm(qoo10.available_date_type);
  const storedType = norm(ctx.masterProduct?.qoo10_available_date_type);
  let type = norm(explicitType || storedType || (lifecycle === 'pre_order' ? '2' : '0'));
  if (!explicitType && lifecycle !== 'pre_order' && type === '2') type = '0';
  const raw = norm(qoo10.available_date_value || qoo10.release_date || ctx.masterProduct?.qoo10_available_date_value || ctx.masterProduct?.qoo10_release_date);
  if (type === '2') return { type: '2', value: raw.replace(/-/g, '/') };
  return { type: '0', value: norm(raw || '3') };
}

function weightKg(ctx: AdapterContext): number {
  const grams = Number(ctx.masterProduct?.weight_g || 0);
  if (!grams || grams <= 0) return 0;
  return Math.max(0.1, Math.round((grams / 1000) * 10) / 10);
}

function defaultDescription(ctx: AdapterContext, qoo10: Record<string, any>): string {
  return norm(qoo10.description || ctx.masterProduct?.description || ctx.masterProduct?.components_extracted_en || '');
}

function normalizeOptions(ctx: AdapterContext, qoo10: Record<string, any>, basePrice: number) {
  const rows = Array.isArray(qoo10.options) && qoo10.options.length
    ? qoo10.options
    : [{
      product_id: ctx.masterProduct?.id,
      sku: ctx.masterProduct?.sku,
      option_value: ctx.masterProduct?.option_name || 'Default',
      price_jpy: basePrice,
      stock: ctx.masterProduct?.inventory || 0,
    }];
  return rows.map((row: any) => ({
    product_id: row.product_id || row.id || null,
    sku: norm(row.sku),
    option_name: norm(row.option_name || qoo10.option_name || 'Type') || 'Type',
    option_value: norm(row.option_value || row.value || row.label || row.option_name || 'Default') || 'Default',
    price_jpy: normalizeQoo10PriceEnding90(row.price_jpy || row.price || basePrice),
    stock: Math.max(0, Math.floor(Number(row.stock ?? row.qty ?? 0) || 0)),
  })).filter((row: any) => row.sku);
}

function classifyBridgeError(status: number, json: any) {
  const msg = norm(json?.error || json?.message || json?.ResultMsg || `HTTP ${status}`);
  const code = norm(json?.result_code || json?.ResultCode);
  if (status === 401 || status === 403 || code === '-10000' || /authori[sz]ation|auth|key/i.test(msg)) return 'PLATFORM_AUTH_FAILED';
  if (status === 429 || /rate|throttle/i.test(msg)) return 'PLATFORM_THROTTLED';
  if (status === 404) return 'PLATFORM_NOT_FOUND';
  if (/duplicate|check|wrong|required|missing|availabledate|shipping|brand|category|price|stock|qty|image|seller code/i.test(msg)) return 'PLATFORM_VALIDATION_ERROR';
  return 'PLATFORM_UNKNOWN';
}

async function bridgeFetch(path: string, init: RequestInit = {}, userAuthToken = '') {
  if (!QOO10_BRIDGE_URL) return { ok: false, status: 500, json: { error: 'QOO10_BRIDGE_URL missing' } };
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> || {}) };
  if (SUPABASE_ANON_KEY) headers.apikey = SUPABASE_ANON_KEY;
  if (userAuthToken) headers.Authorization = `Bearer ${userAuthToken}`;
  const resp = await fetch(`${QOO10_BRIDGE_URL}${path}`, { ...init, headers });
  const json = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
  return { ok: resp.ok && json.ok !== false, status: resp.status, json };
}

async function lookupQoo10BySku(sku: string, userAuthToken = '', itemCode = '') {
  const itemCodeQuery = itemCode ? `&item_code=${encodeURIComponent(itemCode)}` : '';
  return bridgeFetch(`/lookup-sku?sku=${encodeURIComponent(sku)}${itemCodeQuery}`, {}, userAuthToken);
}

function validateQoo10SkuHit(sku: string, json: any): { ok: true } | { ok: false; message: string } {
  const verifiedSku = json?.verified_sku || json?.seller_code || json?.option_code;
  const echoed = [verifiedSku, json?.sku, json?.seller_code, json?.option_code].filter(Boolean);
  if (!echoed.some((value) => sameSku(value, sku))) {
    return { ok: false, message: `qoo10-bridge returned item ${norm(json?.goods_no || json?.platform_item_id || '') || '(unknown)'} without echoing requested SKU ${sku}` };
  }

  const matchType = norm(json?.match_type);
  const allowedMatchTypes = new Set(['seller_product_code', 'seller_product_code_scan', 'option_item_type_code']);
  if (!allowedMatchTypes.has(matchType)) return { ok: false, message: `qoo10-bridge returned unsupported match_type '${matchType || '(missing)'}' for SKU ${sku}` };
  return { ok: true };
}

async function executeSync(ctx: AdapterContext): Promise<AdapterResult> {
  const sku = norm(ctx.masterProduct?.sku);
  if (!sku) return { ok: false, listingStatus: 'not_listed', errorCode: 'INPUT_INVALID', errorMsg: 'products.sku is empty; cannot perform Qoo10 SKU lookup' };
  const userAuthToken = norm((ctx as any).userAuthToken);
  if (!userAuthToken) return { ok: false, listingStatus: 'not_listed', errorCode: 'AUTH_NOT_VERIFIED', errorMsg: 'Missing authenticated user token for qoo10-bridge lookup' };

  const existingItemCode = norm((ctx as any).platformItemId);
  const result = await lookupQoo10BySku(sku, userAuthToken, existingItemCode);
  if (!result.ok) {
    const error = result.json?.error || result.json?.message || `HTTP ${result.status}`;
    return { ok: false, listingStatus: 'not_listed', errorCode: result.status === 404 ? 'PLATFORM_NOT_FOUND' : 'PLATFORM_UNKNOWN', errorMsg: error, rawResponse: result.json };
  }
  const validation = validateQoo10SkuHit(sku, result.json);
  if (!validation.ok) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_SKU_MISMATCH', errorMsg: validation.message, rawResponse: result.json };

  const platformItemId = norm(result.json.goods_no || result.json.goodsNo || result.json.platform_item_id);
  if (!platformItemId) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_UNKNOWN', errorMsg: 'qoo10-bridge lookup succeeded but did not return goods_no', rawResponse: result.json };
  return { ok: true, platformItemId, listingStatus: 'listed', rawResponse: { ...result.json, platform_item_id: platformItemId, variant_id: result.json.option_code || result.json.seller_code || sku } };
}

async function executeCreate(ctx: AdapterContext): Promise<AdapterResult> {
  const qoo10 = qoo10Payload(ctx);
  const title = titleFrom(ctx, qoo10);
  const categoryId = categoryFrom(ctx, qoo10);
  const shippingNo = shippingNoFrom(ctx, qoo10);
  const brandNo = brandNoFrom(ctx, qoo10);
  const sellerCode = norm(qoo10.seller_code || qoo10.parent_sku || ctx.masterProduct?.sku);
  const basePrice = normalizeQoo10PriceEnding90(qoo10.base_price_jpy || qoo10.item_price_jpy || qoo10.price_jpy);
  const available = availableDateFrom(ctx, qoo10);
  const options = normalizeOptions(ctx, qoo10, basePrice);
  const userAuthToken = norm((ctx as any).userAuthToken);

  if (!userAuthToken) return { ok: false, listingStatus: 'not_listed', errorCode: 'AUTH_NOT_VERIFIED', errorMsg: 'Missing authenticated user token for qoo10-bridge create-listing' };
  if (!categoryId) return { ok: false, listingStatus: 'not_listed', errorCode: 'QOO10_CATEGORY_UNMAPPED', errorMsg: 'Qoo10 category_id is required' };
  if (!title) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'Qoo10 item title is required' };
  if (!sellerCode) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'Qoo10 seller_code is required' };
  if (!brandNo) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'Qoo10 BrandNo is required; search and select a registered Qoo10 brand' };
  if (!shippingNo) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'Qoo10 ShippingNo is required; select a registered delivery template' };
  if (!basePrice) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'Qoo10 base_price_jpy is required' };
  if (available.type === '2' && !/^\d{4}[/-]\d{2}[/-]\d{2}$/.test(available.value)) {
    return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'Qoo10 release date is required as YYYY-MM-DD for pre-order listings' };
  }

  const payload = {
    category_id: categoryId,
    title,
    seller_code: sellerCode,
    brand_no: brandNo,
    shipping_no: shippingNo,
    main_image: qoo10.main_image || ctx.masterProduct?.main_image,
    description: defaultDescription(ctx, qoo10),
    base_price_jpy: basePrice,
    stock: Math.max(0, options.reduce((sum, row) => sum + Number(row.stock || 0), 0)),
    weight_kg: Number(qoo10.weight_kg || weightKg(ctx) || 0),
    available_date_type: available.type,
    available_date_value: available.value,
    production_place: norm(qoo10.production_place || 'KR'),
    header_html: qoo10.header_html || '',
    keyword: qoo10.keyword || '',
    options,
    force_options: options.length > 1,
  };

  const result = await bridgeFetch('/create-listing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, userAuthToken);

  if (!result.ok) {
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: classifyBridgeError(result.status, result.json) as any,
      errorMsg: result.json?.error || result.json?.message || `HTTP ${result.status}`,
      rawResponse: result.json,
    };
  }

  const platformItemId = norm(result.json.goods_no || result.json.platform_item_id);
  if (!platformItemId) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_UNKNOWN', errorMsg: 'Qoo10 create-listing succeeded but goods_no was missing', rawResponse: result.json };
  return {
    ok: true,
    platformItemId,
    listingStatus: 'listed',
    rawResponse: {
      ...result.json,
      platform_item_id: platformItemId,
      seller_code: sellerCode,
      option_products: options.map((row) => ({ product_id: row.product_id, sku: row.sku, option_value: row.option_value })),
    },
  };
}

export const qoo10Adapter: PlatformAdapter = {
  supports: new Set(['create_listing', 'sync']),
  async execute(ctx: AdapterContext): Promise<AdapterResult> {
    if (ctx.capability === 'sync') return executeSync(ctx);
    if (ctx.capability === 'create_listing') return executeCreate(ctx);
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'CAPABILITY_UNSUPPORTED',
      errorMsg: `qoo10 adapter does not support capability='${ctx.capability}'`,
    };
  },
};
