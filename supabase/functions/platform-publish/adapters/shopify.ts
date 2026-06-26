// @ts-nocheck
// Shopify platform-publish adapter.
// Routes Draft product creation and SKU sync through shopify-bridge.

import type { AdapterContext, AdapterResult, AdapterErrorCode, PlatformAdapter } from '../_shared/contract.ts';
import { buildVariationItems, inferKpopBrandName, parentSku, publishableGroupRows } from '../_shared/grouping.ts';

const SUPABASE_URL = (Deno as any).env.get('SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = (Deno as any).env.get('SUPABASE_ANON_KEY') || '';
const PLATFORM_BRIDGE_INTERNAL_TOKEN = (Deno as any).env.get('PLATFORM_BRIDGE_INTERNAL_TOKEN') || '';

type BridgeContext = AdapterContext & { userAuthToken?: string; shopify?: Record<string, any> };

function s(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value);
}

function n(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function cleanText(value: unknown): string {
  return s(value).replace(/\s+/g, ' ').trim();
}

function stripLifecycleTags(value: unknown): string {
  return cleanText(value).replace(/\s*\[(?:PRE\s*[- ]?\s*ORDER|READY\s*[- ]?\s*STOCK|ON\s*HAND|FAST\s*DELIVERY)\]\s*/gi, ' ').replace(/\s+/g, ' ').trim();
}

function lifecycleOf(master: Record<string, unknown>): string {
  return cleanText(master.lifecycle_state).toLowerCase() === 'pre_order' ? 'pre_order' : 'ready_stock';
}

function lifecycleTag(lifecycle: string): string {
  return lifecycle === 'pre_order' ? 'Pre Order' : 'Ready Stock';
}

function isGoodsMaster(master: Record<string, unknown>): boolean {
  return cleanText(master.product_kind).toLowerCase() === 'goods';
}

function titleFrom(master: Record<string, unknown>, shopify: Record<string, any>): string {
  return cleanText(shopify.title || master.shopify_title || stripLifecycleTags(master.product_name) || master.sku).slice(0, 255);
}

function descriptionHtmlFrom(master: Record<string, unknown>, shopify: Record<string, any>): string {
  const raw = cleanText(shopify.description_html || shopify.description || master.description || master.components_extracted_en || '');
  if (!raw) return '';
  if (/<[a-z][\s\S]*>/i.test(raw)) return raw;
  return raw.split(/\n{2,}/).map((para) => `<p>${para.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</p>`).join('');
}

function vendorFrom(master: Record<string, unknown>, shopify: Record<string, any>): string {
  return cleanText(shopify.vendor || master.shopify_vendor || master.brand || master.shopee_brand_name || master.qoo10_brand_name || inferKpopBrandName(master) || 'starphotocard').slice(0, 255);
}

function productTypeFrom(master: Record<string, unknown>, shopify: Record<string, any>): string {
  return cleanText(shopify.product_type || master.shopify_product_type || (isGoodsMaster(master) ? 'K-pop Goods' : 'K-pop Album')).slice(0, 255);
}

function tagsFrom(master: Record<string, unknown>, shopify: Record<string, any>): string[] {
  const rawTags = [
    ...(Array.isArray(master.shopify_tags) ? master.shopify_tags : []),
    ...(Array.isArray(shopify.tags) ? shopify.tags : cleanText(shopify.tags).split(',')),
    lifecycleTag(lifecycleOf(master)),
    isGoodsMaster(master) ? 'Goods' : 'Album',
    'starphotocard',
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of rawTags) {
    const value = cleanText(tag).slice(0, 255);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.slice(0, 50);
}

function imagesFrom(master: Record<string, unknown>, groupRows: Record<string, unknown>[] = []): any[] {
  const urls = [
    cleanText(master.main_image),
    ...(Array.isArray(master.extra_images) ? master.extra_images.map((v) => cleanText(v)) : []),
    ...groupRows.map((row) => cleanText(row.shopee_option_image_url || row.main_image)),
  ].filter((url) => /^https:\/\//i.test(url));
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
  }
  return unique.slice(0, 10).map((url, index) => ({ originalSource: url, alt: `${cleanText(master.product_name || master.sku) || 'Product'} ${index + 1}` }));
}

function priceFrom(row: Record<string, unknown>, shopify: Record<string, any>): string {
  const explicit = n(row.shopify_price || shopify.price || shopify.price_amount, 0);
  if (explicit > 0) return explicit.toFixed(2);
  const fallback = n(row.cost_krw, 0);
  return fallback > 0 ? String(Math.round(fallback)) : '';
}

function stockFrom(row: Record<string, unknown>): number {
  return Math.max(0, Math.floor(n(row.inventory, 0)));
}

function defaultOptionValue(master: Record<string, unknown>): string {
  return cleanText(master.option_name || 'Default Title') || 'Default Title';
}

function productOptionsFrom(variationBundle: any, master: Record<string, unknown>) {
  if (!variationBundle) {
    return [{ name: 'Title', values: [{ name: defaultOptionValue(master) }] }];
  }
  return variationBundle.spec.axes.map((axis: any) => ({
    name: cleanText(axis.name || 'Option').slice(0, 255) || 'Option',
    values: (axis.values || []).map((value: string) => ({ name: cleanText(value).slice(0, 255) })).filter((value: any) => value.name),
  })).filter((axis: any) => axis.values.length);
}

function variantOptionValues(item: any, variationBundle: any, master: Record<string, unknown>) {
  if (!variationBundle) return [{ optionName: 'Title', name: defaultOptionValue(master) }];
  return variationBundle.spec.tierNames.map((name: string, index: number) => ({
    optionName: cleanText(name).slice(0, 255) || `Option ${index + 1}`,
    name: cleanText(item.optionNames?.[index] || item.optionValue || `Option ${index + 1}`).slice(0, 255),
  }));
}

function buildShopifyPayload(ctx: BridgeContext) {
  const master = ctx.masterProduct as Record<string, unknown>;
  const shopify = ((ctx as any).shopify || {}) as Record<string, any>;
  const groupRows = publishableGroupRows(ctx.masterProduct || {}, (ctx as any).groupProducts || []);
  const variationBundle = groupRows.length > 1 ? buildVariationItems(groupRows, 'Option') : null;
  const rows = variationBundle ? variationBundle.items : [{ row: master, optionValue: defaultOptionValue(master), optionNames: [defaultOptionValue(master)] }];
  const title = titleFrom(master, shopify);
  const variants = rows.map((item: any) => {
    const row = item.row || {};
    const sku = cleanText(row.shopify_sku || row.sku);
    const price = priceFrom(row, shopify);
    const variant: Record<string, any> = {
      product_id: row.id || null,
      sku,
      option_value: cleanText(item.optionValue || defaultOptionValue(row)),
      optionValues: variantOptionValues(item, variationBundle, master),
      quantity: stockFrom(row),
      tracked: shopify.tracked === true,
    };
    if (price) variant.price = price;
    return variant;
  }).filter((variant: any) => variant.sku);
  const parent = variationBundle ? (parentSku(groupRows) || cleanText(master.sku)) : cleanText(master.sku);
  return {
    shop_domain: cleanText(shopify.shop_domain || shopify.shop || ctx.shopId),
    product: {
      title,
      descriptionHtml: descriptionHtmlFrom(master, shopify),
      vendor: vendorFrom(master, shopify),
      productType: productTypeFrom(master, shopify),
      tags: tagsFrom(master, shopify),
      status: 'DRAFT',
      productOptions: productOptionsFrom(variationBundle, master),
      parentSku: parent,
    },
    media: imagesFrom(master, groupRows),
    variants,
    publish: shopify.publish === true,
    set_inventory: shopify.set_inventory === true,
    default_location_gid: cleanText(shopify.default_location_gid),
    default_publication_gid: cleanText(shopify.default_publication_gid),
    dry_run: ctx.dryRun,
    shopify_mutations: ['productCreate', 'productVariantsBulkCreate'],
  };
}

function validatePayload(payload: any): AdapterResult | null {
  if (!payload.product?.title || !payload.variants?.length) {
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'PLATFORM_VALIDATION_ERROR',
      errorMsg: 'Shopify create_listing requires product title and at least one SKU-bearing variant',
    };
  }
  if (!payload.media?.length) {
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'PLATFORM_VALIDATION_ERROR',
      errorMsg: 'Shopify create_listing requires at least one public https image URL',
    };
  }
  return null;
}

function mapBridgeError(status: number, raw: any): AdapterErrorCode {
  const text = cleanText(raw?.error || raw?.message || raw?.error_msg || raw?.detail).toLowerCase();
  if (status === 401 || status === 403 || text.includes('auth') || text.includes('token') || text.includes('oauth')) return 'PLATFORM_AUTH_FAILED';
  if (status === 429 || text.includes('throttl') || text.includes('rate')) return 'PLATFORM_THROTTLED';
  if (status === 404 || text.includes('not_found') || text.includes('not found') || text.includes('product_not_found')) return 'PLATFORM_NOT_FOUND';
  if (status === 400 || text.includes('required') || text.includes('invalid') || text.includes('usererrors')) return 'PLATFORM_VALIDATION_ERROR';
  return 'PLATFORM_UNKNOWN';
}

async function bridgePost(action: string, body: Record<string, unknown>, userToken: string): Promise<{ status: number; raw: any }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/shopify-bridge/${action}`, {
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
  const res = await fetch(`${SUPABASE_URL}/functions/v1/shopify-bridge/${action}?${qs}`, {
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

function optionProductsFrom(raw: any, payload: any) {
  const createdVariants = Array.isArray(raw?.variants) ? raw.variants : [];
  return (payload.variants || []).map((requested: any) => {
    const hit = createdVariants.find((variant: any) => cleanText(variant?.sku) === cleanText(requested.sku)) || null;
    return {
      product_id: requested.product_id || null,
      sku: requested.sku,
      option_value: requested.option_value || '',
      variant_id: hit?.id || requested.sku,
      inventory_item_id: hit?.inventoryItem?.id || null,
    };
  });
}

async function createListing(ctx: BridgeContext): Promise<AdapterResult> {
  const userToken = cleanText(ctx.userAuthToken);
  if (!userToken) return { ok: false, listingStatus: 'error', errorCode: 'PLATFORM_AUTH_FAILED', errorMsg: 'Authenticated user token is required for Shopify create' };
  const payload = buildShopifyPayload(ctx);
  const validation = validatePayload(payload);
  if (validation) return validation;
  if (ctx.dryRun) {
    return {
      ok: true,
      listingStatus: 'draft',
      rawResponse: {
        dry_run: true,
        payload,
        productVariantsBulkCreate: payload.variants,
        option_products: optionProductsFrom({}, payload),
      },
    };
  }
  const { status, raw } = await bridgePost('create-product', payload, userToken);
  if (status >= 200 && status < 300 && raw?.ok !== false) {
    return {
      ok: true,
      platformItemId: cleanText(raw.product_id || raw.platform_item_id),
      listingStatus: ctx.dryRun ? 'draft' : 'draft',
      rawResponse: {
        ...raw,
        platform_item_id: raw.product_id || raw.platform_item_id || null,
        variant_id: raw.variant_id || raw.variants?.[0]?.id || null,
        option_products: optionProductsFrom(raw, payload),
      },
    };
  }
  return {
    ok: false,
    listingStatus: status === 404 ? 'not_listed' : 'error',
    errorCode: mapBridgeError(status, raw),
    errorMsg: `shopify-bridge create-product failed (${status})`,
    rawResponse: raw,
  };
}

async function syncListing(ctx: BridgeContext): Promise<AdapterResult> {
  const userToken = cleanText(ctx.userAuthToken);
  if (!userToken) return { ok: false, listingStatus: 'error', errorCode: 'PLATFORM_AUTH_FAILED', errorMsg: 'Authenticated user token is required for Shopify sync' };
  const master = ctx.masterProduct as Record<string, unknown>;
  const shopify = ((ctx as any).shopify || {}) as Record<string, any>;
  const params: Record<string, string> = {
    sku: cleanText(master.shopify_sku || master.sku),
  };
  const shopDomain = cleanText(shopify.shop_domain || shopify.shop || ctx.shopId);
  if (shopDomain) params.shop_domain = shopDomain;
  const { status, raw } = await bridgeGet('lookup-sku', params, userToken);
  if (status >= 200 && status < 300 && raw?.ok) {
    return {
      ok: true,
      platformItemId: cleanText(raw.product_id || raw.platform_item_id),
      listingStatus: (cleanText(raw.listing_status) || 'draft') as AdapterResult['listingStatus'],
      rawResponse: {
        ...raw,
        platform_item_id: raw.product_id || raw.platform_item_id || null,
        variant_id: raw.variant_id || raw.external_variant_id || null,
      },
    };
  }
  const errorCode = mapBridgeError(status, raw);
  return {
    ok: false,
    listingStatus: errorCode === 'PLATFORM_NOT_FOUND' ? 'not_listed' : 'error',
    errorCode,
    errorMsg: cleanText(raw?.error || raw?.message || 'Shopify SKU not found'),
    rawResponse: raw,
  };
}

export const shopifyAdapter: PlatformAdapter = {
  supports: new Set(['create_listing', 'sync']),
  async execute(ctx: AdapterContext): Promise<AdapterResult> {
    const bridgeCtx = ctx as BridgeContext;
    if (ctx.capability === 'create_listing') return createListing(bridgeCtx);
    if (ctx.capability === 'sync') return syncListing(bridgeCtx);
    return { ok: false, listingStatus: 'not_listed', errorCode: 'CAPABILITY_UNSUPPORTED', errorMsg: `Shopify adapter does not support ${ctx.capability}` };
  },
};
