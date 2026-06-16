// @ts-nocheck
// Joom platform-publish adapter.
// Routes create/sync through the existing joom-bridge instead of direct Joom API calls.

import type { AdapterContext, AdapterResult, AdapterErrorCode, PlatformAdapter } from '../_shared/contract.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const PLATFORM_BRIDGE_INTERNAL_TOKEN = (Deno as any)['env']['get']('PLATFORM_BRIDGE_INTERNAL_TOKEN') || '';
const JOOM_GOODS_CATEGORY_ID = '1733235756332554566-61-2-11859-1440023039';

type BridgeContext = AdapterContext & { userAuthToken?: string };

function s(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value);
}

function n(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
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

function joomTitleCase(value) {
  return String(value || '').replace(/\S+/g, (word) =>
    word.replace(/[A-Za-z][A-Za-z'’]*/g, (part) =>
      part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    )
  ).replace(/\s+/g, ' ').trim();
}

function lifecycleProductName(value: unknown, lifecycle: string, fallback = ''): string {
  const body = stripLifecycleTags(value) || stripLifecycleTags(fallback) || s(fallback).trim();
  return joomTitleCase(`${lifecyclePrefix(lifecycle)} ${body}`.replace(/\s+/g, ' ').trim());
}

function imagesFrom(master: Record<string, unknown>): string[] {
  const images = [s(master.main_image), ...(Array.isArray(master.extra_images) ? master.extra_images.map((v) => s(v)) : [])]
    .map((v) => v.trim())
    .filter(Boolean);
  return [...new Set(images)];
}

function cleanBrand(value: unknown): string {
  return s(value).replace(/\s+/g, ' ').trim();
}

function usableBrand(value: unknown): string {
  const brand = cleanBrand(value);
  return brand && !/^no brand$/i.test(brand) ? brand : '';
}

function brandFrom(master: Record<string, unknown>): string {
  return [
    master.brand,
    master.joom_brand_name,
    master.shopee_brand_name,
    master.qoo10_brand_name,
    master.artist,
  ].map(usableBrand).find(Boolean) || '';
}

function mapBridgeError(status: number, raw: any): AdapterErrorCode {
  const text = s(raw?.error || raw?.message || raw?.detail).toLowerCase();
  if (status === 401 || status === 403 || text.includes('auth') || text.includes('token')) return 'PLATFORM_AUTH_FAILED';
  if (status === 429 || text.includes('throttl') || text.includes('rate')) return 'PLATFORM_THROTTLED';
  if (status === 404 || text.includes('not_found') || text.includes('not found')) return 'PLATFORM_NOT_FOUND';
  if (status === 400 || text.includes('required') || text.includes('invalid') || text.includes('duplicate')) return 'PLATFORM_VALIDATION_ERROR';
  return 'PLATFORM_UNKNOWN';
}

function mapJoomStatus(raw: any): AdapterResult['listingStatus'] {
  const state = s(raw?.state || raw?.joom_product_state || raw?.listingStatus).toLowerCase();
  const explicitStatus = s(raw?.listing_status || raw?.listingStatus).toLowerCase();
  const infractions = Array.isArray(raw?.infractions) ? raw.infractions : [];
  if (infractions.some((row: any) => s(row?.kind || row?.code).toLowerCase().includes('reject'))) return 'rejected';
  if (explicitStatus === 'not_listed') return 'not_listed';
  if (explicitStatus === 'pending' || explicitStatus === 'draft') return 'pending';
  if (explicitStatus === 'paused') return 'paused';
  if (explicitStatus === 'rejected' || explicitStatus === 'banned') return explicitStatus as AdapterResult['listingStatus'];
  if (explicitStatus === 'listed') return 'listed';
  if (state === 'archived' || state === 'not_listed') return 'not_listed';
  if (state === 'pending' || state === 'draft' || state === 'locked') return 'pending';
  if (['disabled', 'paused'].some((v) => state.includes(v))) return 'paused';
  if (['reject', 'banned'].some((v) => state.includes(v))) return 'rejected';
  if (raw?.hasActiveVersion === false) return 'pending';
  if (['active', 'approved', 'listed', 'enabled', 'published', 'warning'].some((v) => state.includes(v))) return 'listed';
  if (raw?.joom_product_id && raw?.joom_enabled !== false) return 'listed';
  if (raw?.joom_product_id) return 'pending';
  return 'not_listed';
}

async function bridgePost(action: string, body: Record<string, unknown>, userToken: string): Promise<{ status: number; raw: any }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/joom-bridge/${action}`, {
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
  const res = await fetch(`${SUPABASE_URL}/functions/v1/joom-bridge/${action}?${qs}`, {
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

function buildCreateBody(ctx: BridgeContext): Record<string, unknown> | AdapterResult {
  const master = ctx.masterProduct as Record<string, unknown>;
  const sku = s(master.sku).trim();
  const imgs = imagesFrom(master);
  const cost = n(master.cost_krw);
  const weight = n(master.weight_g);
  const goods = isGoodsMaster(master);
  const categoryId = s(master.joom_category_id || (master as any).categoryId || (goods ? JOOM_GOODS_CATEGORY_ID : 'music_albums')).trim();
  const brand = brandFrom(master);
  if (!sku || !cost || cost <= 0 || !weight || weight <= 0 || imgs.length === 0 || !categoryId || !brand) {
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'PLATFORM_VALIDATION_ERROR',
      errorMsg: 'Joom create_listing requires sku, cost_krw, weight_g, main_image, categoryId and brand',
    };
  }
  const inventory = Math.max(0, Math.floor(n(master.inventory, 0)));
  return {
    row: { sku, cost, weight },
    scrapedAssets: {
      mainImage: imgs[0],
      name: lifecycleProductName(master.product_name, lifecycleOf(master), sku),
      detailImages: imgs.slice(1),
      extraImages: [],
    },
    variantsConfig: [{ name: 'DEFAULT', sku, inventory, enabled: true, weight, image: imgs[0] }],
    categoryId,
    enabled: true,
    namePrefix: '',
    contents: s(master.description),
    brand,
  };
}

async function createListing(ctx: BridgeContext): Promise<AdapterResult> {
  const userToken = s(ctx.userAuthToken);
  if (!userToken) return { ok: false, listingStatus: 'error', errorCode: 'PLATFORM_AUTH_FAILED', errorMsg: 'Authenticated user token is required for Joom publish' };
  const body = buildCreateBody(ctx);
  if ('ok' in body && body.ok === false) return body as AdapterResult;
  const { status, raw } = await bridgePost(ctx.dryRun ? 'dryrun' : 'publish', body as Record<string, unknown>, userToken);
  if (status >= 200 && status < 300 && raw?.ok !== false) {
    return {
      ok: true,
      platformItemId: s(raw?.joom_product_id || raw?.id),
      listingStatus: ctx.dryRun ? 'draft' : mapJoomStatus(raw),
      rawResponse: raw,
    };
  }
  return {
    ok: false,
    listingStatus: status === 404 ? 'not_listed' : 'error',
    errorCode: mapBridgeError(status, raw),
    errorMsg: `joom-bridge publish failed (${status})`,
    rawResponse: raw,
  };
}

async function syncListing(ctx: BridgeContext): Promise<AdapterResult> {
  const userToken = s(ctx.userAuthToken);
  if (!userToken) return { ok: false, listingStatus: 'error', errorCode: 'PLATFORM_AUTH_FAILED', errorMsg: 'Authenticated user token is required for Joom sync' };
  const params = {
    sku: s(ctx.masterProduct.sku),
    id: s(ctx.masterProduct.joom_product_id),
  };
  const { status, raw } = await bridgeGet('lookup-sku', params, userToken);
  if (status >= 200 && status < 300 && raw?.ok) {
    return {
      ok: true,
      platformItemId: s(raw.joom_product_id),
      listingStatus: mapJoomStatus(raw),
      rawResponse: raw,
    };
  }
  const errorCode = mapBridgeError(status, raw);
  return {
    ok: false,
    listingStatus: errorCode === 'PLATFORM_NOT_FOUND' ? 'not_listed' : 'error',
    errorCode,
    errorMsg: s(raw?.error || raw?.message || 'Joom SKU not found'),
    rawResponse: raw,
  };
}

export const joomAdapter: PlatformAdapter = {
  supports: new Set(['create_listing', 'sync']),
  async execute(ctx: AdapterContext): Promise<AdapterResult> {
    const bridgeCtx = ctx as BridgeContext;
    if (ctx.capability === 'create_listing') return createListing(bridgeCtx);
    if (ctx.capability === 'sync') return syncListing(bridgeCtx);
    return { ok: false, listingStatus: 'not_listed', errorCode: 'CAPABILITY_UNSUPPORTED', errorMsg: `Joom adapter does not support ${ctx.capability}` };
  },
};
