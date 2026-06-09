// @ts-nocheck
// Alibaba.com (ICBU B2B) adapter for platform-publish.
//
// Plan ref: plans/alibaba-deep-lemon.md §3 (Phase B — real ICBU mapping).
// Scope: create_listing + sync. update_* is out of scope (no product.edit API).
//
// Docs (api-refs): product.listing.v2, product.status.get.v2,
// product.search.v2, 000145 how-to-create-a-product-listing.
// Per docs the minimum to list is title + >=1 image + price (TIERED). Category,
// attributes and shipping template are OPTIONAL (category is AI-predicted when
// omitted; shipping template is only needed for RTS products). The bridge owns
// the ICBU request schema; this adapter passes normalized business fields.

import type { AdapterContext, AdapterResult, PlatformAdapter } from '../_shared/contract.ts';

const SUPABASE_URL = (Deno as any).env.get('SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = (Deno as any).env.get('SUPABASE_ANON_KEY') || '';
const ALIBABA_BRIDGE_URL = (Deno as any).env.get('ALIBABA_BRIDGE_URL')
  || (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/alibaba-bridge` : '');

function norm(value: unknown): string { return String(value ?? '').trim(); }

function alibabaPayload(ctx: AdapterContext): Record<string, any> {
  return ((ctx as any).alibaba || {}) as Record<string, any>;
}

function imagesFrom(ctx: AdapterContext, ali: Record<string, any>): string[] {
  const out: string[] = [];
  const push = (u: unknown) => { const s = norm(u); if (s && /^https?:\/\//i.test(s) && !out.includes(s)) out.push(s); };
  if (Array.isArray(ali.images)) ali.images.forEach(push);
  else {
    push(ali.main_image || ctx.masterProduct?.main_image);
    const extras = Array.isArray(ali.extra_images) ? ali.extra_images
      : (Array.isArray(ctx.masterProduct?.extra_images) ? ctx.masterProduct.extra_images : []);
    extras.forEach(push);
  }
  return out.slice(0, 6); // photobank caps at 6 per product
}

function attributesFrom(ali: Record<string, any>, master: Record<string, any>): any[] {
  const src = Array.isArray(ali.attributes) ? ali.attributes
    : (Array.isArray(master?.alibaba_attributes) ? master.alibaba_attributes : []);
  return (Array.isArray(src) ? src : [])
    .map((a: any) => ({ attribute_name: norm(a.attribute_name || a.name), attribute_value: norm(a.attribute_value || a.value) }))
    .filter((a: any) => a.attribute_name && a.attribute_value);
}

// status/get/v2: online|draft|failed|pending ; search/v2 status: online|offline|deleted
function mapAlibabaListingStatus(status: unknown, auditStatus?: unknown): AdapterResult['listingStatus'] {
  const s = norm(status).toLowerCase();
  const a = norm(auditStatus).toLowerCase();
  if (a === 'rejected') return 'rejected';
  if (s === 'online') return 'listed';
  if (s === 'draft') return 'draft';
  if (s === 'pending' || a === 'pending') return 'pending';
  if (s === 'failed') return 'error';
  if (s === 'offline' || s === 'deleted') return 'not_listed';
  return s ? 'pending' : 'listed';
}

function classifyBridgeError(status: number, json: any): string {
  if (json?.docs_required) return 'DOCS_NOT_READY';
  const msgCode = norm(json?.msg_code || json?.error_code);
  const msg = norm(json?.error || json?.message);
  if (status === 503 || /disabled/i.test(msg)) return 'DOCS_NOT_READY';
  if (status === 401 || status === 403 || /token|access_token|auth|sign|app[_ ]?key|invalid[_ ]?session/i.test(msg)) return 'PLATFORM_AUTH_FAILED';
  if (status === 429 || /flow[_ ]?control|app[_ ]?call[_ ]?limit|rate|throttle/i.test(msg + msgCode)) return 'PLATFORM_THROTTLED';
  if (status === 404 || /B_PRODUCT_NOT_FOUND/i.test(msgCode)) return 'PLATFORM_NOT_FOUND';
  if (msgCode.startsWith('S_') || /S_COMMON_INTERNAL_ERROR/i.test(msgCode)) return 'PLATFORM_UNKNOWN';
  if (msgCode.startsWith('B_') || /required|invalid|param|price|image|category|attribute/i.test(msg)) return 'PLATFORM_VALIDATION_ERROR';
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

async function executeCreate(ctx: AdapterContext): Promise<AdapterResult> {
  const ali = alibabaPayload(ctx);
  const master = (ctx.masterProduct || {}) as Record<string, any>;
  const userAuthToken = norm((ctx as any).userAuthToken);

  const title = (norm(ali.title) || norm(master.product_name) || norm(master.sku)).slice(0, 128);
  const images = imagesFrom(ctx, ali);
  const priceUsd = Number(ali.price_usd ?? master.alibaba_price_usd);
  const moq = Math.max(1, Math.floor(Number(ali.moq ?? master.alibaba_moq ?? 1)));
  const unit = norm(ali.unit || master.alibaba_unit) || 'Piece';

  // Required minimum (per 000145): title + image + price. category/attrs/freight optional.
  if (!title) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'Alibaba 등록: 상품명(title)이 필요합니다.' };
  if (!images.length) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'Alibaba 등록: 공개 https 이미지가 최소 1장 필요합니다.' };
  if (!(priceUsd > 0)) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'Alibaba 등록: FOB 단가(price_usd)가 0보다 커야 합니다.' };
  if (!userAuthToken) return { ok: false, listingStatus: 'not_listed', errorCode: 'AUTH_NOT_VERIFIED', errorMsg: 'alibaba-bridge 호출용 인증 토큰이 없습니다.' };

  const body = {
    title,
    description: norm(ali.description || master.description),
    keywords: norm(ali.keywords),
    images,
    category_id: norm(ali.category_id || master.alibaba_category_id),     // optional → AI predicts if blank
    category_name: norm(ali.category_name),
    attributes: attributesFrom(ali, master),                              // optional
    price_usd: priceUsd,
    moq,
    unit,
    inventory: ali.inventory ?? master.inventory,
    model_number: norm(ali.model_number || master.sku),
    brand_name: norm(ali.brand_name),
    shipping_template_id: norm(ali.freight_template_id || master.alibaba_freight_template_id), // optional → RTS only
    weight: ali.weight ?? (master.weight_g ? Number(master.weight_g) / 1000 : ''),
    lead_time: ali.lead_time,
    dimension: ali.dimension,
  };

  // dry-run: validate + preview the payload without creating a real listing.
  // (Alibaba's listing.v2 has no dry-run mode, so we stop before the bridge.)
  if (ctx.dryRun) {
    return { ok: true, listingStatus: 'draft', rawResponse: { dry_run: true, product_preview: body } };
  }

  const result = await bridgeFetch('/create-listing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

  const productId = norm(result.json.product_id);
  if (!productId) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_UNKNOWN', errorMsg: 'Alibaba create-listing succeeded but no product_id returned', rawResponse: result.json };
  // Listing accepted; Alibaba resolves final status async (20-60s) → run sync.
  return {
    ok: true,
    platformItemId: productId,
    listingStatus: mapAlibabaListingStatus(result.json.status || 'pending'),
    rawResponse: { ...result.json, platform_item_id: productId },
  };
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
  const pid = norm(result.json.product_id || productId);
  if (!pid) return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_NOT_FOUND', errorMsg: 'Alibaba status lookup returned no product_id', rawResponse: result.json };
  return {
    ok: true,
    platformItemId: pid,
    listingStatus: mapAlibabaListingStatus(result.json.status, result.json.audit_status),
    rawResponse: { ...result.json, platform_item_id: pid },
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
