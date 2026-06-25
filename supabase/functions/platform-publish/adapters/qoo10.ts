// @ts-nocheck
// Qoo10 adapter for platform-publish.

import type { AdapterContext, AdapterResult, PlatformAdapter } from '../_shared/contract.ts';
import { resolveQoo10AvailableDate } from '../_shared/fulfillment.ts';
import { buildVariationItems, parentSku, publishableGroupRows } from '../_shared/grouping.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = (Deno as any).env.get('SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = (Deno as any).env.get('SUPABASE_ANON_KEY') || '';
const SUPABASE_SERVICE_ROLE_KEY = (Deno as any).env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const QOO10_BRIDGE_URL = (Deno as any).env.get('QOO10_BRIDGE_URL') || (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/qoo10-bridge` : '');
const QOO10_GOODS_CATEGORY_ID = '300002855';
const QOO10_DEFAULT_SHIPPING_NO = '715009';
const QOO10_SHOP_LAYER_VERSION = 'qoo10-shop-layer-v1';
const QOO10_SHIPPING_FEE_TABLE_JPY = Object.freeze([
  { maxWeightG: 100, feeJpy: 450 },
  { maxWeightG: 250, feeJpy: 525 },
  { maxWeightG: 500, feeJpy: 590 },
  { maxWeightG: 750, feeJpy: 680 },
  { maxWeightG: 1000, feeJpy: 720 },
  { maxWeightG: 1250, feeJpy: 760 },
  { maxWeightG: 1500, feeJpy: 810 },
  { maxWeightG: 1750, feeJpy: 860 },
  { maxWeightG: 2000, feeJpy: 910 },
]);

function norm(value: unknown): string {
  return String(value || '').trim();
}

function truthy(value: unknown): boolean {
  const normalized = norm(value).toLowerCase();
  return value === true || value === 1 || normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function isQoo10LayeredMainImageUrl(value: unknown): boolean {
  const url = norm(value);
  return /^https:\/\//i.test(url)
    && /\/storage\/v1\/object\/public\/product-images\/q10\//i.test(url)
    && /-cover-[0-9a-f-]{8,}\.(png|jpe?g|webp)(\?|$)/i.test(url);
}

function validateQoo10LayeredMainImage(qoo10: Record<string, any>, imageUrl: string): { ok: true } | { ok: false; message: string } {
  if (!imageUrl) {
    return { ok: false, message: 'Qoo10 representative image is required before registration.' };
  }
  if (!truthy(qoo10.main_image_layered) || norm(qoo10.layer_version) !== QOO10_SHOP_LAYER_VERSION || !isQoo10LayeredMainImageUrl(imageUrl)) {
    return {
      ok: false,
      message: 'Qoo10 StandardImage must be generated through the shop-layer upload path before registration.',
    };
  }
  return { ok: true };
}

function normalizeQoo10PriceEnding90(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const whole = Math.ceil(n);
  const sameHundred90 = Math.floor(whole / 100) * 100 + 90;
  return whole <= sameHundred90 ? sameHundred90 : sameHundred90 + 100;
}

function qoo10ShippingFeeJpy(weightG: unknown): number {
  const grams = Number(weightG || 0);
  if (!Number.isFinite(grams) || grams <= 0) return 0;
  const bracket = QOO10_SHIPPING_FEE_TABLE_JPY.find((row) => grams <= row.maxWeightG);
  return bracket ? bracket.feeJpy : QOO10_SHIPPING_FEE_TABLE_JPY[QOO10_SHIPPING_FEE_TABLE_JPY.length - 1].feeJpy;
}

async function qoo10CountrySettings(): Promise<Record<string, any>> {
  const fallback = { exchange_rate: 9.1, sales_fee: 11, fsp_fee: 2, other_fee: 1, pg_fee: 0, fsp_ccb: 0, fixed_service_fee: 0, purchase_vat: 0 };
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return fallback;
  try {
    const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data } = await svc.from('country_settings').select('exchange_rate,sales_fee,fsp_fee,other_fee,pg_fee,fsp_ccb,fixed_service_fee,purchase_vat').eq('country_code', 'Q10').maybeSingle();
    return data || fallback;
  } catch {
    return fallback;
  }
}

function qoo10PriceFromCost(row: Record<string, any>, settings: Record<string, any>): number {
  const cost = Number(row.cost_krw || 0);
  const exchangeRate = Number(settings.exchange_rate || 9.1);
  if (!cost || cost <= 0 || !exchangeRate || exchangeRate <= 0) return 0;
  const totalFeePct = Number(settings.pg_fee || 0)
    + Number(settings.sales_fee || 0)
    + Number(settings.fsp_fee || 0)
    + Number(settings.other_fee || 0)
    + Number(settings.fsp_ccb || 0);
  const denom = 1 - (totalFeePct / 100);
  if (denom <= 0) return 0;
  const effectiveCost = cost * (1 - (Number(settings.purchase_vat || 0) / 100));
  const raw = ((effectiveCost / exchangeRate) + qoo10ShippingFeeJpy(row.weight_g) + Number(settings.fixed_service_fee || 0)) / denom;
  return normalizeQoo10PriceEnding90(raw);
}

function hasExplicitQoo10BasePrice(qoo10: Record<string, any>): boolean {
  return qoo10.base_price_jpy != null || qoo10.item_price_jpy != null || qoo10.price_jpy != null;
}

function qoo10OptionPriceFloor(basePrice: number): number {
  return Math.ceil(basePrice * 0.5);
}

function qoo10OptionPriceCeiling(basePrice: number): number {
  return Math.floor(basePrice * 2);
}

function qoo10ClampOptionPrice(price: unknown, basePrice: number): number {
  const normalized = normalizeQoo10PriceEnding90(price || basePrice) || basePrice;
  if (!basePrice) return normalized;
  const floor = qoo10OptionPriceFloor(basePrice);
  const ceiling = qoo10OptionPriceCeiling(basePrice);
  const clamped = Math.min(ceiling, Math.max(floor, normalized));
  return normalizeQoo10PriceEnding90(clamped) || normalized;
}

function reconcileQoo10BaseAndOptions(basePrice: number, options: any[], explicitBasePrice = false) {
  const targetPrices = options.map((row) => Number(row.price_jpy || 0)).filter((price) => Number.isFinite(price) && price > 0);
  const autoBasePrice = targetPrices.length
    ? normalizeQoo10PriceEnding90(Math.max(...targetPrices))
    : basePrice;
  const nextBasePrice = explicitBasePrice ? basePrice : autoBasePrice;
  if (!nextBasePrice) return { basePrice, options, pricingStrategy: 'unchanged' };

  let maxTargetIndex = 0;
  let maxTargetPrice = 0;
  options.forEach((row, idx) => {
    const price = Number(row.price_jpy || 0);
    if (price > maxTargetPrice) {
      maxTargetPrice = price;
      maxTargetIndex = idx;
    }
  });

  const adjustedOptions = options.map((row, idx) => {
    const targetPrice = Number(row.price_jpy || nextBasePrice);
    const price = !explicitBasePrice && idx === maxTargetIndex
      ? nextBasePrice
      : qoo10ClampOptionPrice(targetPrice, nextBasePrice);
    return { ...row, price_jpy: price };
  });

  return {
    basePrice: nextBasePrice,
    options: adjustedOptions,
    pricingStrategy: explicitBasePrice ? 'explicit_base_clamped_options' : 'auto_max_option_base_clamped_options',
  };
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
  const master = (ctx.masterProduct || {}) as Record<string, any>;
  const goodsDefault = norm(master.product_kind).toLowerCase() === 'goods' ? QOO10_GOODS_CATEGORY_ID : '';
  return norm(qoo10.category_id || master.qoo10_category_id || goodsDefault);
}

function shippingNoFrom(ctx: AdapterContext, qoo10: Record<string, any>): string {
  return norm(qoo10.shipping_no || ctx.masterProduct?.qoo10_shipping_no || QOO10_DEFAULT_SHIPPING_NO);
}

function brandNoFrom(ctx: AdapterContext, qoo10: Record<string, any>): string {
  const raw = norm(qoo10.brand_no || ctx.masterProduct?.qoo10_brand_no);
  return raw.replace(/\D/g, '') || raw;
}

function availableDateFrom(ctx: AdapterContext, qoo10: Record<string, any>) {
  const lifecycle = lifecycleOf((ctx.masterProduct || {}) as Record<string, any>, qoo10);
  const releaseDate = norm(qoo10.release_date || qoo10.available_date_value || ctx.masterProduct?.qoo10_release_date || ctx.masterProduct?.qoo10_available_date_value);
  return resolveQoo10AvailableDate(lifecycle, releaseDate);
}

function weightKg(ctx: AdapterContext): number {
  const grams = Number(ctx.masterProduct?.weight_g || 0);
  if (!grams || grams <= 0) return 0;
  return Math.max(0.1, Math.round((grams / 1000) * 10) / 10);
}

function defaultDescription(ctx: AdapterContext, qoo10: Record<string, any>): string {
  return norm(qoo10.description || ctx.masterProduct?.description || ctx.masterProduct?.components_extracted_en || '');
}

function normalizeOptions(ctx: AdapterContext, qoo10: Record<string, any>, basePrice: number, settings: Record<string, any>) {
  const groupRows = publishableGroupRows(ctx.masterProduct || {}, (ctx as any).groupProducts || []);
  const variationBundle = groupRows.length > 1 ? buildVariationItems(groupRows, 'Type') : null;
  const rows = Array.isArray(qoo10.options) && qoo10.options.length
    ? qoo10.options
    : variationBundle
      ? variationBundle.items.map((item: any) => ({
        product_id: item.row?.id,
        sku: item.row?.sku,
        option_name: 'Type',
        option_value: item.optionValue,
        price_jpy: qoo10PriceFromCost(item.row || {}, settings) || basePrice,
        stock: item.row?.inventory || 0,
      }))
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

function mapQoo10ListingStatus(rawStatus: unknown): AdapterResult['listingStatus'] {
  const status = norm(rawStatus).toUpperCase();
  if (!status || status === 'LISTED' || status === 'S2' || status === '2') return 'listed';
  if (status === 'S0' || status === 'S1' || status === '0' || status === '1') return 'pending';
  if (status === 'S3') return 'paused';
  if (status === 'S4' || status === '3' || status === 'DELETED' || status === 'DISCONTINUED') return 'not_listed';
  if (status === 'S5') return 'banned';
  if (status === 'S8') return 'rejected';
  return 'listed';
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

function buildQoo10OptionProducts(options: any[], bridgeJson: any) {
  const enrichedOptions = Array.isArray(bridgeJson?.options) ? bridgeJson.options : [];
  return options.map((row) => {
    const sku = norm(row.sku);
    const enriched = enrichedOptions.find((option: any) => sameSku(option?.sku, sku))
      || enrichedOptions.find((option: any) => sameSku(option?.option_code, sku))
      || (enrichedOptions.length === 1 ? enrichedOptions[0] : null);
    const optionCode = norm(enriched?.option_code);
    const variantId = norm(enriched?.variant_id || optionCode || sku);
    return {
      product_id: row.product_id,
      sku,
      option_value: row.option_value,
      option_code: optionCode || null,
      variant_id: variantId || null,
      variant_source: norm(enriched?.variant_source) || (optionCode ? 'option_code' : 'requested_seller_option_code'),
      mapping_status: norm(enriched?.mapping_status) || null,
      remote_verified: enriched?.remote_verified === true,
    };
  });
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
  return {
    ok: true,
    platformItemId,
    listingStatus: mapQoo10ListingStatus(result.json.status || result.json.item_status || result.json.ItemStatus),
    rawResponse: { ...result.json, platform_item_id: platformItemId, variant_id: result.json.option_code || result.json.seller_code || sku },
  };
}

async function executeCreate(ctx: AdapterContext): Promise<AdapterResult> {
  const qoo10 = qoo10Payload(ctx);
  const settings = await qoo10CountrySettings();
  const groupRows = publishableGroupRows(ctx.masterProduct || {}, (ctx as any).groupProducts || []);
  const title = titleFrom(ctx, qoo10);
  const categoryId = categoryFrom(ctx, qoo10);
  const shippingNo = shippingNoFrom(ctx, qoo10);
  const brandNo = brandNoFrom(ctx, qoo10);
  const sellerCode = norm(qoo10.seller_code || qoo10.parent_sku || (groupRows.length > 1 ? parentSku(groupRows) : '') || ctx.masterProduct?.sku);
  const explicitBasePrice = hasExplicitQoo10BasePrice(qoo10);
  const initialBasePrice = normalizeQoo10PriceEnding90(qoo10.base_price_jpy || qoo10.item_price_jpy || qoo10.price_jpy || qoo10PriceFromCost(ctx.masterProduct || {}, settings));
  const available = availableDateFrom(ctx, qoo10);
  const initialOptions = normalizeOptions(ctx, qoo10, initialBasePrice, settings);
  const reconciledPricing = reconcileQoo10BaseAndOptions(initialBasePrice, initialOptions, explicitBasePrice);
  const basePrice = reconciledPricing.basePrice;
  const options = reconciledPricing.options;
  const userAuthToken = norm((ctx as any).userAuthToken);
  const mainImage = norm(qoo10.main_image);

  if (!userAuthToken) return { ok: false, listingStatus: 'not_listed', errorCode: 'AUTH_NOT_VERIFIED', errorMsg: 'Missing authenticated user token for qoo10-bridge create-listing' };
  if (!categoryId) return { ok: false, listingStatus: 'not_listed', errorCode: 'QOO10_CATEGORY_UNMAPPED', errorMsg: 'Qoo10 category_id is required' };
  if (!title) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'Qoo10 item title is required' };
  if (!sellerCode) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'Qoo10 seller_code is required' };
  if (!shippingNo) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'Qoo10 ShippingNo is required; select a registered delivery template' };
  if (!basePrice) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'Qoo10 base_price_jpy is required' };
  if (available.type === '2' && !/^\d{4}[/-]\d{2}[/-]\d{2}$/.test(available.value)) {
    return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'Qoo10 release date is required as YYYY-MM-DD for pre-order listings' };
  }
  const mainImageValidation = validateQoo10LayeredMainImage(qoo10, mainImage);
  if (!mainImageValidation.ok) {
    return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: mainImageValidation.message };
  }

  const payload = {
    category_id: categoryId,
    title,
    seller_code: sellerCode,
    brand_no: brandNo,
    shipping_no: shippingNo,
    main_image: mainImage,
    main_image_layered: true,
    layer_version: QOO10_SHOP_LAYER_VERSION,
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

  if (ctx.dryRun) {
    return {
      ok: true,
      listingStatus: 'draft',
      rawResponse: {
        dry_run: true,
        payload,
        qoo10_pricing_strategy: reconciledPricing.pricingStrategy,
        option_products: options.map((row) => ({ product_id: row.product_id, sku: row.sku, option_value: row.option_value })),
      },
    };
  }

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
    listingStatus: mapQoo10ListingStatus(result.json.listing_status || result.json.item_status || result.json.ItemStatus),
    rawResponse: {
      ...result.json,
      platform_item_id: platformItemId,
      seller_code: sellerCode,
      qoo10_pricing_strategy: reconciledPricing.pricingStrategy,
      option_products: buildQoo10OptionProducts(options, result.json),
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
