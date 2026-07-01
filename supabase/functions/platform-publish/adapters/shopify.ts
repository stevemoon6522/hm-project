// @ts-nocheck
// Shopify platform-publish adapter.
// Routes Draft product creation and SKU sync through shopify-bridge.

import type { AdapterContext, AdapterResult, AdapterErrorCode, PlatformAdapter } from '../_shared/contract.ts';
import { buildVariationItems, deriveKpopFromTitle, inferKpopBrandName, parentSku, publishableGroupRows } from '../_shared/grouping.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = (Deno as any).env.get('SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = (Deno as any).env.get('SUPABASE_ANON_KEY') || '';
const SUPABASE_SERVICE_ROLE_KEY = (Deno as any).env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const PLATFORM_BRIDGE_INTERNAL_TOKEN = (Deno as any).env.get('PLATFORM_BRIDGE_INTERNAL_TOKEN') || '';

const SHOPIFY_DEFAULT_PRICE_POLICY = Object.freeze({
  currency: 'USD',
  krwPerUsd: 1460,
  targetMarginPct: 30,
  paymentFeePct: 1,
  transactionFeePct: 10,
  fixedOperationFeePct: 0,
  includeShippingInPrice: false,
  defaultStatus: 'ACTIVE',
  setInventory: false,
});

type BridgeContext = AdapterContext & { userAuthToken?: string; shopify?: Record<string, any> };
type ShopifyPricePolicy = typeof SHOPIFY_DEFAULT_PRICE_POLICY;
let shopifyPricePolicyPromise: Promise<ShopifyPricePolicy> | null = null;
let shopifyPricePolicyLoadedAt = 0;
const SHOPIFY_PRICE_POLICY_CACHE_MS = 30_000;

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

function b(value: unknown, fallback = false): boolean {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function shopifyStatusValue(value: unknown, fallback = SHOPIFY_DEFAULT_PRICE_POLICY.defaultStatus): string {
  const status = cleanText(value).toUpperCase();
  if (['ACTIVE', 'DRAFT', 'ARCHIVED'].includes(status)) return status;
  return fallback;
}

function normalizeShopifyPricePolicy(row: Record<string, unknown> | null | undefined): ShopifyPricePolicy {
  const fallback = SHOPIFY_DEFAULT_PRICE_POLICY;
  if (!row) return fallback;
  const nf = (key: string, fallbackValue: number) => {
    const value = row[key];
    if (value === null || value === undefined || value === '') return fallbackValue;
    return n(value, fallbackValue);
  };
  const krwPerUsd = nf('krw_per_usd', fallback.krwPerUsd);
  const targetMarginPct = nf('target_margin_pct', fallback.targetMarginPct);
  const paymentFeePct = nf('payment_fee_pct', fallback.paymentFeePct);
  const transactionFeePct = nf('transaction_fee_pct', fallback.transactionFeePct);
  const fixedOperationFeePct = nf('fixed_operation_fee_pct', fallback.fixedOperationFeePct);
  return Object.freeze({
    currency: cleanText(row.currency || fallback.currency).toUpperCase() || fallback.currency,
    krwPerUsd: krwPerUsd > 0 ? krwPerUsd : fallback.krwPerUsd,
    targetMarginPct: targetMarginPct >= 0 && targetMarginPct < 100 ? targetMarginPct : fallback.targetMarginPct,
    paymentFeePct: paymentFeePct >= 0 ? paymentFeePct : fallback.paymentFeePct,
    transactionFeePct: transactionFeePct >= 0 ? transactionFeePct : fallback.transactionFeePct,
    fixedOperationFeePct: fixedOperationFeePct >= 0 ? fixedOperationFeePct : fallback.fixedOperationFeePct,
    includeShippingInPrice: b(row.include_shipping_in_price, fallback.includeShippingInPrice),
    defaultStatus: shopifyStatusValue(row.default_status, fallback.defaultStatus),
    setInventory: b(row.set_inventory, fallback.setInventory),
  });
}

async function loadShopifyPricePolicy(): Promise<ShopifyPricePolicy> {
  if (shopifyPricePolicyPromise && Date.now() - shopifyPricePolicyLoadedAt < SHOPIFY_PRICE_POLICY_CACHE_MS) return shopifyPricePolicyPromise;
  shopifyPricePolicyLoadedAt = Date.now();
  shopifyPricePolicyPromise = (async () => {
    try {
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return SHOPIFY_DEFAULT_PRICE_POLICY;
      const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await svc
        .from('shopify_price_policy')
        .select('currency,krw_per_usd,target_margin_pct,payment_fee_pct,transaction_fee_pct,fixed_operation_fee_pct,include_shipping_in_price,default_status,set_inventory')
        .eq('id', 'default')
        .maybeSingle();
      if (error || !data) return SHOPIFY_DEFAULT_PRICE_POLICY;
      return normalizeShopifyPricePolicy(data);
    } catch {
      return SHOPIFY_DEFAULT_PRICE_POLICY;
    }
  })();
  return shopifyPricePolicyPromise;
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

function shopifyHtmlEscape(value: unknown): string {
  return s(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch] || ch));
}

function shopifySplitTopLevelComponents(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  for (const ch of s(value)) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if ((ch === ')' || ch === ']' || ch === '}') && depth > 0) depth -= 1;
    if ((ch === ',' || ch === ';') && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function shopifyComponentLines(components: unknown): string[] {
  const normalized = s(components)
    .replace(/\r\n?/g, '\n')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(div|p|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[•●○◦▪▫·]+/g, '\n')
    .replace(/\s+\|\s+/g, '\n');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const segment of normalized.split(/\n+/)) {
    for (const piece of shopifySplitTopLevelComponents(segment)) {
      const value = piece
        .replace(/^[\s\-*•●○◦▪▫·]+/, '')
        .replace(/^\d+[.)]\s*/, '')
        .trim();
      const key = value.toLowerCase();
      if (!value || seen.has(key)) continue;
      seen.add(key);
      out.push(value.slice(0, 260));
    }
  }
  return out.slice(0, 12);
}

function shopifyDescriptionCard(title: string, bodyHtml: string, bgColor = '#fff7fb'): string {
  return `<table width="100%" bgcolor="${bgColor}"><tr><td><b>${shopifyHtmlEscape(title)}</b><br>${bodyHtml}</td></tr></table>`;
}

function shopifyDescriptionList(items: string[]): string {
  const html = items
    .map((value) => cleanText(value))
    .filter(Boolean)
    .map((value) => `<li>${shopifyHtmlEscape(value.slice(0, 260))}</li>`)
    .join('');
  return html ? `<ul>${html}</ul>` : '';
}

function shopifyDescriptionTable(headers: string[], rows: string[][]): string {
  const head = `<tr>${(headers || [])
    .map((value) => `<td><b>${shopifyHtmlEscape(s(value).slice(0, 80))}</b></td>`)
    .join('')}</tr>`;
  const body = (rows || [])
    .map((row) => `<tr>${(row || [])
      .map((value) => `<td>${shopifyHtmlEscape(s(value).slice(0, 220))}</td>`)
      .join('')}</tr>`)
    .join('');
  return `<table width="100%" border="1">${head}${body}</table>`;
}

function shopifyEbayDescriptionHtmlFrom(master: Record<string, unknown>, title: string, lifecycleState: string): string {
  const componentLines = shopifyComponentLines(master.components_extracted_en);
  const stockLine = lifecycleState === 'ready_stock'
    ? 'Ready stock ships in about 1 business day, excluding weekends and Korean holidays.'
    : 'Pre-order ships after official release and warehouse arrival; distributor delays may change the schedule.';
  const shippingTable = shopifyDescriptionTable(
    ['Service', 'Destination area', 'Estimated transit after dispatch'],
    [
      ['Economy / Standard', 'US, CA, AU, JP, SG, HK, Asia', 'Usually 5-20 business days; delayed parcels may take 20-30.'],
      ['Economy / Standard', 'UK, DE, FR, ES, most Europe', 'Usually 10-30 business days; customs or local backlog may add days.'],
      ['Economy / Standard', 'Brazil, Italy, South America, Africa, remote regions', 'Usually 20-50 business days; slower customs is common.'],
      ['Expedited', 'US/CA/MX 2-5 days; Asia/AU 3-7; UK/EU 4-8; South America/Africa/remote 5-10+', 'Used when selected, upgraded, or required for a destination.'],
    ],
  );
  const productTitle = title || cleanText(master.sku) || 'K-pop item';
  const cards = [
    shopifyDescriptionCard(
      'Album product information',
      `Hello, K-pop collector. Official K-pop goods from Korea, packed carefully.<br><br><strong>${shopifyHtmlEscape(productTitle)}</strong>`,
      '#fff7fb',
    ),
    shopifyDescriptionCard(
      'What is included / Handling before shipment',
      shopifyDescriptionList((componentLines.length ? componentLines : ['Each option includes 1 album. Random inclusions follow the official manufacturer policy.']).concat([
        stockLine,
        "Ships only to the buyer's Shopify checkout address. Confirm name, address, and phone before payment.",
        'Tracking uploads after dispatch; the first scan may take 24-48 hours.',
      ])),
      '#f8fbff',
    ),
    shopifyDescriptionCard(
      'International shipping time guide',
      `Estimates exclude handling, weekends, holidays, customs, and local delays.<br>${shippingTable}`,
      '#fffaf0',
    ),
    shopifyDescriptionCard(
      'Customs, Duties & Taxes',
      `<strong>For buyers in the United States (DDP Service)</strong>${
        shopifyDescriptionList([
          'Guaranteed Landed Cost: For standard US DDP orders, applicable import duties and customs taxes are handled in advance through our logistics solution. Checkout price is final for covered orders.',
          'Zero Hidden Fees: Customs costs are prepaid, so the courier should not request extra brokerage or delivery customs fees on arrival.',
          'Optimization Promise: Specialized logistics consolidation helps keep customs clearance compliant and administrative costs low.',
        ])
      }<strong>For international buyers (Europe, Asia, Australia, Canada & More)</strong>${
        shopifyDescriptionList([
          'Transparent Pricing: Listing prices generally do not include destination import duties or VAT unless Shopify collects them at checkout.',
          'Payment of Taxes: Local duties, VAT, GST, brokerage, or handling charges are government taxes, not shipping fees, and may be collected by the carrier before delivery.',
          'Our Promise: We prepare customs documents carefully. If documents are needed, contact us and we will respond quickly.',
          'Delivery Cooperation: Please check local customs rules. If returned because customs charges are unpaid, return shipping costs may be deducted from the refund.',
        ])
      }`,
      '#f8fafc',
    ),
    shopifyDescriptionCard(
      'Important notice and friendly support',
      shopifyDescriptionList([
        'Outer packaging may have small marks from production or shipping. Random inclusions cannot be selected unless the option title says so.',
        'Please contact us first. Returns follow store policy; items must be unused, unopened, and complete. Address errors, refusal, or unpaid fees may reduce the refund.',
      ]),
      '#fff7fb',
    ),
  ];
  return cards.join('<br>\n').slice(0, 4000);
}

function descriptionHtmlFrom(master: Record<string, unknown>, shopify: Record<string, any>): string {
  const override = shopify.description_html || shopify.description;
  const raw = s(override).trim();
  if (!raw) {
    return shopifyEbayDescriptionHtmlFrom(
      master,
      stripLifecycleTags(master.product_name) || cleanText(master.sku),
      lifecycleOf(master),
    );
  }
  if (/<[a-z][\s\S]*>/i.test(raw)) return raw;
  return raw.split(/\n{2,}/).map((para) => `<p>${para.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</p>`).join('');
}

function vendorFrom(master: Record<string, unknown>, shopify: Record<string, any>): string {
  return cleanText(shopify.vendor || master.shopify_vendor || master.brand || master.shopee_brand_name || master.qoo10_brand_name || inferKpopBrandName(master) || 'starphotocard').slice(0, 255);
}

function productTypeFrom(master: Record<string, unknown>, shopify: Record<string, any>): string {
  return cleanText(shopify.product_type || master.shopify_product_type || (isGoodsMaster(master) ? 'K-pop Goods' : 'K-pop Album')).slice(0, 255);
}

function isMeaningfulShopifyTagSource(value: unknown): boolean {
  const text = cleanText(value);
  return !!text && !/^no\s*brand$/i.test(text);
}

function shopifyArtistAlbumTagsFrom(master: Record<string, unknown>, shopify: Record<string, any>): string[] {
  const derived = deriveKpopFromTitle(shopify.title || master.product_name || master.sku);
  const artist = [
    shopify.artist,
    master.artist,
    derived.artist,
    master.brand,
    master.shopee_brand_name,
    master.qoo10_brand_name,
  ].find(isMeaningfulShopifyTagSource);
  const album = [
    shopify.album,
    master.album,
    master.release_title,
    derived.album,
  ].find(isMeaningfulShopifyTagSource);
  return [artist, album].map((value) => cleanText(value)).filter(Boolean);
}

function tagsFrom(master: Record<string, unknown>, shopify: Record<string, any>): string[] {
  const rawTags = [
    ...(Array.isArray(master.shopify_tags) ? master.shopify_tags : []),
    ...(Array.isArray(shopify.tags) ? shopify.tags : cleanText(shopify.tags).split(',')),
    ...shopifyArtistAlbumTagsFrom(master, shopify),
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

function shopifyPriceFromCostKrw(costKrw: number, policy: ShopifyPricePolicy = SHOPIFY_DEFAULT_PRICE_POLICY): string {
  if (!(costKrw > 0)) return '';
  const feePct = policy.targetMarginPct + policy.paymentFeePct + policy.transactionFeePct + policy.fixedOperationFeePct;
  const denominator = 1 - feePct / 100;
  if (!(policy.krwPerUsd > 0) || !(denominator > 0)) return '';
  const raw = costKrw / policy.krwPerUsd / denominator;
  return (Math.ceil(raw * 100) / 100).toFixed(2);
}

function priceFrom(row: Record<string, unknown>, shopify: Record<string, any>, policy: ShopifyPricePolicy): string {
  const explicit = n(row.shopify_price || shopify.price || shopify.price_amount, 0);
  if (explicit > 0) return explicit.toFixed(2);
  return shopifyPriceFromCostKrw(n(row.cost_krw, 0), policy);
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

function shopifyProductStatus(shopify: Record<string, any>, policy: ShopifyPricePolicy): string {
  const status = cleanText(shopify.status || shopify.product_status).toUpperCase();
  if (['ACTIVE', 'DRAFT', 'ARCHIVED'].includes(status)) return status;
  return policy.defaultStatus;
}

function listingStatusFromProductStatus(status: unknown): AdapterResult['listingStatus'] {
  const value = cleanText(status).toUpperCase();
  if (value === 'ACTIVE') return 'listed';
  if (value === 'ARCHIVED') return 'paused';
  if (value === 'DRAFT') return 'draft';
  return 'draft';
}

function variantOptionValues(item: any, variationBundle: any, master: Record<string, unknown>) {
  if (!variationBundle) return [{ optionName: 'Title', name: defaultOptionValue(master) }];
  return variationBundle.spec.tierNames.map((name: string, index: number) => ({
    optionName: cleanText(name).slice(0, 255) || `Option ${index + 1}`,
    name: cleanText(item.optionNames?.[index] || item.optionValue || `Option ${index + 1}`).slice(0, 255),
  }));
}

async function buildShopifyPayload(ctx: BridgeContext) {
  const policy = await loadShopifyPricePolicy();
  const master = ctx.masterProduct as Record<string, unknown>;
  const shopify = ((ctx as any).shopify || {}) as Record<string, any>;
  const groupRows = publishableGroupRows(ctx.masterProduct || {}, (ctx as any).groupProducts || []);
  const variationBundle = groupRows.length > 1 ? buildVariationItems(groupRows, 'Option') : null;
  const rows = variationBundle ? variationBundle.items : [{ row: master, optionValue: defaultOptionValue(master), optionNames: [defaultOptionValue(master)] }];
  const title = titleFrom(master, shopify);
  const variants = rows.map((item: any) => {
    const row = item.row || {};
    const sku = cleanText(row.shopify_sku || row.sku);
    const price = priceFrom(row, shopify, policy);
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
      status: shopifyProductStatus(shopify, policy),
      productOptions: productOptionsFrom(variationBundle, master),
      parentSku: parent,
    },
    media: imagesFrom(master, groupRows),
    variants,
    publish: shopify.publish === true,
    set_inventory: shopify.set_inventory === true && policy.setInventory === true,
    default_location_gid: cleanText(shopify.default_location_gid),
    default_publication_gid: cleanText(shopify.default_publication_gid),
    dry_run: ctx.dryRun,
    pricing_policy: policy,
    duplicate_sku_preflight: true,
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
  if ((payload.variants || []).some((variant: any) => !variant.price)) {
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'PLATFORM_VALIDATION_ERROR',
      errorMsg: 'Shopify create_listing requires a USD price for every SKU-bearing variant',
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
  if (status === 409 || text.includes('duplicate_sku') || text.includes('ambiguous')) return 'PLATFORM_VALIDATION_ERROR';
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

async function preflightShopifyDuplicateSkus(payload: any, userToken: string): Promise<AdapterResult | null> {
  const shopDomain = cleanText(payload.shop_domain);
  const checked = new Set<string>();
  for (const variant of payload.variants || []) {
    const sku = cleanText(variant.sku);
    if (!sku || checked.has(sku)) continue;
    checked.add(sku);
    const params: Record<string, string> = { sku };
    if (shopDomain) params.shop_domain = shopDomain;
    const { status, raw } = await bridgeGet('lookup-sku', params, userToken);
    if (status >= 200 && status < 300 && raw?.ok) {
      return {
        ok: false,
        listingStatus: 'not_listed',
        errorCode: 'PLATFORM_VALIDATION_ERROR',
        errorMsg: `SHOPIFY_DUPLICATE_SKU: ${sku} already exists on Shopify`,
        rawResponse: { ...raw, code: 'SHOPIFY_DUPLICATE_SKU', duplicate_sku: sku },
      };
    }
    const notFound = status === 404 || /product_not_found|not_found|not found/i.test(cleanText(raw?.error || raw?.message || raw?.error_msg));
    if (notFound) continue;
    return {
      ok: false,
      listingStatus: 'error',
      errorCode: mapBridgeError(status, raw),
      errorMsg: `Shopify duplicate SKU preflight failed (${status})`,
      rawResponse: raw,
    };
  }
  return null;
}

async function createListing(ctx: BridgeContext): Promise<AdapterResult> {
  const userToken = cleanText(ctx.userAuthToken);
  if (!userToken) return { ok: false, listingStatus: 'error', errorCode: 'PLATFORM_AUTH_FAILED', errorMsg: 'Authenticated user token is required for Shopify create' };
  const payload = await buildShopifyPayload(ctx);
  const validation = validatePayload(payload);
  if (validation) return validation;
  if (ctx.dryRun) {
    return {
      ok: true,
      listingStatus: listingStatusFromProductStatus(payload.product?.status),
      rawResponse: {
        dry_run: true,
        payload,
        productVariantsBulkCreate: payload.variants,
        option_products: optionProductsFrom({}, payload),
      },
    };
  }
  const duplicateSku = await preflightShopifyDuplicateSkus(payload, userToken);
  if (duplicateSku) return duplicateSku;
  const { status, raw } = await bridgePost('create-product', payload, userToken);
  if (status >= 200 && status < 300 && raw?.ok !== false) {
    return {
      ok: true,
      platformItemId: cleanText(raw.product_id || raw.platform_item_id),
      listingStatus: (cleanText(raw.listing_status) || listingStatusFromProductStatus(payload.product?.status)) as AdapterResult['listingStatus'],
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
