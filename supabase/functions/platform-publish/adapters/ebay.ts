// @ts-nocheck
// eBay platform-publish adapter.
// Routes create/sync through ebay-bridge and keeps unsupported update semantics out of scope.

import type { AdapterContext, AdapterResult, AdapterErrorCode, PlatformAdapter } from '../_shared/contract.ts';
import { resolveEbayFulfillmentPolicy } from '../_shared/fulfillment.ts';
import { buildVariationItems, inferKpopArtistName, parentSku, publishableGroupRows } from '../_shared/grouping.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const PLATFORM_BRIDGE_INTERNAL_TOKEN = (Deno as any)['env']['get']('PLATFORM_BRIDGE_INTERNAL_TOKEN') || '';
const EBAY_DEFAULT_CATEGORY_ID = '176984'; // Music > CDs
const EBAY_GOODS_CATEGORY_ID = '108857'; // K-Pop Memorabilia

type BridgeContext = AdapterContext & { userAuthToken?: string };

function s(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value);
}

function n(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

const EBAY_US_DIRECT_SHIPPING_RATES_KRW: Record<number, number> = {
  100: 7200,
  200: 8900,
  300: 10500,
  400: 12300,
  500: 14400,
  600: 15800,
  700: 17200,
  800: 18500,
  900: 19900,
  1000: 20700,
};

const EBAY_FALLBACK_EX_COUNTRY: Record<string, number> = {
  exchangeRate: 1380,
  pgFee: 1.45,
  salesFee: 15.3,
  fspFee: 0,
  otherFee: 0,
  settlementFee: 0,
  gst: 0,
  fspCcb: 0,
  importDuty: 0,
  fixedServiceFee: 0.40,
  purchaseVat: 0,
};

let ebayExCountrySettingsPromise: Promise<Record<string, number>> | null = null;
const ebayShippingSurchargeCache = new Map<string, Promise<any[]>>();

function ebayShippingWeightBucketG(weightG: unknown): number {
  const w = Number(weightG) || 0;
  if (w <= 0) return 0;
  if (w <= 1000) return Math.ceil(w / 100) * 100;
  return 1000;
}

function ebayGetUsShippingRateKrw(weightG: unknown): number {
  const bucket = ebayShippingWeightBucketG(weightG);
  return bucket ? EBAY_US_DIRECT_SHIPPING_RATES_KRW[bucket] || 0 : 0;
}

async function loadEbayExCountrySettings(): Promise<Record<string, number>> {
  if (ebayExCountrySettingsPromise) return ebayExCountrySettingsPromise;
  ebayExCountrySettingsPromise = (async () => {
    try {
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return EBAY_FALLBACK_EX_COUNTRY;
      const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await svc
        .from('country_settings')
        .select('exchange_rate,pg_fee,sales_fee,fsp_fee,other_fee,settlement_fee,gst,fsp_ccb,import_duty,fixed_service_fee,purchase_vat')
        .eq('country_code', 'EX')
        .maybeSingle();
      if (error || !data) return EBAY_FALLBACK_EX_COUNTRY;
      const nf = (value: unknown, defaultValue: number) =>
        value === null || value === undefined || value === '' ? defaultValue : n(value, defaultValue);
      return {
        exchangeRate: nf(data.exchange_rate, EBAY_FALLBACK_EX_COUNTRY.exchangeRate),
        pgFee: nf(data.pg_fee, EBAY_FALLBACK_EX_COUNTRY.pgFee),
        salesFee: nf(data.sales_fee, EBAY_FALLBACK_EX_COUNTRY.salesFee),
        fspFee: nf(data.fsp_fee, EBAY_FALLBACK_EX_COUNTRY.fspFee),
        otherFee: nf(data.other_fee, EBAY_FALLBACK_EX_COUNTRY.otherFee),
        settlementFee: nf(data.settlement_fee, EBAY_FALLBACK_EX_COUNTRY.settlementFee),
        gst: nf(data.gst, EBAY_FALLBACK_EX_COUNTRY.gst),
        fspCcb: nf(data.fsp_ccb, EBAY_FALLBACK_EX_COUNTRY.fspCcb),
        importDuty: nf(data.import_duty, EBAY_FALLBACK_EX_COUNTRY.importDuty),
        fixedServiceFee: nf(data.fixed_service_fee, EBAY_FALLBACK_EX_COUNTRY.fixedServiceFee),
        purchaseVat: nf(data.purchase_vat, EBAY_FALLBACK_EX_COUNTRY.purchaseVat),
      };
    } catch {
      return EBAY_FALLBACK_EX_COUNTRY;
    }
  })();
  return ebayExCountrySettingsPromise;
}

function calcEbayUsdListing(costKrw: number, weightG: number, c: Record<string, number>): number {
  if (!costKrw || costKrw <= 0) return 0;
  const exchangeRate = Number(c.exchangeRate || 0);
  if (!exchangeRate || exchangeRate <= 0) return 0;
  const usShippingKrw = ebayGetUsShippingRateKrw(weightG);
  if (!usShippingKrw) return 0;
  const shipping = usShippingKrw / exchangeRate;
  const effectiveCost = costKrw * (1 - (c.purchaseVat || 0) / 100);
  const settlementLocal = effectiveCost / exchangeRate;
  const cr = (c.salesFee || 0) / 100;
  const vr = (c.gst || 0) / 100;
  const salesPg = (c.pgFee || 0) / 100;
  const salesFsp = (c.fspFee || 0) / 100;
  const salesOther = (c.otherFee || 0) / 100;
  const salesCcb = (c.fspCcb || 0) / 100;
  const settlePct = (c.settlementFee || 0) / 100;
  const fixedFee = c.fixedServiceFee || 0;
  const sf = salesPg + salesFsp + salesOther + salesCcb;
  if (settlePct >= 1) return 0;
  const incomeTarget = settlementLocal / (1 - settlePct);
  const denom = (1 + vr) * (1 - sf) - (cr + vr);
  const raw = denom > 0 ? (incomeTarget + shipping + fixedFee) / denom : 0;
  return Math.round(raw * 100) / 100;
}

async function loadEbayShippingSurchargeRows(weightG: number, exchangeRate: number): Promise<any[]> {
  const bucket = ebayShippingWeightBucketG(weightG);
  if (!bucket || !exchangeRate || exchangeRate <= 0 || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return [];
  const cacheKey = `${bucket}:${exchangeRate}`;
  if (!ebayShippingSurchargeCache.has(cacheKey)) {
    ebayShippingSurchargeCache.set(cacheKey, (async () => {
      try {
        const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
        const { data, error } = await svc
          .from('ebay_shipping_country_rates')
          .select('country_code,country_name,weight_g,baseline_krw,standard_krw,delta_krw,surcharge_usd')
          .eq('weight_g', bucket)
          .gt('delta_krw', 0)
          .order('country_code', { ascending: true });
        if (error || !Array.isArray(data)) return [];
        return data
          .map((row: any) => {
            const deltaKrw = n(row.delta_krw, 0);
            const extraUsd = deltaKrw > 0 ? Math.ceil((deltaKrw / exchangeRate) * 100) / 100 : n(row.surcharge_usd, 0);
            return extraUsd > 0 ? {
              countryCode: s(row.country_code).toUpperCase(),
              countryName: s(row.country_name),
              weightBucketG: bucket,
              baselineKrw: n(row.baseline_krw, 0),
              standardKrw: n(row.standard_krw, 0),
              deltaKrw,
              extraShippingUsd: Number(extraUsd.toFixed(2)),
            } : null;
          })
          .filter(Boolean)
          .slice(0, 80);
      } catch {
        return [];
      }
    })());
  }
  return await ebayShippingSurchargeCache.get(cacheKey)!;
}

async function ebayPricingContext(master: Record<string, unknown>): Promise<any> {
  const costKrw = n(master.cost_krw, 0);
  const weightG = n(master.weight_g, 0);
  const exCountry = await loadEbayExCountrySettings();
  const exchangeRate = n(exCountry.exchangeRate, 0);
  const weightBucketG = ebayShippingWeightBucketG(weightG);
  const usShippingKrw = ebayGetUsShippingRateKrw(weightG);
  const usShippingUsd = exchangeRate > 0 ? usShippingKrw / exchangeRate : 0;
  const shippingSurchargesUsd = await loadEbayShippingSurchargeRows(weightG, exchangeRate);
  const priceUsd = calcEbayUsdListing(costKrw, weightG, exCountry);
  return { exCountry, priceUsd, weightBucketG, usShippingKrw, usShippingUsd, shippingSurchargesUsd };
}

function isGoodsMaster(master: Record<string, unknown>): boolean {
  return s(master.product_kind).trim().toLowerCase() === 'goods';
}

function lifecycleOf(master: Record<string, unknown>): string {
  return s(master.lifecycle_state).toLowerCase() === 'pre_order' ? 'pre_order' : 'ready_stock';
}

function lifecyclePrefix(lifecycle: string): string {
  return lifecycle === 'pre_order' ? '[PRE ORDER]' : '[READY STOCK]';
}

function stripLifecycleTags(value: unknown): string {
  return s(value).replace(/\s*\[(?:PRE\s*[- ]?\s*ORDER|READY\s*[- ]?\s*STOCK|ON\s*HAND|FAST\s*DELIVERY)\]\s*/gi, ' ').replace(/\s+/g, ' ').trim();
}

function lifecycleProductName(value: unknown, lifecycle: string, fallback = ''): string {
  const body = stripLifecycleTags(value) || stripLifecycleTags(fallback) || s(fallback).trim();
  return `${lifecyclePrefix(lifecycle)} ${body}`.replace(/\s+/g, ' ').trim();
}

function imagesFrom(master: Record<string, unknown>): string[] {
  const images = [s(master.main_image), ...(Array.isArray(master.extra_images) ? master.extra_images.map((v) => s(v)) : [])]
    .map((v) => v.trim())
    .filter(Boolean);
  return [...new Set(images)].slice(0, 24);
}

function mapBridgeError(status: number, raw: any): AdapterErrorCode {
  const text = s(raw?.error || raw?.message || raw?.detail).toLowerCase();
  if (status === 401 || status === 403 || text.includes('auth') || text.includes('token') || text.includes('oauth')) return 'PLATFORM_AUTH_FAILED';
  if (status === 429 || text.includes('throttl') || text.includes('rate')) return 'PLATFORM_THROTTLED';
  if (status === 404 || text.includes('not_found') || text.includes('not found')) return 'PLATFORM_NOT_FOUND';
  if (status === 400 || text.includes('required') || text.includes('invalid') || text.includes('category') || text.includes('aspect')) return 'PLATFORM_VALIDATION_ERROR';
  return 'PLATFORM_UNKNOWN';
}

function mapLookupStatus(raw: any): AdapterResult['listingStatus'] {
  const verification = raw?.verification || {};
  const status = s(verification.listing_status || raw?.listingStatus).toUpperCase();
  if (verification.published_offer_found || status === 'PUBLISHED' || status === 'ACTIVE') return 'listed';
  if (verification.inventory_item_found || n(verification.offer_count) > 0) return 'draft';
  return 'not_listed';
}

async function bridgePost(action: string, body: Record<string, unknown>, userToken: string): Promise<{ status: number; raw: any }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ebay-bridge/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userToken}`,
      'apikey': SUPABASE_ANON_KEY,
      'x-platform-bridge-token': PLATFORM_BRIDGE_INTERNAL_TOKEN,
    },
    body: JSON.stringify(body),
  });
  let raw: any;
  try { raw = await res.json(); } catch { raw = { error: await res.text() }; }
  return { status: res.status, raw };
}

async function bridgeGet(action: string, params: Record<string, string>, userToken: string): Promise<{ status: number; raw: any }> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ebay-bridge/${action}?${qs}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${userToken}`,
      'apikey': SUPABASE_ANON_KEY,
      'x-platform-bridge-token': PLATFORM_BRIDGE_INTERNAL_TOKEN,
    },
  });
  let raw: any;
  try { raw = await res.json(); } catch { raw = { error: await res.text() }; }
  return { status: res.status, raw };
}

async function ebayPriceUsd(master: Record<string, unknown>): Promise<string> {
  const direct = n(master.ebay_price_usd || master.price_usd, 0);
  if (direct > 0) return direct.toFixed(2);
  const pricing = await ebayPricingContext(master);
  return pricing.priceUsd > 0 ? Number(pricing.priceUsd).toFixed(2) : '';
}

function aspectsFrom(master: Record<string, unknown>) {
  const existingArtist = s(master.artist || master.brand || master.shopee_brand_name || '').trim();
  const artist = existingArtist && !/^no brand$/i.test(existingArtist) ? existingArtist : inferKpopArtistName(master);
  const title = stripLifecycleTags(master.album || master.release_title || master.product_name || master.sku);
  const aspects: Record<string, string[]> = {
    Type: ['Album'],
    Format: ['CD'],
    Genre: ['K-Pop'],
    'Country of Manufacture': ['South Korea'],
  };
  if (artist) {
    aspects.Artist = [artist];
    aspects['Record Label'] = [artist];
  }
  if (title) aspects['Release Title'] = [title.slice(0, 50)];
  const year = new Date().getUTCFullYear();
  aspects['Release Year'] = [String(year)];
  return aspects;
}

function descriptionFrom(master: Record<string, unknown>): string {
  const description = s(master.description || master.shopee_description || master.components_extracted_en).trim();
  if (description) return description;
  const title = lifecycleProductName(master.product_name, lifecycleOf(master), s(master.sku));
  return `${title}\n\n100% Official & Authentic K-POP Album\nShips from Korea.`;
}

function inventoryGroupKey(master: Record<string, unknown>, rows: Record<string, unknown>[]): string {
  const saved = s(master.ebay_inventory_group_key).trim();
  if (saved) return saved.slice(0, 50);
  return (parentSku(rows) || s(master.sku) || 'EBAY-GROUP')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'EBAY-GROUP';
}

async function createListing(ctx: BridgeContext): Promise<AdapterResult> {
  const userToken = s(ctx.userAuthToken);
  if (!userToken) return { ok: false, listingStatus: 'error', errorCode: 'PLATFORM_AUTH_FAILED', errorMsg: 'Authenticated user token is required for eBay publish' };
  const master = ctx.masterProduct as Record<string, unknown>;
  const groupRows = publishableGroupRows(master, (ctx as any).groupProducts || []);
  const variationBundle = groupRows.length > 1 ? buildVariationItems(groupRows, 'Version') : null;
  const sku = s(master.sku).trim();
  const images = imagesFrom(master);
  const goods = isGoodsMaster(master);
  const categoryId = s(master.ebay_category_id, goods ? '' : EBAY_DEFAULT_CATEGORY_ID).trim() || (goods ? '' : EBAY_DEFAULT_CATEGORY_ID);
  const description = descriptionFrom(master);
  const priceUsd = await ebayPriceUsd(master);
  const pricing = await ebayPricingContext(master);
  const weightG = n(master.weight_g, 0);
  const lifecycleState = lifecycleOf(master);
  const fulfillmentPolicy = resolveEbayFulfillmentPolicy(lifecycleState);
  if (variationBundle) {
    const variationRows = await Promise.all(variationBundle.items.map(async (item: any) => {
      const row = item.row || {};
      const rowImages = imagesFrom(row).length ? imagesFrom(row) : images;
      const rowPricing = await ebayPricingContext(row);
      return {
        productId: row.id || null,
        sku: s(row.ebay_sku || row.sku).trim(),
        optionName: item.optionValue,
        variationValue: item.optionValue,
        priceUsd: await ebayPriceUsd(row),
        quantity: Math.max(0, Math.floor(n(row.inventory, 0))),
        weightG: n(row.weight_g || weightG, 0),
        weightBucketG: rowPricing.weightBucketG,
        usShippingKrw: rowPricing.usShippingKrw,
        usShippingUsd: Number(n(rowPricing.usShippingUsd, 0).toFixed(2)),
        imageUrls: rowImages.slice(0, 12),
      };
    }));
    if (!categoryId || !description || images.length === 0 || variationRows.some((row) => !row.sku || row.sku.length > 50 || !row.priceUsd || row.weightG <= 0 || !row.imageUrls.length)) {
      return {
        ok: false,
        listingStatus: 'not_listed',
        errorCode: 'PLATFORM_VALIDATION_ERROR',
        errorMsg: 'eBay variation create_listing requires categoryId, description, image, sku<=50, price/cost and weight_g for every option',
      };
    }
    const maxCostKrw = Math.max(0, ...variationBundle.items.map((item: any) => n(item.row?.cost_krw, 0)));
    const maxWeightG = Math.max(0, ...variationRows.map((row: any) => n(row.weightG, 0)));
    const maxPricing = await ebayPricingContext({ cost_krw: maxCostKrw, weight_g: maxWeightG });
    const body = {
      listingMode: 'variation',
      productGroupId: master.product_group_id || '',
      inventoryGroupKey: inventoryGroupKey(master, groupRows),
      title: lifecycleProductName(master.product_name, lifecycleState, sku).slice(0, 80),
      description: description.slice(0, 4000),
      imageUrls: images,
      aspects: aspectsFrom(master),
      condition: 'NEW',
      lifecycleState,
      categoryId,
      storeCategoryNames: ['/K-pop'],
      variationAxis: 'Version',
      variations: variationRows,
      weightBucketG: maxPricing.weightBucketG,
      usShippingKrw: maxPricing.usShippingKrw,
      usShippingUsd: Number(n(maxPricing.usShippingUsd, 0).toFixed(2)),
      shippingSurchargePolicy: 'delta_vs_us_baseline',
      shippingSurchargesUsd: maxPricing.shippingSurchargesUsd,
      marketplaceId: s(ctx.country || master.ebay_marketplace_id || 'EBAY_US'),
    };
    if (ctx.dryRun) {
      return { ok: true, listingStatus: 'draft', platformItemId: undefined, rawResponse: { dry_run: true, payload: body, option_products: variationRows.map((row) => ({ product_id: row.productId, sku: row.sku, option_value: row.variationValue })) } };
    }
    const { status, raw } = await bridgePost('publish-variation', body, userToken);
    if (status >= 200 && status < 300 && raw?.ok) {
      return {
        ok: true,
        platformItemId: s(raw.ebay_item_id),
        listingStatus: raw.listingStatus === 'PUBLISHED' ? 'listed' : 'draft',
        rawResponse: {
          ...raw,
          option_products: variationRows.map((row) => ({
            product_id: row.productId,
            sku: row.sku,
            option_value: row.variationValue,
            offer_id: raw.offers_by_sku?.[row.sku]?.offerId || null,
          })),
        },
      };
    }
    return { ok: false, listingStatus: 'error', errorCode: mapBridgeError(status, raw), errorMsg: `ebay-bridge publish-variation failed (${status})`, rawResponse: raw };
  }
  if (!sku || sku.length > 50 || !categoryId || !description || images.length === 0 || !priceUsd || weightG <= 0) {
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'PLATFORM_VALIDATION_ERROR',
      errorMsg: 'eBay create_listing requires sku<=50, categoryId, description, image, price/cost and weight_g',
    };
  }
  const body = {
    sku,
    title: lifecycleProductName(master.product_name, lifecycleState, sku).slice(0, 80),
    lifecycleState,
    fulfillmentPolicyId: fulfillmentPolicy.fulfillmentPolicyId,
    fulfillmentPolicyName: fulfillmentPolicy.fulfillmentPolicyName,
    description: description.slice(0, 4000),
    imageUrls: images,
    aspects: aspectsFrom(master),
    condition: 'NEW',
    priceUsd,
    quantity: Math.max(1, Math.floor(n(master.inventory, 50) || 50)),
    categoryId,
    weightG,
    weightBucketG: pricing.weightBucketG,
    usShippingKrw: pricing.usShippingKrw,
    usShippingUsd: Number(n(pricing.usShippingUsd, 0).toFixed(2)),
    shippingSurchargePolicy: 'delta_vs_us_baseline',
    shippingSurchargesUsd: pricing.shippingSurchargesUsd,
    marketplaceId: s(ctx.country || master.ebay_marketplace_id || 'EBAY_US'),
  };
  if (ctx.dryRun) {
    return { ok: true, listingStatus: 'draft', platformItemId: undefined, rawResponse: { dry_run: true, payload: body } };
  }
  const { status, raw } = await bridgePost('publish', body, userToken);
  if (status >= 200 && status < 300 && raw?.ok) {
    return { ok: true, platformItemId: s(raw.ebay_item_id), listingStatus: raw.listingStatus === 'PUBLISHED' ? 'listed' : 'draft', rawResponse: raw };
  }
  return { ok: false, listingStatus: 'error', errorCode: mapBridgeError(status, raw), errorMsg: `ebay-bridge publish failed (${status})`, rawResponse: raw };
}

async function syncListing(ctx: BridgeContext): Promise<AdapterResult> {
  const userToken = s(ctx.userAuthToken);
  if (!userToken) return { ok: false, listingStatus: 'error', errorCode: 'PLATFORM_AUTH_FAILED', errorMsg: 'Authenticated user token is required for eBay sync' };
  const sku = s(ctx.masterProduct.sku).trim();
  const marketplaceId = s(ctx.country || (ctx.masterProduct as any).ebay_marketplace_id || 'EBAY_US');
  const { status, raw } = await bridgeGet('lookup-item', { sku, marketplace_id: marketplaceId }, userToken);
  if (status >= 200 && status < 300 && raw?.ok) {
    const verification = raw.verification || {};
    const offer = Array.isArray(raw.offers) ? raw.offers.find((row: any) => row?.listingId || row?.offerId) : null;
    const platformItemId = verification.listing_id || offer?.listingId || offer?.offerId || (verification.inventory_item_found ? sku : '');
    return { ok: true, platformItemId: s(platformItemId), listingStatus: mapLookupStatus(raw), rawResponse: raw };
  }
  const verification = raw?.verification || {};
  const lookupMiss = status === 404 || (status >= 200 && status < 300 && raw?.ok === false && !verification.inventory_item_found && n(verification.offer_count) === 0);
  return {
    ok: false,
    listingStatus: 'not_listed',
    errorCode: lookupMiss ? 'PLATFORM_NOT_FOUND' : mapBridgeError(status, raw),
    errorMsg: lookupMiss ? 'eBay SKU not found' : 'eBay lookup failed',
    rawResponse: raw,
  };
}

export const ebayAdapter: PlatformAdapter = {
  supports: new Set(['create_listing', 'sync']),
  async execute(ctx: AdapterContext): Promise<AdapterResult> {
    const bridgeCtx = ctx as BridgeContext;
    if (ctx.capability === 'create_listing') return createListing(bridgeCtx);
    if (ctx.capability === 'sync') return syncListing(bridgeCtx);
    return { ok: false, listingStatus: 'not_listed', errorCode: 'CAPABILITY_UNSUPPORTED', errorMsg: `eBay adapter does not support ${ctx.capability}` };
  },
};
