// @ts-nocheck
// Qoo10 adapter for platform-publish.
//
// Scope: sync only. Qoo10 publish/create remains blocked elsewhere, but SKU
// coverage sync can safely read qoo10-bridge lookup results and absorb them into
// platform_listings.

import type { AdapterContext, AdapterResult, PlatformAdapter } from '../_shared/contract.ts';

const SUPABASE_URL = (Deno as any).env.get('SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = (Deno as any).env.get('SUPABASE_ANON_KEY') || '';
const QOO10_BRIDGE_URL = (Deno as any).env.get('QOO10_BRIDGE_URL') || (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/qoo10-bridge` : '');

async function lookupQoo10BySku(sku: string, userAuthToken = '') {
  if (!QOO10_BRIDGE_URL) {
    return { ok: false, status: 500, json: { error: 'QOO10_BRIDGE_URL missing' } };
  }
  const headers: Record<string, string> = {};
  if (SUPABASE_ANON_KEY) headers.apikey = SUPABASE_ANON_KEY;
  if (userAuthToken) headers.Authorization = `Bearer ${userAuthToken}`;
  const resp = await fetch(`${QOO10_BRIDGE_URL}/lookup-sku?sku=${encodeURIComponent(sku)}`, { headers });
  const json = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
  return { ok: resp.ok && json.ok !== false, status: resp.status, json };
}

export const qoo10Adapter: PlatformAdapter = {
  supports: new Set(['sync']),
  async execute(ctx: AdapterContext): Promise<AdapterResult> {
    if (ctx.capability !== 'sync') {
      return {
        ok: false,
        listingStatus: 'not_listed',
        errorCode: 'CAPABILITY_UNSUPPORTED',
        errorMsg: `qoo10 adapter only supports sync; capability='${ctx.capability}' is intentionally blocked`,
      };
    }

    const sku = String(ctx.masterProduct?.sku || '').trim();
    if (!sku) {
      return {
        ok: false,
        listingStatus: 'not_listed',
        errorCode: 'INPUT_INVALID',
        errorMsg: 'products.sku is empty; cannot perform Qoo10 SKU lookup',
      };
    }

    const userAuthToken = String((ctx as any).userAuthToken || '');
    if (!userAuthToken) {
      return {
        ok: false,
        listingStatus: 'not_listed',
        errorCode: 'AUTH_NOT_VERIFIED',
        errorMsg: 'Missing authenticated user token for qoo10-bridge lookup',
      };
    }

    const result = await lookupQoo10BySku(sku, userAuthToken);
    if (!result.ok) {
      const error = result.json?.error || result.json?.message || `HTTP ${result.status}`;
      return {
        ok: false,
        listingStatus: 'not_listed',
        errorCode: result.status === 404 ? 'PLATFORM_NOT_FOUND' : 'PLATFORM_UNKNOWN',
        errorMsg: error,
        rawResponse: result.json,
      };
    }

    const platformItemId = String(result.json.goods_no || result.json.goodsNo || result.json.platform_item_id || '').trim();
    if (!platformItemId) {
      return {
        ok: false,
        listingStatus: 'not_listed',
        errorCode: 'PLATFORM_UNKNOWN',
        errorMsg: 'qoo10-bridge lookup succeeded but did not return goods_no',
        rawResponse: result.json,
      };
    }

    return {
      ok: true,
      platformItemId,
      listingStatus: 'listed',
      rawResponse: {
        ...result.json,
        platform_item_id: platformItemId,
        variant_id: result.json.option_code || result.json.seller_code || sku,
      },
    };
  },
};
