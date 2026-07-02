// @ts-nocheck
// shopify-bridge: Shopify Admin GraphQL bridge for V2 product registration.
//
// Local docs:
//   C:\dev\api-refs\marketplaces\shopify\product-create.graphql.md
//   C:\dev\api-refs\marketplaces\shopify\product-variants-bulk-create.graphql.md
//   C:\dev\api-refs\marketplaces\shopify\product-variants-bulk-update.graphql.md
//   C:\dev\api-refs\marketplaces\shopify\inventory-item-update.graphql.md
//   C:\dev\api-refs\marketplaces\shopify\inventory-set-quantities.graphql.md
//   C:\dev\api-refs\marketplaces\shopify\publishable-publish.graphql.md
//
// OAuth source: Shopify authorization-code grant
// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { AUTH_CORS, requireAuthenticatedUser } from '../_shared/auth.ts';

const SHOPIFY_API_VERSION = (Deno as any).env.get('SHOPIFY_API_VERSION') || '2026-04';
const SHOPIFY_CLIENT_ID = (Deno as any).env.get('SHOPIFY_CLIENT_ID') || '';
const SHOPIFY_CLIENT_SECRET = (Deno as any).env.get('SHOPIFY_CLIENT_SECRET') || '';
const SHOPIFY_REDIRECT_URI = (Deno as any).env.get('SHOPIFY_REDIRECT_URI') || '';
const SHOPIFY_SCOPES = ((Deno as any).env.get('SHOPIFY_SCOPES') || 'read_products,write_products,write_inventory,write_shipping').split(',').map((s: string) => s.trim()).filter(Boolean).join(',');
const SHOPIFY_CARRIER_CALLBACK_URL = (Deno as any).env.get('SHOPIFY_CARRIER_CALLBACK_URL') || 'https://shopee-dashboard-kohl.vercel.app/api/shopify-shipping-rates';
const PLATFORM_BRIDGE_INTERNAL_TOKEN = (Deno as any).env.get('PLATFORM_BRIDGE_INTERNAL_TOKEN') || '';

const SUPABASE_URL = (Deno as any).env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = (Deno as any).env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const CORS: Record<string, string> = {
  ...AUTH_CORS,
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info, x-platform-bridge-token',
  'Access-Control-Max-Age': '3600',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function norm(value: unknown): string {
  return String(value ?? '').trim();
}

function uniq(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = norm(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function normalizeShopDomain(value: unknown): string {
  let shop = norm(value).toLowerCase();
  shop = shop.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!shop) return '';
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) return '';
  return shop;
}

function requireInternalBridge(req: Request): Response | null {
  const got = norm(req.headers.get('x-platform-bridge-token'));
  if (!PLATFORM_BRIDGE_INTERNAL_TOKEN || got !== PLATFORM_BRIDGE_INTERNAL_TOKEN) {
    return jsonResp({ ok: false, error: 'internal_bridge_required' }, 401);
  }
  return null;
}

async function requireBridgeTokenOrAuthenticatedUser(req: Request): Promise<Response | null> {
  const got = norm(req.headers.get('x-platform-bridge-token'));
  if (PLATFORM_BRIDGE_INTERNAL_TOKEN && got === PLATFORM_BRIDGE_INTERNAL_TOKEN) return null;
  const auth = await requireAuthenticatedUser(req);
  return auth.response || null;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyShopifyOAuthHmac(url: URL): Promise<boolean> {
  const hmac = norm(url.searchParams.get('hmac'));
  if (!hmac || !SHOPIFY_CLIENT_SECRET) return false;
  const pairs: string[] = [];
  const keys = [...new Set([...url.searchParams.keys()])].filter((key) => key !== 'hmac' && key !== 'signature').sort();
  for (const key of keys) {
    const values = url.searchParams.getAll(key).sort();
    for (const value of values) pairs.push(`${key}=${value}`);
  }
  const digest = await hmacSha256Hex(SHOPIFY_CLIENT_SECRET, pairs.join('&'));
  return digest === hmac;
}

function shopifyAdminUrl(shopDomain: string): string {
  return `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
}

async function shopifyGraphql(shop: any, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(shopifyAdminUrl(shop.shop_domain), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Shopify-Access-Token': shop.access_token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const raw = await res.json().catch(() => ({ errors: [{ message: `HTTP ${res.status}` }] }));
  return { status: res.status, raw };
}

function graphUserErrors(raw: any, key: string): any[] {
  const userErrors = raw?.data?.[key]?.userErrors;
  const mediaUserErrors = raw?.data?.[key]?.mediaUserErrors;
  return [
    ...(Array.isArray(userErrors) ? userErrors : []),
    ...(Array.isArray(mediaUserErrors) ? mediaUserErrors : []),
  ];
}

function graphErrorMessage(raw: any, key = ''): string {
  const userErrors = key ? graphUserErrors(raw, key) : [];
  if (userErrors.length) return userErrors.map((e: any) => norm(e.message)).filter(Boolean).join(' / ');
  if (Array.isArray(raw?.errors) && raw.errors.length) return raw.errors.map((e: any) => norm(e.message)).filter(Boolean).join(' / ');
  return norm(raw?.error || raw?.message) || 'Shopify GraphQL request failed';
}

function mapShopifyListingStatus(product: any): string {
  const status = norm(product?.status).toUpperCase();
  if (product?.publishedAt) return 'listed';
  if (status === 'ACTIVE') return 'listed';
  if (status === 'ARCHIVED') return 'paused';
  if (status === 'DRAFT') return 'draft';
  return product?.id ? 'draft' : 'not_listed';
}

function shopifyProductStatus(value: unknown): string {
  const status = norm(value).toUpperCase();
  if (['ACTIVE', 'DRAFT', 'ARCHIVED'].includes(status)) return status;
  return 'ACTIVE';
}

function shopifySearchString(value: unknown): string {
  return norm(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function shopifyGid(kind: string, value: unknown): string {
  const text = norm(value);
  if (new RegExp(`^gid://shopify/${kind}/\\d+$`).test(text)) return text;
  if (/^\d+$/.test(text)) return `gid://shopify/${kind}/${text}`;
  return '';
}

function shopifyProductGid(value: unknown): string {
  return shopifyGid('Product', value);
}

function shopifyVariantGid(value: unknown): string {
  return shopifyGid('ProductVariant', value);
}

function shopifyInventoryItemGid(value: unknown): string {
  return shopifyGid('InventoryItem', value);
}

function shopScopeSet(shop: any): Set<string> {
  const scopes = Array.isArray(shop?.scopes) ? shop.scopes : norm(shop?.scopes).split(',');
  return new Set(scopes.map((scope: unknown) => norm(scope)).filter(Boolean));
}

async function configuredShop(shopDomain = '') {
  let q = supabase
    .from('shopify_shops')
    .select('id,shop_domain,shop_name,access_token,scopes,default_location_gid,default_publication_gid,currency,status,auth_verified')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1);
  if (shopDomain) q = q.eq('shop_domain', shopDomain);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`shopify_shops lookup failed: ${error.message}`);
  if (!data) throw new Error(shopDomain ? `Shopify shop not configured: ${shopDomain}` : 'No active Shopify shop configured');
  return data;
}

function productOptionsFrom(body: any) {
  const input = Array.isArray(body.product?.productOptions) ? body.product.productOptions : [];
  if (input.length) return input;
  return [{ name: 'Title', values: [{ name: 'Default Title' }] }];
}

function mediaFrom(body: any) {
  const images = Array.isArray(body.media) ? body.media : [];
  return images
    .map((row: any) => ({
      originalSource: norm(row?.originalSource || row?.url || row),
      mediaContentType: 'IMAGE',
      alt: norm(row?.alt || body.product?.title || 'Product image').slice(0, 512),
    }))
    .filter((row: any) => /^https:\/\//i.test(row.originalSource))
    .slice(0, 10);
}

function mediaSourceKey(value: unknown): string {
  return norm(value);
}

function variantMediaSrcs(variant: any): string[] {
  if (Array.isArray(variant.mediaSrc)) {
    return variant.mediaSrc.map((url: unknown) => norm(url)).filter((url: string) => /^https:\/\//i.test(url)).slice(0, 10);
  }
  const mediaSrc = norm(variant.mediaSrc || variant.image || variant.imageUrl || variant.option_image_url);
  return /^https:\/\//i.test(mediaSrc) ? [mediaSrc] : [];
}

function firstMappedMediaId(mediaSrc: string[], mediaIdBySource: any): string {
  const mediaMap = mediaIdBySource || {};
  for (const source of mediaSrc) {
    const mediaId = norm(mediaMap[mediaSourceKey(source)]);
    if (mediaId) return mediaId;
  }
  return '';
}

function mediaIdMappingFrom(mediaInputs: any[], createdMedia: any[]) {
  const inputs = Array.isArray(mediaInputs) ? mediaInputs : [];
  const media = Array.isArray(createdMedia) ? createdMedia : [];
  const sourceToMediaId: Record<string, string> = {};
  const usedMediaIndexes = new Set<number>();
  const sourceKeys = inputs.map((input: any) => mediaSourceKey(input?.originalSource)).filter(Boolean);
  const uniqueSourceCount = new Set(sourceKeys).size;
  const inputAltCounts = new Map<string, number>();
  const mediaAltCounts = new Map<string, number>();
  for (const input of inputs) {
    const alt = norm(input?.alt);
    if (alt) inputAltCounts.set(alt, (inputAltCounts.get(alt) || 0) + 1);
  }
  for (const node of media) {
    const alt = norm(node?.alt);
    if (alt && norm(node?.id)) mediaAltCounts.set(alt, (mediaAltCounts.get(alt) || 0) + 1);
  }

  let mappedByAlt = 0;
  let mappedByIndex = 0;
  for (const input of inputs) {
    const source = mediaSourceKey(input?.originalSource);
    const alt = norm(input?.alt);
    if (!source || sourceToMediaId[source] || !alt) continue;
    if (inputAltCounts.get(alt) !== 1 || mediaAltCounts.get(alt) !== 1) continue;
    const mediaIndex = media.findIndex((node: any, index: number) => !usedMediaIndexes.has(index) && norm(node?.alt) === alt && norm(node?.id));
    if (mediaIndex < 0) continue;
    sourceToMediaId[source] = norm(media[mediaIndex]?.id);
    usedMediaIndexes.add(mediaIndex);
    mappedByAlt += 1;
  }

  if (media.length === inputs.length) {
    for (const [index, input] of inputs.entries()) {
      const source = mediaSourceKey(input?.originalSource);
      const mediaId = norm(media[index]?.id);
      if (!source || sourceToMediaId[source] || !mediaId || usedMediaIndexes.has(index)) continue;
      sourceToMediaId[source] = mediaId;
      usedMediaIndexes.add(index);
      mappedByIndex += 1;
    }
  }

  const mappedCount = Object.keys(sourceToMediaId).length;
  return {
    sourceToMediaId,
    diagnostics: {
      requested_count: inputs.length,
      unique_source_count: uniqueSourceCount,
      created_count: media.filter((node: any) => norm(node?.id)).length,
      mapped_count: mappedCount,
      mapped_by_alt: mappedByAlt,
      mapped_by_index: mappedByIndex,
      unresolved_count: Math.max(0, uniqueSourceCount - mappedCount),
    },
  };
}

function mediaInputsFromVariantRows(rows: any[], productTitle = '') {
  const inputs = [];
  const seen = new Set<string>();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (row.mediaId) continue;
    const mediaSrc = Array.isArray(row.mediaSrc) ? row.mediaSrc : [];
    for (const sourceUrl of mediaSrc) {
      const originalSource = mediaSourceKey(sourceUrl);
      if (!/^https:\/\//i.test(originalSource) || seen.has(originalSource)) continue;
      seen.add(originalSource);
      inputs.push({
        originalSource,
        mediaContentType: 'IMAGE',
        alt: norm(row.alt || row.sku || productTitle || 'Product image').slice(0, 512),
      });
    }
  }
  return inputs.slice(0, 10);
}

function variantsFrom(body: any, mediaIdBySource: any) {
  const mediaMap = mediaIdBySource || {};
  const variants = Array.isArray(body.variants) ? body.variants : [];
  return variants.map((variant: any) => {
    const price = norm(variant.price);
    const sku = norm(variant.sku);
    const optionValues = Array.isArray(variant.optionValues) && variant.optionValues.length
      ? variant.optionValues
      : [{ optionName: 'Title', name: 'Default Title' }];
    const out: Record<string, unknown> = {
      optionValues,
      inventoryItem: { sku, tracked: variant.tracked === true },
    };
    if (price) out.price = price;
    const mediaSrc = variantMediaSrcs(variant);
    const mediaId = norm(variant.mediaId || variant.media_id) || firstMappedMediaId(mediaSrc, mediaMap);
    if (mediaId) out.mediaId = mediaId;
    else if (mediaSrc.length) out.mediaSrc = mediaSrc;
    if (variant.compareAtPrice) out.compareAtPrice = norm(variant.compareAtPrice);
    if (variant.inventoryPolicy) out.inventoryPolicy = norm(variant.inventoryPolicy).toUpperCase();
    return out;
  }).filter((variant: any) => norm(variant.inventoryItem?.sku));
}

function normalizeVariantMediaRows(rows: any) {
  const valid = [];
  const invalid = [];
  for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const sku = norm(row?.sku || row?.external_sku);
    const variantId = shopifyVariantGid(row?.variant_id || row?.variantId || row?.external_variant_id || row?.externalVariantId);
    const rawMedia = Array.isArray(row?.mediaSrc)
      ? row.mediaSrc
      : [row?.mediaSrc || row?.image || row?.imageUrl || row?.option_image_url || row?.optionImageUrl];
    const mediaSrc = rawMedia.map((url: any) => norm(url)).filter((url: string) => /^https:\/\//i.test(url)).slice(0, 10);
    const mediaId = norm(row?.mediaId || row?.media_id);
    const alt = norm(row?.alt || row?.mediaAlt || row?.title).slice(0, 512);
    const errors = [];
    if (!sku && !variantId) errors.push('sku_or_variant_id_required');
    if (!mediaId && !mediaSrc.length) errors.push('media_id_or_media_src_required');
    if (errors.length) invalid.push({ index, sku: sku || null, variant_id: variantId || null, errors });
    else valid.push({ index, sku, variantId, mediaSrc, mediaId, alt });
  }
  return { valid, invalid };
}

function resolveRepairVariantTargets(shopifyVariants, rows) {
  const repairVariants = [];
  const missing = [];
  const duplicates = [];
  for (const row of rows) {
    let target = row.variantId
      ? shopifyVariants.find((variant: any) => norm(variant?.id) === row.variantId)
      : null;
    if (!target && row.sku) {
      const exactSkuMatches = shopifyVariants.filter((variant: any) => norm(variant?.sku) === row.sku || norm(variant?.inventoryItem?.sku) === row.sku);
      if (exactSkuMatches.length > 1) {
        duplicates.push({
          index: row.index,
          sku: row.sku,
          product_ids: [...new Set(exactSkuMatches.map((variant: any) => variant?.product?.id).filter(Boolean))],
          variant_ids: exactSkuMatches.map((variant: any) => variant?.id).filter(Boolean),
        });
        continue;
      }
      target = exactSkuMatches[0] || null;
    }
    if (!target) {
      missing.push({ index: row.index, sku: row.sku || null, variant_id: row.variantId || null, media_id: row.mediaId || null, mediaSrc: row.mediaSrc });
      continue;
    }
    if (row.mediaId) repairVariants.push({ id: target.id, mediaId: row.mediaId });
    else repairVariants.push({ id: target.id, mediaSrc: row.mediaSrc });
  }
  return { repairVariants, missing, duplicates };
}

function shopifyPublicImageUrl(value: unknown): string {
  const url = norm(value);
  if (!/^https:\/\//i.test(url) || /\s/.test(url)) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !!parsed.hostname ? url : '';
  } catch {
    return '';
  }
}

function shopifyImageCandidatesFrom(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

function shopifyExistingVariantImageUrlFrom(row: Record<string, unknown>): string {
  const observed = row.observed && typeof row.observed === 'object' ? row.observed : {};
  for (const value of [
    row.shopee_option_image_url,
    row._custom_option_image_url,
    row._main_image,
    row.main_image,
    row._wms_image_url,
    row.image_url,
    row.ebay_variation_image_url,
    ...shopifyImageCandidatesFrom(row.extra_images),
    ...shopifyImageCandidatesFrom(row._extra_images),
    ...shopifyImageCandidatesFrom(row._detail_image_urls),
    ...shopifyImageCandidatesFrom((observed as any).detail_image_urls),
  ]) {
    const url = shopifyPublicImageUrl(value);
    if (url) return url;
  }
  return '';
}

function shopifyHtmlEscape(value: unknown): string {
  return norm(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch] || ch));
}

function shopifyTextDescriptionFrom(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => shopifyHtmlEscape(line))
    .join('<br>');
}

function shopifySplitTopLevelComponents(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  for (const ch of String(value || '')) {
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
  const normalized = String(components ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(div|p|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+\|\s+/g, '\n');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const segment of normalized.split(/\n+/)) {
    for (const piece of shopifySplitTopLevelComponents(segment)) {
      const value = piece
        .replace(/^[\s\-*]+/, '')
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

function shopifyDetailImageUrlsFrom(row: Record<string, unknown>, groupRows: Record<string, unknown>[] = []): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const sourceRow of [row, ...groupRows]) {
    const observed = sourceRow.observed && typeof sourceRow.observed === 'object' ? sourceRow.observed : {};
    for (const value of [
      ...shopifyImageCandidatesFrom(sourceRow._detail_image_urls),
      ...shopifyImageCandidatesFrom(sourceRow.detail_image_urls),
      ...shopifyImageCandidatesFrom((observed as any).detail_image_urls),
      ...shopifyImageCandidatesFrom(sourceRow._extra_images),
      ...shopifyImageCandidatesFrom(sourceRow.extra_images),
    ]) {
      const url = shopifyPublicImageUrl(value);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  return urls.slice(0, 20);
}

function shopifyDetailImagesHtmlFrom(row: Record<string, unknown>, groupRows: Record<string, unknown>[] = [], maxLength = 1800): string {
  const urls = shopifyDetailImageUrlsFrom(row, groupRows);
  if (!urls.length) return '';
  const baseAlt = (norm(row.product_name || row.sku) || 'Product').slice(0, 120);
  let html = '<h3>Detail Images</h3>\n';
  let added = 0;
  urls.forEach((url, index) => {
    const imageHtml = `<img src="${shopifyHtmlEscape(url)}" alt="${shopifyHtmlEscape(`${baseAlt} detail ${index + 1}`)}" style="max-width:100%;height:auto;">`;
    const prefix = added ? '<br>\n' : '';
    if (added && html.length + prefix.length + imageHtml.length > maxLength) return;
    html += `${prefix}${imageHtml}`;
    added += 1;
  });
  return added ? html : '';
}

function lifecycleOfProduct(row: Record<string, unknown>): string {
  return norm(row.lifecycle_state || row.lifecycle || '').toLowerCase();
}

function stripLifecycleTags(value: unknown): string {
  return norm(value).replace(/\[(?:READY STOCK|PRE[-\s]?ORDER|예약|재고)\]\s*/gi, '').trim();
}

function shopifyExistingDescriptionHtmlFrom(master: Record<string, unknown>, groupRows: Record<string, unknown>[] = []): string {
  const componentLines = shopifyComponentLines(
    master.components_extracted_en || master.components_en || master.components || master.included_components,
  );
  const lifecycle = lifecycleOfProduct(master);
  const stockLine = lifecycle === 'ready_stock'
    ? 'Ready stock ships in about 1 business day, excluding weekends and Korean holidays.'
    : 'Pre-order ships after official release and warehouse arrival; distributor delays may change the schedule.';
  const productTitle = stripLifecycleTags(master.product_name) || norm(master.sku) || 'K-pop item';
  const componentText = (componentLines.length
    ? componentLines
    : ['Each option includes 1 album. Random inclusions follow the official manufacturer policy.'])
    .map((line) => `- ${line}`)
    .join('\n');
  const textSections = [
    `<p>${shopifyTextDescriptionFrom(`Hello, K-pop collector.\nOfficial K-pop goods from Korea, packed carefully.\n${productTitle}`)}</p>`,
    '<h3>Product Details</h3>',
    `<p>${shopifyTextDescriptionFrom(`Product: ${productTitle}\nAvailability: ${stockLine}\nComponents:\n${componentText}`)}</p>`,
    '<h3>Shipping & Handling</h3>',
    `<p>${shopifyTextDescriptionFrom([
      "Ships only to the buyer's Shopify checkout address. Confirm name, address, and phone before payment.",
      'Tracking uploads after dispatch; the first scan may take 24-48 hours.',
      'International delivery estimates exclude handling, weekends, holidays, customs, and local delays.',
      'Local duties, VAT, GST, brokerage, or handling charges may be collected by the carrier unless Shopify collects them at checkout.',
    ].join('\n'))}</p>`,
    '<h3>Important Notice</h3>',
    `<p>${shopifyTextDescriptionFrom([
      'Outer packaging may have small marks from production or shipping.',
      'Random inclusions cannot be selected unless the option title says so.',
      'Returns follow store policy; items must be unused, unopened, and complete.',
    ].join('\n'))}</p>`,
  ];
  const textHtml = textSections.filter(Boolean).join('\n');
  const imageHtml = shopifyDetailImagesHtmlFrom(master, groupRows);
  if (!imageHtml) return textHtml.slice(0, 4000);
  const maxTextLength = Math.max(0, 4000 - imageHtml.length - 1);
  const cappedTextHtml = textHtml.length > maxTextLength ? textHtml.slice(0, maxTextLength).trimEnd() : textHtml;
  return [cappedTextHtml, imageHtml].filter(Boolean).join('\n');
}

async function handleHealthz(): Promise<Response> {
  return jsonResp({
    ok: true,
    service: 'shopify-bridge',
    version: 1,
    api_version: SHOPIFY_API_VERSION,
    client_configured: Boolean(SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET),
    redirect_uri_configured: Boolean(SHOPIFY_REDIRECT_URI),
    supabase_configured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
  });
}

async function handleOAuthUrl(req: Request): Promise<Response> {
  const denied = await requireBridgeTokenOrAuthenticatedUser(req);
  if (denied) return denied;
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_REDIRECT_URI) return jsonResp({ ok: false, error: 'shopify_oauth_env_missing' }, 500);
  const url = new URL(req.url);
  const shopDomain = normalizeShopDomain(url.searchParams.get('shop'));
  if (!shopDomain) return jsonResp({ ok: false, error: 'shop parameter must be a *.myshopify.com domain' }, 400);
  const state = crypto.randomUUID();
  const auth = await requireAuthenticatedUser(req);
  const actorId = auth?.user?.id || null;
  await supabase.from('shopify_oauth_states').insert({
    state,
    shop_domain: shopDomain,
    actor_id: actorId,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  const oauth = new URL(`https://${shopDomain}/admin/oauth/authorize`);
  oauth.searchParams.set('client_id', SHOPIFY_CLIENT_ID);
  oauth.searchParams.set('scope', SHOPIFY_SCOPES);
  oauth.searchParams.set('redirect_uri', SHOPIFY_REDIRECT_URI);
  oauth.searchParams.set('state', state);
  return jsonResp({ ok: true, shop_domain: shopDomain, state, url: oauth.toString(), scopes: SHOPIFY_SCOPES.split(',') });
}

async function exchangeOAuthCode(shopDomain: string, code: string) {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code }),
  });
  const raw = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return { status: res.status, raw };
}

async function readShopDefaults(shop: any) {
  const query = `
    query ShopifyBridgeShopDefaults {
      shop { name myshopifyDomain currencyCode }
      locations(first: 10) { nodes { id name isActive } }
      publications(first: 10) { nodes { id name } }
    }
  `;
  const { raw } = await shopifyGraphql(shop, query, {});
  const activeLocation = (raw?.data?.locations?.nodes || []).find((row: any) => row?.isActive) || raw?.data?.locations?.nodes?.[0] || null;
  const publication = raw?.data?.publications?.nodes?.[0] || null;
  return {
    shop_name: raw?.data?.shop?.name || null,
    currency: raw?.data?.shop?.currencyCode || null,
    default_location_gid: activeLocation?.id || null,
    default_publication_gid: publication?.id || null,
    raw,
  };
}

async function handleOAuthCallback(req: Request): Promise<Response> {
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) return jsonResp({ ok: false, error: 'shopify_oauth_env_missing' }, 500);
  const url = new URL(req.url);
  const shopDomain = normalizeShopDomain(url.searchParams.get('shop'));
  const code = norm(url.searchParams.get('code'));
  const state = norm(url.searchParams.get('state'));
  if (!shopDomain || !code || !state) return jsonResp({ ok: false, error: 'shop, code and state are required' }, 400);
  if (!(await verifyShopifyOAuthHmac(url))) return jsonResp({ ok: false, error: 'shopify_hmac_invalid' }, 401);

  const { data: stateRow } = await supabase
    .from('shopify_oauth_states')
    .select('state,shop_domain,expires_at,used_at')
    .eq('state', state)
    .maybeSingle();
  if (!stateRow || stateRow.used_at || stateRow.shop_domain !== shopDomain || new Date(stateRow.expires_at).getTime() < Date.now()) {
    return jsonResp({ ok: false, error: 'shopify_oauth_state_invalid' }, 401);
  }

  const exchanged = await exchangeOAuthCode(shopDomain, code);
  if (exchanged.status < 200 || exchanged.status >= 300 || !exchanged.raw?.access_token) {
    return jsonResp({ ok: false, error: 'shopify_oauth_exchange_failed', status: exchanged.status, raw: exchanged.raw }, 502);
  }

  const scopes = uniq(norm(exchanged.raw.scope).split(','));
  const scopeSet = new Set(scopes);
  const canCreateProducts = scopeSet.has('write_products');
  const canSyncProducts = scopeSet.has('read_products') || canCreateProducts;
  const productAuthVerified = canCreateProducts && canSyncProducts;
  const tempShop = { shop_domain: shopDomain, access_token: exchanged.raw.access_token };
  const defaults = await readShopDefaults(tempShop);
  await supabase.from('shopify_shops').upsert({
    shop_domain: shopDomain,
    shop_name: defaults.shop_name,
    access_token: exchanged.raw.access_token,
    scopes,
    default_location_gid: defaults.default_location_gid,
    default_publication_gid: defaults.default_publication_gid,
    currency: defaults.currency,
    status: 'active',
    auth_verified: productAuthVerified,
    last_verified_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'shop_domain' });
  await supabase
    .from('platform_capabilities')
    .update({ auth_verified: canCreateProducts, updated_at: new Date().toISOString() })
    .eq('platform', 'shopify')
    .eq('capability', 'create_listing');
  await supabase
    .from('platform_capabilities')
    .update({ auth_verified: canSyncProducts, updated_at: new Date().toISOString() })
    .eq('platform', 'shopify')
    .eq('capability', 'sync');
  await supabase.from('shopify_oauth_states').update({ used_at: new Date().toISOString() }).eq('state', state);

  return jsonResp({
    ok: true,
    shop_domain: shopDomain,
    shop_name: defaults.shop_name,
    scopes,
    currency: defaults.currency,
    default_location_gid: defaults.default_location_gid,
    default_publication_gid: defaults.default_publication_gid,
    product_auth_verified: productAuthVerified,
    missing_scopes: ['write_products', 'read_products', 'write_inventory', 'write_shipping'].filter((scope) => !scopeSet.has(scope)),
  });
}

async function handleShop(req: Request): Promise<Response> {
  const denied = await requireBridgeTokenOrAuthenticatedUser(req);
  if (denied) return denied;
  const shopDomain = normalizeShopDomain(new URL(req.url).searchParams.get('shop'));
  const shop = await configuredShop(shopDomain);
  return jsonResp({
    ok: true,
    shop: {
      shop_domain: shop.shop_domain,
      shop_name: shop.shop_name,
      scopes: shop.scopes,
      default_location_gid: shop.default_location_gid,
      default_publication_gid: shop.default_publication_gid,
      currency: shop.currency,
      status: shop.status,
      auth_verified: shop.auth_verified,
      shipping_auth_verified: shopScopeSet(shop).has('write_shipping'),
      carrier_callback_url: SHOPIFY_CARRIER_CALLBACK_URL,
    },
  });
}

async function handleCarrierService(req: Request): Promise<Response> {
  const denied = await requireBridgeTokenOrAuthenticatedUser(req);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const shopDomain = normalizeShopDomain(body?.shop_domain);
  const shop = await configuredShop(shopDomain);
  const scopes = shopScopeSet(shop);
  if (!scopes.has('write_shipping')) {
    return jsonResp({
      ok: false,
      error: 'shopify_write_shipping_scope_missing',
      missing_scopes: ['write_shipping'],
      current_scopes: [...scopes],
      reauth_required: true,
    }, 409);
  }

  const callbackUrl = norm(body?.callbackUrl || body?.callback_url || SHOPIFY_CARRIER_CALLBACK_URL);
  if (!/^https:\/\//i.test(callbackUrl)) {
    return jsonResp({ ok: false, error: 'shopify_carrier_callback_url_required' }, 400);
  }

  const input = {
    name: norm(body?.name || 'starphotocard weight-based shipping'),
    callbackUrl,
    supportsServiceDiscovery: body?.supportsServiceDiscovery !== false && body?.supports_service_discovery !== false,
    active: body?.active !== false,
  };

  if (body?.dry_run !== false) {
    return jsonResp({
      ok: true,
      dry_run: true,
      shop_domain: shop.shop_domain,
      required_scopes: ['write_shipping'],
      input,
    });
  }

  const query = `
    mutation ShopifyBridgeCarrierServiceCreate($input: DeliveryCarrierServiceCreateInput!) {
      carrierServiceCreate(input: $input) {
        carrierService {
          id
          name
          callbackUrl
          active
          supportsServiceDiscovery
        }
        userErrors { field message }
      }
    }
  `;
  const { status, raw } = await shopifyGraphql(shop, query, { input });
  if (status < 200 || status >= 300 || raw?.errors?.length || graphUserErrors(raw, 'carrierServiceCreate').length) {
    return jsonResp({ ok: false, error: graphErrorMessage(raw, 'carrierServiceCreate'), raw }, status || 502);
  }
  return jsonResp({
    ok: true,
    shop_domain: shop.shop_domain,
    carrier_service: raw?.data?.carrierServiceCreate?.carrierService || null,
    raw,
  });
}

async function createProduct(shop: any, body: any) {
  const product = body.product || {};
  const title = norm(product.title);
  if (!title) return { ok: false, status: 400, raw: { error: 'title required' } };
  const productInput: Record<string, unknown> = {
    title,
    status: shopifyProductStatus(product.status),
  };
  if (norm(product.descriptionHtml)) productInput.descriptionHtml = norm(product.descriptionHtml);
  if (norm(product.vendor)) productInput.vendor = norm(product.vendor);
  if (norm(product.productType)) productInput.productType = norm(product.productType);
  if (Array.isArray(product.tags) && product.tags.length) productInput.tags = uniq(product.tags).slice(0, 50);
  const productOptions = productOptionsFrom(body);
  if (productOptions.length) productInput.productOptions = productOptions;

  const query = `
    mutation ShopifyBridgeProductCreate($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product { id title status handle publishedAt }
        userErrors { field message }
      }
    }
  `;
  const { status, raw } = await shopifyGraphql(shop, query, { product: productInput });
  if (status < 200 || status >= 300 || raw?.errors?.length || graphUserErrors(raw, 'productCreate').length) {
    return { ok: false, status, raw, error: graphErrorMessage(raw, 'productCreate') };
  }
  return { ok: true, status, raw, product: raw?.data?.productCreate?.product };
}

async function createProductMedia(shop: any, productId: string, media: any[]) {
  const inputs = Array.isArray(media) ? media : [];
  if (!inputs.length) {
    return {
      ok: true,
      status: 200,
      raw: { skipped: true },
      product: null,
      media: [],
      product_media_created: { requested_count: 0, created_count: 0 },
    };
  }
  const query = `
    mutation ShopifyBridgeProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(media: $media, productId: $productId) {
        media {
          id
          alt
          mediaContentType
          status
          preview { status }
        }
        mediaUserErrors { field message }
        userErrors { field message }
        product { id title status handle publishedAt }
      }
    }
  `;
  const { status, raw } = await shopifyGraphql(shop, query, { productId, media: inputs });
  if (status < 200 || status >= 300 || raw?.errors?.length || graphUserErrors(raw, 'productCreateMedia').length) {
    return { ok: false, status, raw, error: graphErrorMessage(raw, 'productCreateMedia') };
  }
  const createdMedia = raw?.data?.productCreateMedia?.media || [];
  return {
    ok: true,
    status,
    raw,
    product: raw?.data?.productCreateMedia?.product || null,
    media: createdMedia,
    product_media_created: {
      requested_count: inputs.length,
      created_count: Array.isArray(createdMedia) ? createdMedia.filter((node: any) => norm(node?.id)).length : 0,
    },
  };
}

function variantMediaCounts(variants: any[]): number[] {
  return (Array.isArray(variants) ? variants : []).map((variant: any) => {
    const nodes = variant?.media?.nodes;
    return Array.isArray(nodes) ? nodes.length : 0;
  });
}

function applyMediaIdsToRepairVariants(repairVariants: any[], mediaIdBySource: Record<string, string> = {}) {
  let mediaIdCount = 0;
  let mediaSrcFallbackCount = 0;
  const variants = (Array.isArray(repairVariants) ? repairVariants : []).map((row: any) => {
    if (row.mediaId) {
      mediaIdCount += 1;
      return { id: row.id, mediaId: row.mediaId };
    }
    const mediaSrc = Array.isArray(row.mediaSrc) ? row.mediaSrc : [];
    const mediaId = firstMappedMediaId(mediaSrc, mediaIdBySource);
    if (mediaId) {
      mediaIdCount += 1;
      return { id: row.id, mediaId };
    }
    mediaSrcFallbackCount += mediaSrc.length ? 1 : 0;
    return { id: row.id, mediaSrc };
  });
  return {
    variants,
    diagnostics: {
      media_id_count: mediaIdCount,
      media_src_fallback_count: mediaSrcFallbackCount,
    },
  };
}

async function createVariants(shop: any, productId: string, body: any, mediaIdBySource: Record<string, string> = {}) {
  const variants = variantsFrom(body, mediaIdBySource);
  if (!variants.length) return { ok: true, status: 200, raw: { skipped: true }, variants: [] };
  const query = `
    mutation ShopifyBridgeProductVariantsBulkCreate(
      $productId: ID!,
      $variants: [ProductVariantsBulkInput!]!,
      $strategy: ProductVariantsBulkCreateStrategy
    ) {
      productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
        product { id title status publishedAt }
        productVariants {
          id
          title
          sku
          price
          selectedOptions { name value }
          inventoryItem { id sku tracked }
          media(first: 10) {
            nodes {
              id
              alt
              mediaContentType
              preview { status }
            }
          }
        }
        userErrors { field message code }
      }
    }
  `;
  const variables = { productId, variants, strategy: 'REMOVE_STANDALONE_VARIANT' };
  const { status, raw } = await shopifyGraphql(shop, query, variables);
  if (status < 200 || status >= 300 || raw?.errors?.length || graphUserErrors(raw, 'productVariantsBulkCreate').length) {
    return { ok: false, status, raw, error: graphErrorMessage(raw, 'productVariantsBulkCreate') };
  }
  return {
    ok: true,
    status,
    raw,
    variants: raw?.data?.productVariantsBulkCreate?.productVariants || [],
    product: raw?.data?.productVariantsBulkCreate?.product || null,
  };
}

async function inventorySetQuantities(shop: any, quantities: any[], reason = 'correction') {
  const query = `
    mutation ShopifyBridgeInventorySetQuantities($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { createdAt reason }
        userErrors { field message code }
      }
    }
  `;
  return shopifyGraphql(shop, query, { input: { name: 'available', reason, quantities } });
}

async function publishablePublish(shop: any, productId: string, publicationId: string) {
  const query = `
    mutation ShopifyBridgePublishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable { ... on Product { id title status publishedAt } }
        userErrors { field message code }
      }
    }
  `;
  return shopifyGraphql(shop, query, { id: productId, input: [{ publicationId }] });
}

async function archiveProduct(shop: any, productId: string) {
  const id = norm(productId);
  if (!id) return { ok: false, status: 400, raw: { error: 'product_id required' }, error: 'product_id required' };
  const query = `
    mutation ShopifyBridgeProductArchive($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product { id title status handle publishedAt }
        userErrors { field message }
      }
    }
  `;
  const { status, raw } = await shopifyGraphql(shop, query, { product: { id, status: 'ARCHIVED' } });
  if (status < 200 || status >= 300 || raw?.errors?.length || graphUserErrors(raw, 'productUpdate').length) {
    return { ok: false, status, raw, error: graphErrorMessage(raw, 'productUpdate') };
  }
  return { ok: true, status, raw, product: raw?.data?.productUpdate?.product || null };
}

async function updateProductDescriptionHtml(shop: any, productId: string, descriptionHtml: string) {
  const id = shopifyProductGid(productId);
  const html = String(descriptionHtml ?? '');
  if (!id) return { ok: false, status: 400, raw: { error: 'product_id required' }, error: 'product_id required' };
  if (!html.trim()) return { ok: false, status: 400, raw: { error: 'descriptionHtml required' }, error: 'descriptionHtml required' };
  const query = `
    mutation ShopifyBridgeProductDescriptionUpdate($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product { id title status handle publishedAt descriptionHtml }
        userErrors { field message }
      }
    }
  `;
  const { status, raw } = await shopifyGraphql(shop, query, { product: { id, descriptionHtml: html } });
  if (status < 200 || status >= 300 || raw?.errors?.length || graphUserErrors(raw, 'productUpdate').length) {
    return { ok: false, status, raw, error: graphErrorMessage(raw, 'productUpdate') };
  }
  return { ok: true, status, raw, product: raw?.data?.productUpdate?.product || null };
}

async function readProductSkuTargets(shop: any, productId: string) {
  const query = `
    query ShopifyBridgeProductSkuTargets($id: ID!) {
      product(id: $id) {
        id
        title
        status
        handle
        publishedAt
        variants(first: 100) {
          nodes {
            id
            title
            sku
            price
            selectedOptions { name value }
            inventoryItem { id sku tracked }
          }
        }
      }
    }
  `;
  const { status, raw } = await shopifyGraphql(shop, query, { id: productId });
  if (status < 200 || status >= 300 || raw?.errors?.length) {
    return { ok: false, status, raw, error: graphErrorMessage(raw) };
  }
  const product = raw?.data?.product || null;
  if (!product?.id) return { ok: false, status: 404, raw, error: 'product_not_found' };
  return { ok: true, status, raw, product, variants: product?.variants?.nodes || [] };
}

function summarizeSkuVariant(variant: any): Record<string, unknown> {
  return {
    variant_id: variant?.id || null,
    title: variant?.title || null,
    sku: norm(variant?.sku || variant?.inventoryItem?.sku) || null,
    variant_sku: norm(variant?.sku) || null,
    inventory_item_id: variant?.inventoryItem?.id || null,
    inventory_item_sku: norm(variant?.inventoryItem?.sku) || null,
    selected_options: variant?.selectedOptions || [],
  };
}

async function updateInventoryItemSku(shop: any, inventoryItemId: string, sku: string) {
  const query = `
    mutation ShopifyBridgeInventoryItemSkuUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem {
          id
          sku
          tracked
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const { status, raw } = await shopifyGraphql(shop, query, { id: inventoryItemId, input: { sku } });
  if (status < 200 || status >= 300 || raw?.errors?.length || graphUserErrors(raw, 'inventoryItemUpdate').length) {
    return { ok: false, status, raw, error: graphErrorMessage(raw, 'inventoryItemUpdate') };
  }
  return { ok: true, status, raw, inventoryItem: raw?.data?.inventoryItemUpdate?.inventoryItem || null };
}

async function bulkUpdateVariantInventoryItemSku(shop: any, productId: string, variantId: string, sku: string) {
  const query = `
    mutation ShopifyBridgeVariantSkuUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        product {
          id
          title
          status
          handle
          publishedAt
        }
        productVariants {
          id
          title
          sku
          price
          selectedOptions { name value }
          inventoryItem { id sku tracked }
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;
  const variables = { productId, variants: [{ id: variantId, inventoryItem: { sku } }] };
  const { status, raw } = await shopifyGraphql(shop, query, variables);
  if (status < 200 || status >= 300 || raw?.errors?.length || graphUserErrors(raw, 'productVariantsBulkUpdate').length) {
    return { ok: false, status, raw, error: graphErrorMessage(raw, 'productVariantsBulkUpdate') };
  }
  const variant = raw?.data?.productVariantsBulkUpdate?.productVariants?.[0] || null;
  return {
    ok: true,
    status,
    raw,
    product: raw?.data?.productVariantsBulkUpdate?.product || null,
    variant,
    inventoryItem: variant?.inventoryItem || null,
  };
}

async function bulkRepairVariantMedia(shop: any, productId: string, variants: Record<string, unknown>[]) {
  const query = `
    mutation ShopifyBridgeVariantMediaRepair($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        product {
          id
          title
          status
          handle
          publishedAt
        }
        productVariants {
          id
          title
          sku
          price
          selectedOptions { name value }
          inventoryItem { id sku tracked }
          media(first: 10) {
            nodes {
              id
              alt
              mediaContentType
              preview { status }
            }
          }
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;
  const { status, raw } = await shopifyGraphql(shop, query, { productId, variants });
  if (status < 200 || status >= 300 || raw?.errors?.length || graphUserErrors(raw, 'productVariantsBulkUpdate').length) {
    return { ok: false, status, raw, error: graphErrorMessage(raw, 'productVariantsBulkUpdate') };
  }
  return {
    ok: true,
    status,
    raw,
    product: raw?.data?.productVariantsBulkUpdate?.product || null,
    variants: raw?.data?.productVariantsBulkUpdate?.productVariants || [],
  };
}

async function handleArchiveProduct(req: Request): Promise<Response> {
  const denied = await requireBridgeTokenOrAuthenticatedUser(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return jsonResp({ ok: false, error: 'JSON body required' }, 400);
  const shopDomain = normalizeShopDomain(body.shop_domain);
  const shop = await configuredShop(shopDomain);
  const productId = norm(body.product_id || body.productId || body.platform_item_id);
  if (!productId) return jsonResp({ ok: false, error: 'product_id required' }, 400);
  if (body.dry_run === true) {
    return jsonResp({
      ok: true,
      dry_run: true,
      shop_domain: shop.shop_domain,
      cleanup_action: 'archive_product',
      payload: { productUpdate: { product: { id: productId, status: 'ARCHIVED' } } },
    });
  }
  const archived = await archiveProduct(shop, productId);
  if (!archived.ok) return jsonResp({ ok: false, error: archived.error || 'productUpdate archive failed', raw: archived.raw }, archived.status || 502);
  return jsonResp({
    ok: true,
    shop_domain: shop.shop_domain,
    cleanup_action: 'archive_product',
    product_id: productId,
    product: archived.product,
    raw: archived.raw,
  });
}

async function handleCreateProduct(req: Request): Promise<Response> {
  const denied = await requireBridgeTokenOrAuthenticatedUser(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return jsonResp({ ok: false, error: 'JSON body required' }, 400);
  const shopDomain = normalizeShopDomain(body.shop_domain);
  const shop = await configuredShop(shopDomain);
  const media = mediaFrom(body);
  const variants = variantsFrom(body);
  if (!variants.length) return jsonResp({ ok: false, error: 'variants[] with sku is required' }, 400);

  const dryRun = body.dry_run === true;
  const dryRunPayload = {
    productCreate: {
      product: {
        ...(body.product || {}),
        status: shopifyProductStatus(body.product?.status),
        productOptions: productOptionsFrom(body),
      },
    },
    productCreateMedia: {
      media,
    },
    productVariantsBulkCreate: {
      variants,
      strategy: 'REMOVE_STANDALONE_VARIANT',
    },
  };
  if (dryRun) {
    return jsonResp({
      ok: true,
      dry_run: true,
      shop_domain: shop.shop_domain,
      payload: dryRunPayload,
      mutations: ['productCreate', 'productCreateMedia', 'productVariantsBulkCreate'],
      product_media_created: { requested_count: media.length, created_count: 0 },
      media_id_mapping: { requested_count: media.length, unique_source_count: new Set(media.map((row: any) => mediaSourceKey(row.originalSource)).filter(Boolean)).size, created_count: 0, mapped_count: 0, mapped_by_alt: 0, mapped_by_index: 0, unresolved_count: media.length },
    });
  }

  const created = await createProduct(shop, body);
  if (!created.ok || !created.product?.id) {
    return jsonResp({ ok: false, error: created.error || 'productCreate failed', raw: created.raw }, created.status || 502);
  }

  const productMedia = await createProductMedia(shop, created.product.id, media);
  if (!productMedia.ok) {
    let cleanup = { attempted: false, archived: false, product: null, error: null, raw: null };
    if (body.cleanup_on_variant_failure !== false) {
      const archived = await archiveProduct(shop, created.product.id);
      cleanup = {
        attempted: true,
        archived: archived.ok === true,
        product: archived.product || null,
        error: archived.ok ? null : (archived.error || 'productUpdate archive failed'),
        raw: archived.raw || null,
      };
    }
    return jsonResp({
      ok: false,
      error: productMedia.error || 'productCreateMedia failed',
      product_id: created.product.id,
      cleanup_action: 'archive_product',
      cleanup,
      product_media_created: productMedia.product_media_created || { requested_count: media.length, created_count: 0 },
      raw: productMedia.raw,
    }, productMedia.status || 502);
  }
  const mediaMapping = mediaIdMappingFrom(media, productMedia.media);
  const variantResult = await createVariants(shop, created.product.id, body, mediaMapping.sourceToMediaId);
  if (!variantResult.ok) {
    let cleanup = { attempted: false, archived: false, product: null, error: null, raw: null };
    if (body.cleanup_on_variant_failure !== false) {
      const archived = await archiveProduct(shop, created.product.id);
      cleanup = {
        attempted: true,
        archived: archived.ok === true,
        product: archived.product || null,
        error: archived.ok ? null : (archived.error || 'productUpdate archive failed'),
        raw: archived.raw || null,
      };
    }
    return jsonResp({
      ok: false,
      error: variantResult.error || 'productVariantsBulkCreate failed',
      product_id: created.product.id,
      cleanup_action: 'archive_product',
      cleanup,
      product_media_created: productMedia.product_media_created,
      media_id_mapping: mediaMapping.diagnostics,
      raw: variantResult.raw,
    }, variantResult.status || 502);
  }

  let inventoryResult = null;
  if (body.set_inventory === true) {
    const locationId = norm(body.default_location_gid || shop.default_location_gid);
    const quantities = variants
      .map((requested: any) => {
        const createdVariant = (variantResult.variants || []).find((row: any) => norm(row?.sku) === norm(requested.inventoryItem?.sku));
        const inventoryItemId = createdVariant?.inventoryItem?.id;
        if (!inventoryItemId || !locationId || requested.quantity == null) return null;
        return { inventoryItemId, locationId, quantity: Math.max(0, Math.floor(Number(requested.quantity) || 0)) };
      })
      .filter(Boolean);
    if (quantities.length) inventoryResult = await inventorySetQuantities(shop, quantities, 'correction');
  }

  let publishResult = null;
  if (body.publish === true) {
    const publicationId = norm(body.default_publication_gid || shop.default_publication_gid);
    if (publicationId) publishResult = await publishablePublish(shop, created.product.id, publicationId);
  }

  const product = variantResult.product || created.product;
  return jsonResp({
    ok: true,
    shop_domain: shop.shop_domain,
    product_id: created.product.id,
    platform_item_id: created.product.id,
    listing_status: mapShopifyListingStatus(product),
    product,
    variants: variantResult.variants,
    variant_id: variantResult.variants?.[0]?.id || null,
    product_media_created: productMedia.product_media_created,
    media_id_mapping: mediaMapping.diagnostics,
    variant_media_counts: variantMediaCounts(variantResult.variants),
    inventory_result: inventoryResult?.raw || null,
    publish_result: publishResult?.raw || null,
    throttle_status: variantResult.raw?.extensions?.cost?.throttleStatus || created.raw?.extensions?.cost?.throttleStatus || null,
  });
}

async function handleSetSku(req: Request): Promise<Response> {
  const denied = await requireBridgeTokenOrAuthenticatedUser(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return jsonResp({ ok: false, error: 'JSON body required' }, 400);

  const sku = norm(body.sku);
  if (!sku) return jsonResp({ ok: false, error: 'sku required' }, 400);
  const productId = shopifyProductGid(body.product_id || body.productId || body.platform_item_id || body.platformItemId);
  if (!productId) return jsonResp({ ok: false, error: 'valid Shopify product_id required' }, 400);

  const shopDomain = normalizeShopDomain(body.shop_domain || body.shop);
  const shop = await configuredShop(shopDomain);
  const scopeSet = shopScopeSet(shop);
  const canInventoryItemUpdate = scopeSet.has('write_inventory');
  const canVariantBulkUpdate = scopeSet.has('write_products');
  if (!canInventoryItemUpdate && !canVariantBulkUpdate) {
    return jsonResp({
      ok: false,
      error: 'missing_scopes',
      missing_scopes: ['write_inventory', 'write_products'],
      message: 'Shopify SKU repair requires write_inventory or write_products scope',
      shop_domain: shop.shop_domain,
    }, 403);
  }

  const read = await readProductSkuTargets(shop, productId);
  if (!read.ok) return jsonResp({ ok: false, error: read.error || 'product lookup failed', product_id: productId, raw: read.raw }, read.status || 502);
  const product = read.product;
  const variants = Array.isArray(read.variants) ? read.variants : [];
  const requestedVariantId = shopifyVariantGid(body.variant_id || body.variantId || body.external_variant_id || body.externalVariantId);
  let target = requestedVariantId ? variants.find((variant: any) => norm(variant?.id) === requestedVariantId) : null;
  if (requestedVariantId && !target) {
    return jsonResp({
      ok: false,
      error: 'variant_not_found',
      product_id: product.id,
      variant_id: requestedVariantId,
      variants: variants.map(summarizeSkuVariant),
    }, 404);
  }
  if (!target && variants.length === 1) target = variants[0];
  if (!target) {
    const blankSkuVariants = variants.filter((variant: any) => !norm(variant?.sku) && !norm(variant?.inventoryItem?.sku));
    if (blankSkuVariants.length === 1) target = blankSkuVariants[0];
  }
  if (!target) {
    return jsonResp({
      ok: false,
      product_id: product.id,
      variant_count: variants.length,
      error: 'ambiguous_variant',
      message: 'Multiple Shopify variants require an explicit variant_id before SKU repair',
      variants: variants.map(summarizeSkuVariant),
    }, 409);
  }

  const bodyInventoryItemId = shopifyInventoryItemGid(body.inventory_item_id || body.inventoryItemId);
  const targetInventoryItemId = shopifyInventoryItemGid(target?.inventoryItem?.id);
  if (bodyInventoryItemId && targetInventoryItemId && bodyInventoryItemId !== targetInventoryItemId) {
    return jsonResp({
      ok: false,
      error: 'inventory_item_mismatch',
      product_id: product.id,
      variant_id: target.id,
      inventory_item_id: bodyInventoryItemId,
      target_inventory_item_id: targetInventoryItemId,
    }, 409);
  }
  const inventoryItemId = bodyInventoryItemId || targetInventoryItemId;
  if (!inventoryItemId) {
    return jsonResp({
      ok: false,
      error: 'inventory_item_not_found',
      product_id: product.id,
      variant_id: target.id,
    }, 404);
  }

  const escapedSku = shopifySearchString(sku);
  const queryText = `sku:"${escapedSku}"`;
  const duplicateQuery = `
    query ShopifyBridgeProductVariantBySku($query: String!) {
      productVariants(first: 10, query: $query) {
        nodes {
          id
          sku
          inventoryItem { id sku }
          product { id title status handle publishedAt }
        }
      }
    }
  `;
  const duplicateRead = await shopifyGraphql(shop, duplicateQuery, { query: queryText });
  if (duplicateRead.status < 200 || duplicateRead.status >= 300 || duplicateRead.raw?.errors?.length) {
    return jsonResp({ ok: false, error: graphErrorMessage(duplicateRead.raw), raw: duplicateRead.raw }, duplicateRead.status || 502);
  }
  const nodes = duplicateRead.raw?.data?.productVariants?.nodes || [];
  const exactMatches = nodes.filter((node: any) => norm(node?.sku) === sku || norm(node?.inventoryItem?.sku) === sku);
  const conflicts = exactMatches.filter((node: any) => norm(node?.id) !== norm(target?.id) && norm(node?.inventoryItem?.id) !== inventoryItemId);
  if (conflicts.length) {
    return jsonResp({
      ok: false,
      error: 'duplicate_sku',
      message: `Shopify SKU already exists on another variant: ${sku}`,
      sku,
      product_id: product.id,
      variant_id: target.id,
      product_ids: conflicts.map((node: any) => node?.product?.id).filter(Boolean),
      variant_ids: conflicts.map((node: any) => node?.id).filter(Boolean),
      exact_match_count: exactMatches.length,
      raw: duplicateRead.raw,
    }, 409);
  }

  const oldSku = norm(target?.inventoryItem?.sku || target?.sku);
  const responseBase = {
    shop_domain: shop.shop_domain,
    product_id: product.id,
    platform_item_id: product.id,
    variant_id: target.id,
    external_variant_id: target.id,
    inventory_item_id: inventoryItemId,
    old_sku: oldSku || null,
    sku,
    listing_status: mapShopifyListingStatus(product),
    status: product.status || null,
    title: product.title || target.title || null,
    price: target.price || null,
    selected_options: target.selectedOptions || [],
  };

  if (body.dry_run === true) {
    const payload = canInventoryItemUpdate
      ? { inventoryItemUpdate: { id: inventoryItemId, input: { sku } } }
      : { productVariantsBulkUpdate: { productId: product.id, variants: [{ id: target.id, inventoryItem: { sku } }] } };
    return jsonResp({
      ok: true,
      dry_run: true,
      ...responseBase,
      mutation_used: canInventoryItemUpdate ? 'inventoryItemUpdate' : 'productVariantsBulkUpdate',
      target: summarizeSkuVariant(target),
      payload,
    });
  }
  if (oldSku === sku) {
    return jsonResp({
      ok: true,
      idempotent: true,
      ...responseBase,
      raw: { skipped: true, reason: 'sku_already_set' },
    });
  }

  const mutationUsed = canInventoryItemUpdate ? 'inventoryItemUpdate' : 'productVariantsBulkUpdate';
  const updated = canInventoryItemUpdate
    ? await updateInventoryItemSku(shop, inventoryItemId, sku)
    : await bulkUpdateVariantInventoryItemSku(shop, product.id, target.id, sku);
  if (!updated.ok) return jsonResp({ ok: false, error: updated.error || `${mutationUsed} failed`, mutation_used: mutationUsed, raw: updated.raw }, updated.status || 502);
  return jsonResp({
    ok: true,
    ...responseBase,
    sku: updated.inventoryItem?.sku || sku,
    mutation_used: mutationUsed,
    variant: updated.variant || null,
    inventory_item: updated.inventoryItem,
    raw: updated.raw,
  });
}

async function repairOptionImagesForProduct(shop: any, productId: string, requestedRows: any, dryRun = false) {
  const normalized = normalizeVariantMediaRows(requestedRows);
  if (normalized.invalid.length) return { ok: false, status: 400, error: 'invalid_media_rows', invalid: normalized.invalid };
  const rows = normalized.valid;
  if (!rows.length) return { ok: false, status: 400, error: 'variants or option_images with public HTTPS media URL required' };

  const read = await readProductSkuTargets(shop, productId);
  if (!read.ok) return { ok: false, status: read.status || 502, error: read.error || 'product lookup failed', product_id: productId, raw: read.raw };
  const product = read.product;
  const shopifyVariants = Array.isArray(read.variants) ? read.variants : [];
  const variantSummaries = shopifyVariants.map(summarizeSkuVariant);
  const { repairVariants, missing, duplicates } = resolveRepairVariantTargets(shopifyVariants, rows);
  const repairMedia = mediaInputsFromVariantRows(rows, product?.title || '');

  if (duplicates.length) {
    return {
      ok: false,
      status: 409,
      error: 'duplicate_sku',
      shop_domain: shop.shop_domain,
      product_id: product.id,
      duplicates,
      variants: variantSummaries,
    };
  }
  if (missing.length) {
    return {
      ok: false,
      status: 404,
      error: 'variant_not_found',
      shop_domain: shop.shop_domain,
      product_id: product.id,
      missing,
      variants: variantSummaries,
    };
  }

  if (dryRun) {
    const dryRunRepair = applyMediaIdsToRepairVariants(repairVariants, {});
    return {
      ok: true,
      dry_run: true,
      shop_domain: shop.shop_domain,
      product_id: product.id,
      productCreateMedia: { media: repairMedia },
      variants: dryRunRepair.variants,
      product_media_created: { requested_count: repairMedia.length, created_count: 0 },
      media_id_mapping: { requested_count: repairMedia.length, unique_source_count: new Set(repairMedia.map((row: any) => mediaSourceKey(row.originalSource)).filter(Boolean)).size, created_count: 0, mapped_count: 0, mapped_by_alt: 0, mapped_by_index: 0, unresolved_count: repairMedia.length },
      variant_media_payload: dryRunRepair.diagnostics,
    };
  }

  const repairMediaCreated = await createProductMedia(shop, product.id, repairMedia);
  if (!repairMediaCreated.ok) {
    return {
      ok: false,
      status: repairMediaCreated.status || 502,
      error: repairMediaCreated.error || 'productCreateMedia media repair failed',
      shop_domain: shop.shop_domain,
      product_id: product.id,
      product_media_created: repairMediaCreated.product_media_created || { requested_count: repairMedia.length, created_count: 0 },
      raw: repairMediaCreated.raw,
    };
  }
  const repairMediaMapping = mediaIdMappingFrom(repairMedia, repairMediaCreated.media);
  const repairPayload = applyMediaIdsToRepairVariants(repairVariants, repairMediaMapping.sourceToMediaId);
  if (repairMedia.length && repairPayload.diagnostics.media_src_fallback_count > 0) {
    return {
      ok: false,
      status: 502,
      error: 'product_media_id_mapping_failed',
      shop_domain: shop.shop_domain,
      product_id: product.id,
      product_media_created: repairMediaCreated.product_media_created,
      media_id_mapping: repairMediaMapping.diagnostics,
      raw: repairMediaCreated.raw,
    };
  }

  const repaired = await bulkRepairVariantMedia(shop, product.id, repairPayload.variants);
  if (!repaired.ok) {
    return {
      ok: false,
      status: repaired.status || 502,
      error: repaired.error || 'productVariantsBulkUpdate media repair failed',
      shop_domain: shop.shop_domain,
      product_id: product.id,
      product_media_created: repairMediaCreated.product_media_created,
      media_id_mapping: repairMediaMapping.diagnostics,
      variant_media_payload: repairPayload.diagnostics,
      raw: repaired.raw,
    };
  }
  return {
    ok: true,
    shop_domain: shop.shop_domain,
    product_id: product.id,
    variants: repaired.variants,
    product_media_created: repairMediaCreated.product_media_created,
    media_id_mapping: repairMediaMapping.diagnostics,
    variant_media_payload: repairPayload.diagnostics,
    variant_media_counts: variantMediaCounts(repaired.variants),
    raw: repaired.raw,
  };
}

async function handleRepairOptionImages(req: Request): Promise<Response> {
  const denied = await requireBridgeTokenOrAuthenticatedUser(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return jsonResp({ ok: false, error: 'JSON body required' }, 400);

  const productId = shopifyProductGid(body.product_id || body.productId || body.platform_item_id || body.platformItemId);
  if (!productId) return jsonResp({ ok: false, error: 'valid Shopify product_id required' }, 400);

  const shopDomain = normalizeShopDomain(body.shop_domain || body.shop);
  const shop = await configuredShop(shopDomain);
  const scopeSet = shopScopeSet(shop);
  if (!scopeSet.has('write_products')) {
    return jsonResp({
      ok: false,
      error: 'missing_scopes',
      missing_scopes: ['write_products'],
      message: 'Shopify option image repair requires write_products scope',
      shop_domain: shop.shop_domain,
    }, 403);
  }
  const result = await repairOptionImagesForProduct(
    shop,
    productId,
    Array.isArray(body.variants) ? body.variants : body.option_images,
    body.dry_run === true,
  );
  return jsonResp(result, result.ok ? 200 : (result.status || 502));
}

async function fetchExistingShopifyRepairTargets(filters: Record<string, unknown>) {
  const limit = Math.min(250, Math.max(1, Math.floor(Number(filters.limit) || 25)));
  const productId = shopifyProductGid(filters.product_id || filters.productId || filters.platform_item_id || filters.platformItemId);
  const sku = norm(filters.sku);
  const masterProductId = norm(filters.master_product_id || filters.masterProductId);
  let q = supabase
    .from('platform_listings')
    .select('*')
    .eq('platform', 'shopify')
    .is('deleted_at', null)
    .not('platform_item_id', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(Math.min(1000, limit * 20));
  if (productId) q = q.eq('platform_item_id', productId);
  if (sku) q = q.eq('external_sku', sku);
  if (masterProductId) q = q.eq('master_product_id', masterProductId);
  const { data: listings, error } = await q;
  if (error) return { ok: false, error: error.message, status: 502, groups: [] };

  const rows = Array.isArray(listings) ? listings : [];
  const masterIds = uniq(rows.map((row: any) => row.master_product_id).filter(Boolean));
  const { data: products, error: productError } = masterIds.length
    ? await supabase.from('products').select('*').in('id', masterIds)
    : { data: [], error: null };
  if (productError) return { ok: false, error: productError.message, status: 502, groups: [] };

  const directProducts = Array.isArray(products) ? products : [];
  const groupIds = uniq(directProducts.map((row: any) => row.product_group_id).filter(Boolean));
  const { data: groupProducts, error: groupError } = groupIds.length
    ? await supabase.from('products').select('*').in('product_group_id', groupIds)
    : { data: [], error: null };
  if (groupError) return { ok: false, error: groupError.message, status: 502, groups: [] };

  const allProducts = [...directProducts, ...(Array.isArray(groupProducts) ? groupProducts : [])];
  const productById = new Map(allProducts.map((row: any) => [String(row.id), row]));
  const groupsByProduct = new Map<string, any>();
  for (const listing of rows) {
    const remoteProductId = norm(listing.platform_item_id);
    if (!remoteProductId) continue;
    const key = `${norm(listing.shop_id)}|${remoteProductId}`;
    if (!groupsByProduct.has(key)) {
      groupsByProduct.set(key, {
        shop_id: norm(listing.shop_id),
        product_id: remoteProductId,
        listings: [],
        product_rows: [],
      });
    }
    const group = groupsByProduct.get(key);
    group.listings.push(listing);
    const product = productById.get(String(listing.master_product_id));
    if (product && !group.product_rows.some((row: any) => String(row.id) === String(product.id))) group.product_rows.push(product);
  }

  const groups = [...groupsByProduct.values()].slice(0, limit).map((group: any) => {
    const direct = group.product_rows;
    const productGroupIds = new Set(direct.map((row: any) => norm(row.product_group_id)).filter(Boolean));
    const relatedProducts = allProducts
      .filter((row: any) => productGroupIds.has(norm(row.product_group_id)) || direct.some((directRow: any) => String(directRow.id) === String(row.id)));
    const masterProduct = direct[0] || relatedProducts[0] || {};
    return {
      ...group,
      master_product: masterProduct,
      group_products: relatedProducts.length ? relatedProducts : direct,
    };
  });
  return { ok: true, groups, listing_count: rows.length, product_count: allProducts.length };
}

function existingRepairOptionRowsForTarget(target: any): any[] {
  const productById = new Map((target.group_products || []).map((row: any) => [String(row.id), row]));
  const out = [];
  for (const listing of (target.listings || [])) {
    const product = productById.get(String(listing.master_product_id)) || {};
    const mediaUrl = shopifyExistingVariantImageUrlFrom(product);
    const sku = norm(listing.external_sku || product.sku);
    if (!sku || !mediaUrl) continue;
    out.push({
      sku,
      variant_id: listing.external_variant_id || null,
      mediaSrc: [mediaUrl],
      alt: norm(product.product_name || product.sku || sku).slice(0, 512),
    });
  }
  return out;
}

async function handleRepairExistingProducts(req: Request): Promise<Response> {
  const denied = requireInternalBridge(req);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  if (!body || typeof body !== 'object') return jsonResp({ ok: false, error: 'JSON body required' }, 400);
  const dryRun = body.apply === true ? false : true;
  const includeDescription = body.include_description !== false;
  const includeOptionImages = body.include_option_images !== false;
  const shopDomain = normalizeShopDomain(body.shop_domain || body.shop);
  const shop = await configuredShop(shopDomain);
  const scopeSet = shopScopeSet(shop);
  if (!scopeSet.has('write_products')) {
    return jsonResp({
      ok: false,
      error: 'missing_scopes',
      missing_scopes: ['write_products'],
      message: 'Shopify existing product repair requires write_products scope',
      shop_domain: shop.shop_domain,
    }, 403);
  }

  const fetched = await fetchExistingShopifyRepairTargets(body);
  if (!fetched.ok) return jsonResp({ ok: false, error: fetched.error || 'repair target fetch failed' }, fetched.status || 502);

  const results = [];
  const totals = {
    targets: 0,
    description_planned: 0,
    description_updated: 0,
    option_image_rows: 0,
    option_image_repaired: 0,
    skipped_no_images: 0,
    errors: 0,
  };
  for (const target of fetched.groups) {
    totals.targets += 1;
    const master = target.master_product || {};
    const groupProducts = Array.isArray(target.group_products) ? target.group_products : [];
    const result: any = {
      product_id: target.product_id,
      shop_id: target.shop_id || null,
      master_product_ids: uniq((target.listings || []).map((row: any) => row.master_product_id).filter(Boolean)),
      listing_count: (target.listings || []).length,
    };
    try {
      if (includeDescription) {
        const descriptionHtml = shopifyExistingDescriptionHtmlFrom(master, groupProducts);
        result.description = {
          planned: Boolean(descriptionHtml),
          length: descriptionHtml.length,
          has_detail_images: descriptionHtml.includes('Detail Images'),
        };
        if (descriptionHtml) totals.description_planned += 1;
        if (!dryRun && descriptionHtml) {
          const updated = await updateProductDescriptionHtml(shop, target.product_id, descriptionHtml);
          result.description.updated = updated.ok === true;
          result.description.error = updated.ok ? null : (updated.error || 'productUpdate failed');
          if (!updated.ok) throw new Error(result.description.error);
          totals.description_updated += 1;
        }
      }
      if (includeOptionImages) {
        const optionRows = existingRepairOptionRowsForTarget(target);
        totals.option_image_rows += optionRows.length;
        result.option_images = {
          planned_rows: optionRows.length,
          missing_rows: Math.max(0, (target.listings || []).length - optionRows.length),
        };
        if (optionRows.length) {
          const repaired = await repairOptionImagesForProduct(shop, target.product_id, optionRows, dryRun);
          result.option_images.result = {
            ok: repaired.ok === true,
            error: repaired.ok ? null : repaired.error,
            variant_media_counts: repaired.variant_media_counts || [],
            product_media_created: repaired.product_media_created || null,
            media_id_mapping: repaired.media_id_mapping || null,
          };
          if (!repaired.ok) throw new Error(repaired.error || 'option image repair failed');
          totals.option_image_repaired += 1;
        } else {
          totals.skipped_no_images += 1;
        }
      }
    } catch (error) {
      totals.errors += 1;
      result.error = String(error?.message || error);
    }
    results.push(result);
  }

  return jsonResp({
    ok: totals.errors === 0,
    dry_run: dryRun,
    apply: !dryRun,
    shop_domain: shop.shop_domain,
    fetched: {
      listing_count: fetched.listing_count || 0,
      product_count: fetched.product_count || 0,
    },
    totals,
    results,
  }, totals.errors === 0 ? 200 : 207);
}

async function handleLookupSku(req: Request): Promise<Response> {
  const denied = await requireBridgeTokenOrAuthenticatedUser(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const sku = norm(url.searchParams.get('sku'));
  if (!sku) return jsonResp({ ok: false, error: 'sku query param required' }, 400);
  const shopDomain = normalizeShopDomain(url.searchParams.get('shop') || url.searchParams.get('shop_domain'));
  const shop = await configuredShop(shopDomain);
  const escapedSku = shopifySearchString(sku);
  const queryText = `sku:"${escapedSku}"`;
  const query = `
    query ShopifyBridgeProductVariantBySku($query: String!) {
      productVariants(first: 10, query: $query) {
        nodes {
          id
          title
          sku
          price
          selectedOptions { name value }
          inventoryItem { id sku tracked }
          product { id title status handle publishedAt }
        }
      }
    }
  `;
  const { status, raw } = await shopifyGraphql(shop, query, { query: queryText });
  if (status < 200 || status >= 300 || raw?.errors?.length) {
    return jsonResp({ ok: false, error: graphErrorMessage(raw), raw }, status || 502);
  }
  const nodes = raw?.data?.productVariants?.nodes || [];
  const exactMatches = nodes.filter((node: any) => norm(node?.sku) === sku || norm(node?.inventoryItem?.sku) === sku);
  if (!exactMatches.length) {
    return jsonResp({ ok: false, error: 'product_not_found', sku, match_count: nodes.length, exact_match_count: 0, raw }, 404);
  }
  if (exactMatches.length > 1) {
    return jsonResp({
      ok: false,
      error: 'duplicate_sku',
      message: `Shopify SKU is ambiguous: ${sku}`,
      sku,
      match_count: nodes.length,
      exact_match_count: exactMatches.length,
      product_ids: exactMatches.map((node: any) => node?.product?.id).filter(Boolean),
      variant_ids: exactMatches.map((node: any) => node?.id).filter(Boolean),
      raw,
    }, 409);
  }
  const hit = exactMatches[0];
  return jsonResp({
    ok: true,
    shop_domain: shop.shop_domain,
    sku,
    match_count: nodes.length,
    exact_match_count: exactMatches.length,
    product_id: hit.product?.id || null,
    platform_item_id: hit.product?.id || null,
    variant_id: hit.id,
    external_variant_id: hit.id,
    listing_status: mapShopifyListingStatus(hit.product),
    status: hit.product?.status || null,
    title: hit.product?.title || hit.title || null,
    price: hit.price || null,
    inventory_item_id: hit.inventoryItem?.id || null,
    selected_options: hit.selectedOptions || [],
    raw,
  });
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const action = url.pathname.split('/').filter(Boolean).pop() || '';

  try {
    if (action === 'healthz' && req.method === 'GET') return await handleHealthz();
    if (action === 'oauth-url' && req.method === 'GET') return await handleOAuthUrl(req);
    if (action === 'oauth-callback' && (req.method === 'GET' || req.method === 'POST')) return await handleOAuthCallback(req);
    if (action === 'shop' && req.method === 'GET') return await handleShop(req);
    if ((action === 'carrier-service' || action === 'shipping-carrier-service') && req.method === 'POST') return await handleCarrierService(req);
    if (action === 'create-product' && req.method === 'POST') return await handleCreateProduct(req);
    if (action === 'archive-product' && req.method === 'POST') return await handleArchiveProduct(req);
    if (action === 'set-sku' && req.method === 'POST') return await handleSetSku(req);
    if (action === 'repair-option-images' && req.method === 'POST') return await handleRepairOptionImages(req);
    if (action === 'repair-existing-products' && req.method === 'POST') return await handleRepairExistingProducts(req);
    if (action === 'lookup-sku' && req.method === 'GET') return await handleLookupSku(req);
    if (action === 'internal-check' && req.method === 'GET') {
      const denied = requireInternalBridge(req);
      if (denied) return denied;
      return jsonResp({ ok: true, service: 'shopify-bridge' });
    }
    return jsonResp({ ok: false, error: `unknown action: ${action} (${req.method})` }, 404);
  } catch (e: any) {
    console.error('[shopify-bridge] error', e?.message || e);
    return jsonResp({ ok: false, error: String(e?.message || e) }, 500);
  }
}

Deno.serve(handleRequest);
