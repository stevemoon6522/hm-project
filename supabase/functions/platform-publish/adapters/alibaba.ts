// @ts-nocheck
// Alibaba (ICBU / alibaba.com B2B) adapter for platform-publish.
//
// Plan ref: plans/alibaba-deep-lemon.md §3.
// Mirrors adapters/qoo10.ts: up-front validation emitting typed AdapterErrorCode
// values, then a call to a separate signing bridge Edge Function (alibaba-bridge)
// that performs the actual Alibaba Open Platform (TOP) request.
//
// Scope (1st cut): create_listing + sync only. update_* is out of scope — the
// ICBU product.edit endpoint is not captured in api-refs (gap E7), so the
// platform_capabilities gate keeps those at docs_ready=false.
//
// HARD CONSTRAINT (Codex P0 #1): no guessed API behavior. The fields marked
// [B] below depend on the operator's local Alibaba ICBU docs and are filled in
// Phase B. Until then the bridge returns a structured docs_required error and
// the dispatcher's gate 4 (auth_verified=false) blocks any live call anyway.

import type { AdapterContext, AdapterResult, PlatformAdapter } from '../_shared/contract.ts';

const SUPABASE_URL = (Deno as any).env.get('SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = (Deno as any).env.get('SUPABASE_ANON_KEY') || '';
const ALIBABA_BRIDGE_URL = (Deno as any).env.get('ALIBABA_BRIDGE_URL')
  || (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/alibaba-bridge` : '');

function norm(value: unknown): string {
  return String(value || '').trim();
}

function alibabaPayload(ctx: AdapterContext): Record<string, any> {
  return ((ctx as any).alibaba || {}) as Record<string, any>;
}

function categoryFrom(ctx: AdapterContext, ali: Record<string, any>): string {
  return norm(ali.category_id || ctx.masterProduct?.alibaba_category_id);
}

function freightTemplateFrom(ctx: AdapterContext, ali: Record<string, any>): string {
  return norm(ali.freight_template_id || ctx.masterProduct?.alibaba_freight_template_id);
}

function attributesFrom(ctx: AdapterContext, ali: Record<string, any>): Record<string, any> {
  const fromPayload = ali.attributes;
  if (fromPayload && typeof fromPayload === 'object') return fromPayload;
  const stored = ctx.masterProduct?.alibaba_attributes;
  if (stored && typeof stored === 'object') return stored as Record<string, any>;
  return {};
}

function titleFrom(ctx: AdapterContext, ali: Record<string, any>): string {
  const explicit = norm(ali.title || ali.subject);
  if (explicit) return explicit.slice(0, 128);
  return norm(ctx.masterProduct?.product_name || ctx.masterProduct?.sku).slice(0, 128);
}

function priceUsdFrom(ctx: AdapterContext, ali: Record<string, any>): number {
  const n = Number(ali.price_usd ?? ctx.masterProduct?.alibaba_price_usd);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function moqFrom(ctx: AdapterContext, ali: Record<string, any>): number {
  const n = Math.floor(Number(ali.moq ?? ctx.masterProduct?.alibaba_moq ?? 1));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function imagesFrom(ctx: AdapterContext, ali: Record<string, any>): string[] {
  const out: string[] = [];
  const main = norm(ali.main_image || ctx.masterProduct?.main_image);
  if (main) out.push(main);
  const extras = Array.isArray(ali.extra_images)
    ? ali.extra_images
    : (Array.isArray(ctx.masterProduct?.extra_images) ? ctx.masterProduct.extra_images : []);
  for (const url of extras) {
    const u = norm(url);
    if (u && !out.includes(u)) out.push(u);
  }
  // ICBU photobank caps at 6 images per product (api-001 evidence note).
  return out.slice(0, 6);
}

// Map an Alibaba ICBU product status to the dispatcher's listingStatus union.
// [B] exact status strings to be confirmed against product.status.get.v2 docs.
function mapAlibabaListingStatus(rawStatus: unknown): AdapterResult['listingStatus'] {
  const status = norm(rawStatus).toLowerCase();
  if (!status) return 'listed';
  if (['approved', 'auditing_through', 'on_selling', 'published', 'posted'].includes(status)) return 'listed';
  if (['auditing', 'pending', 'tobeedit', 'draft'].includes(status)) return 'pending';
  if (['expired', 'member_expired', 'deleted', 'off_selling'].includes(status)) return 'not_listed';
  if (['auditing_not_through', 'rejected'].includes(status)) return 'rejected';
  return 'listed';
}

function classifyBridgeError(status: number, json: any): string {
  const msg = norm(json?.error || json?.message || json?.error_msg || `HTTP ${status}`);
  const code = norm(json?.error_code || json?.code || json?.sub_code);
  if (json?.docs_required) return 'DOCS_NOT_READY';
  if (status === 401 || status === 403 || /token|auth|sign|app[_ ]?key|isp\.|isv\./i.test(code) || /authori[sz]|invalid[_ ]?session|access[_ ]?token/i.test(msg)) {
    return 'PLATFORM_AUTH_FAILED';
  }
  if (status === 429 || /rate|throttle|app[_ ]?call[_ ]?limit|flow[_ ]?control/i.test(msg + code)) return 'PLATFORM_THROTTLED';
  if (status === 404) return 'PLATFORM_NOT_FOUND';
  if (/required|missing|invalid|param|attribute|category|freight|template|image|price|moq/i.test(msg)) return 'PLATFORM_VALIDATION_ERROR';
  return 'PLATFORM_UNKNOWN';
}

async function bridgeFetch(path: string, init: RequestInit = {}, userAuthToken = '') {
  if (!ALIBABA_BRIDGE_URL) return { ok: false, status: 500, json: { error: 'ALIBABA_BRIDGE_URL missing' } };
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> || {}) };
  if (SUPABASE_ANON_KEY) headers.apikey = SUPABASE_ANON_KEY;
  if (userAuthToken) headers.Authorization = `Bearer ${userAuthToken}`;
  const resp = await fetch(`${ALIBABA_BRIDGE_URL}${path}`, { ...init, headers });
  const json = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
  return { ok: resp.ok && json.ok !== false, status: resp.status, json };
}

async function executeSync(ctx: AdapterContext): Promise<AdapterResult> {
  const sku = norm(ctx.masterProduct?.sku);
  const productId = norm((ctx as any).platformItemId);
  if (!sku && !productId) {
    return { ok: false, listingStatus: 'not_listed', errorCode: 'INPUT_INVALID', errorMsg: 'products.sku and platform_item_id are both empty; cannot perform Alibaba status lookup' };
  }
  const userAuthToken = norm((ctx as any).userAuthToken);
  const q = productId ? `product_id=${encodeURIComponent(productId)}` : `sku=${encodeURIComponent(sku)}`;
  const result = await bridgeFetch(`/status?${q}`, {}, userAuthToken);
  if (!result.ok) {
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: classifyBridgeError(result.status, result.json) as any,
      errorMsg: result.json?.error || result.json?.message || `HTTP ${result.status}`,
      rawResponse: result.json,
    };
  }
  const platformItemId = norm(result.json.product_id || result.json.platform_item_id || productId);
  if (!platformItemId) {
    return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_NOT_FOUND', errorMsg: 'Alibaba status lookup returned no product_id', rawResponse: result.json };
  }
  return {
    ok: true,
    platformItemId,
    listingStatus: mapAlibabaListingStatus(result.json.status || result.json.product_status),
    rawResponse: { ...result.json, platform_item_id: platformItemId },
  };
}

async function executeCreate(ctx: AdapterContext): Promise<AdapterResult> {
  const ali = alibabaPayload(ctx);
  const userAuthToken = norm((ctx as any).userAuthToken);

  const categoryId = categoryFrom(ctx, ali);
  const attributes = attributesFrom(ctx, ali);
  const freightTemplateId = freightTemplateFrom(ctx, ali);
  const title = titleFrom(ctx, ali);
  const priceUsd = priceUsdFrom(ctx, ali);
  const moq = moqFrom(ctx, ali);
  const images = imagesFrom(ctx, ali);

  // Up-front validation (mirrors qoo10 adapter). Uses the reserved Alibaba
  // error codes from _shared/contract.ts.
  if (!categoryId) {
    return { ok: false, listingStatus: 'not_listed', errorCode: 'ALIBABA_REQUIRED_ATTRS_MISSING', errorMsg: 'alibaba_category_id is required to register an ICBU listing' };
  }
  if (!attributes || Object.keys(attributes).length === 0) {
    return { ok: false, listingStatus: 'not_listed', errorCode: 'ALIBABA_REQUIRED_ATTRS_MISSING', errorMsg: 'ICBU required category attributes are missing (products.alibaba_attributes / payload.attributes)' };
  }
  if (!freightTemplateId) {
    return { ok: false, listingStatus: 'not_listed', errorCode: 'ALIBABA_SHIPPING_TEMPLATE_MISSING', errorMsg: 'alibaba_freight_template_id is required (ICBU freight/shipping template)' };
  }
  if (!title) {
    return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'Alibaba listing title/subject is required' };
  }
  if (!priceUsd) {
    return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'alibaba_price_usd (FOB unit price) is required and must be > 0' };
  }
  if (!images.length) {
    return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'At least one product image is required for an ICBU listing' };
  }
  if (!userAuthToken) {
    return { ok: false, listingStatus: 'not_listed', errorCode: 'AUTH_NOT_VERIFIED', errorMsg: 'Missing authenticated user token for alibaba-bridge create-listing' };
  }

  // The bridge performs the photobank.upload pre-step for non-alicdn images
  // and then alibaba.icbu.product.listing.v2. [B] payload param names are
  // filled from api-011-...product-listing-v2.md in Phase B; until then the
  // bridge replies { docs_required: true } and we surface DOCS_NOT_READY.
  const payload = {
    sku: norm(ctx.masterProduct?.sku),
    category_id: categoryId,
    subject: title,
    attributes,
    freight_template_id: freightTemplateId,
    moq,
    unit: norm(ali.unit || ctx.masterProduct?.alibaba_unit || 'piece'),
    price_usd: priceUsd,
    group_id: norm(ali.group_id || ctx.masterProduct?.alibaba_group_id),
    description: norm(ali.description || ctx.masterProduct?.description),
    images,
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

  const platformItemId = norm(result.json.product_id || result.json.platform_item_id);
  if (!platformItemId) {
    return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_UNKNOWN', errorMsg: 'Alibaba create-listing succeeded but no product_id was returned', rawResponse: result.json };
  }
  return {
    ok: true,
    platformItemId,
    // Alibaba auto-activates on publish (see capability seed: activate_listing=false).
    listingStatus: mapAlibabaListingStatus(result.json.status || 'approved'),
    rawResponse: { ...result.json, platform_item_id: platformItemId },
  };
}

export const alibabaAdapter: PlatformAdapter = {
  supports: new Set(['create_listing', 'sync']),
  async execute(ctx: AdapterContext): Promise<AdapterResult> {
    if (ctx.capability === 'sync') return executeSync(ctx);
    if (ctx.capability === 'create_listing') return executeCreate(ctx);
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'CAPABILITY_UNSUPPORTED',
      errorMsg: `alibaba adapter does not support capability='${ctx.capability}'`,
    };
  },
};
