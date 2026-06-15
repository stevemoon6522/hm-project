// @ts-nocheck
// eBay platform-publish adapter.
// Routes create/sync through ebay-bridge and keeps unsupported update semantics out of scope.

import type { AdapterContext, AdapterResult, AdapterErrorCode, PlatformAdapter } from '../_shared/contract.ts';
import { resolveEbayFulfillmentPolicy } from '../_shared/fulfillment.ts';
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
  const cost = n(master.cost_krw, 0);
  if (cost <= 0) return '';
  let exchangeRate = 1380;
  let salesFee = 13;
  let pgFee = 2.7;
  try {
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data } = await svc.from('country_settings').select('exchange_rate,sales_fee,pg_fee').eq('country_code', 'EX').maybeSingle();
      exchangeRate = n(data?.exchange_rate, exchangeRate);
      salesFee = n(data?.sales_fee, salesFee);
      pgFee = n(data?.pg_fee, pgFee);
    }
  } catch { /* use fallback */ }
  const feeRate = Math.min(0.95, Math.max(0, (salesFee + pgFee) / 100));
  return (Math.ceil((cost / exchangeRate / (1 - feeRate)) * 100) / 100).toFixed(2);
}

function aspectsFrom(master: Record<string, unknown>) {
  const artist = s(master.artist || master.brand || master.shopee_brand_name || '').trim();
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

async function createListing(ctx: BridgeContext): Promise<AdapterResult> {
  const userToken = s(ctx.userAuthToken);
  if (!userToken) return { ok: false, listingStatus: 'error', errorCode: 'PLATFORM_AUTH_FAILED', errorMsg: 'Authenticated user token is required for eBay publish' };
  const master = ctx.masterProduct as Record<string, unknown>;
  const sku = s(master.sku).trim();
  const images = imagesFrom(master);
  const goods = isGoodsMaster(master);
  const categoryId = s(master.ebay_category_id, goods ? EBAY_GOODS_CATEGORY_ID : EBAY_DEFAULT_CATEGORY_ID).trim() || (goods ? EBAY_GOODS_CATEGORY_ID : EBAY_DEFAULT_CATEGORY_ID);
  const description = s(master.description || master.shopee_description).trim();
  const priceUsd = await ebayPriceUsd(master);
  const weightG = n(master.weight_g, 0);
  const lifecycleState = lifecycleOf(master);
  const fulfillmentPolicy = resolveEbayFulfillmentPolicy(lifecycleState);
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
