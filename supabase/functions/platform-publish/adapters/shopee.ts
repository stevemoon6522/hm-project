// @ts-nocheck
// D2 Shopee adapter — routes 4 doc-ready capabilities to shopee-bridge.
//
// Plan ref: platform-publish-dispatcher-plan.md v2 §C.1, §D2.
// Spec ref: api-summaries/shopee-dispatcher-spec.md §2-§7.
//
// Auth pattern: dispatcher passes the user's Bearer JWT via
//   ctx.userAuthToken (injected by the dispatcher before calling execute).
// shopee-bridge requires role='authenticated' for all mutating actions
//   (index.ts:1652-1658); public read-only actions (global_item_info,
//   published_list, publish_task_result) skip the check and accept any caller.
//
// Supported capabilities (per §B.2 matrix):
//   create_listing   → register_cbsc (composite: add_global_item → init_tier_variation
//                      → add_global_model → create_publish_task → poll) (bridge index.ts:2112-2241)
//   update_metadata  → update_global_item via V2 mutation pipeline          (bridge index.ts:1112-1142)
//   update_images    → update_global_item with image_id_list only           (bridge index.ts:1112-1142)
//   sync             → global_item_info (PUBLIC_ACTIONS, no auth needed)    (bridge index.ts:2378-2382)
//
// Unsupported capabilities per §B.2:
//   activate_listing        → n/a (Shopee auto-activates on publish_task)
//   update_price_qty        → docs_ready=false (gap E1) — refused at gate 3 before adapter
//   update_variant_inventory → docs_ready=false (gap E2) — refused at gate 3 before adapter

import type { AdapterContext, AdapterResult, AdapterErrorCode, PlatformAdapter } from '../_shared/contract.ts';
import { createClient as _createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

// ---------------------------------------------------------------------------
// Defense-in-depth: permanently-banned shop IDs.
// Dispatcher gate 6 also blocks these, but we guard here for direct callers
// (e.g. cron jobs that bypass the dispatcher).
// 1002269093 = old BR shop, permanently banned by Shopee 2026-05 — replaced
// by 1669858301 (starphotocardwl).  Must never be re-introduced.
// ---------------------------------------------------------------------------
const BANNED_SHOPEE_SHOP_IDS = new Set<string>(['1002269093']);

// ---------------------------------------------------------------------------
// Bridge invocation helpers
// ---------------------------------------------------------------------------

// The dispatcher injects userAuthToken on the ctx object (see index.ts adapter
// dispatch block). Typed here so TS doesn't complain under @ts-nocheck.
type ShopeeAdapterContext = AdapterContext & { userAuthToken?: string };

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';

// POST to shopee-bridge/{action} with user JWT forwarded.
// shopee-bridge reads action from url.pathname.split('/').pop() (bridge index.ts:1646).
async function bridgePost(action: string, body: Record<string, unknown>, userToken: string): Promise<unknown> {
  const url = `${SUPABASE_URL}/functions/v1/shopee-bridge/${action}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userToken}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// GET from shopee-bridge/{action} with query params.
// Used for read-only PUBLIC_ACTIONS that need no auth check on the bridge itself
// (global_item_info is in PUBLIC_ACTIONS at bridge index.ts:43).
// The Supabase functions gateway (verify_jwt=true) validates the JWT signature but
// does NOT check role; we forward the user's JWT so the gateway accepts it, and the
// bridge skips requireAuthenticatedUser for PUBLIC_ACTIONS.
async function bridgeGet(action: string, params: Record<string, string>, userToken: string): Promise<unknown> {
  const qs = new URLSearchParams(params);
  const url = `${SUPABASE_URL}/functions/v1/shopee-bridge/${action}?${qs}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${userToken}`,
    },
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Shopee error code → AdapterErrorCode mapping
// (spec §6 error classification)
// ---------------------------------------------------------------------------
function mapShopeeError(error: string): AdapterErrorCode {
  if (!error) return 'PLATFORM_UNKNOWN';
  const e = String(error).toLowerCase();

  // Auth / permission errors (spec §6 "Auth / permission")
  if (
    e === 'error_auth' ||
    e === 'error_sign' ||
    e === 'error_merchant_not_found' ||
    e === 'error_auth_shop_not_found' ||
    e === 'error_permission'
  ) {
    return 'PLATFORM_AUTH_FAILED';
  }

  // Throttling / system (spec §6 "Throttling / system")
  if (e === 'error_inner' || e === 'error_system_busy' || e === 'error_network') {
    return 'PLATFORM_THROTTLED';
  }

  // Not found (spec §6 "Item-not-found / business")
  if (
    e === 'error_item_not_found' ||
    e === 'error_busi_item_not_found' ||
    e === 'error_busi_global_item_not_found'
  ) {
    return 'PLATFORM_NOT_FOUND';
  }

  // Validation (spec §6 "Validation")
  if (
    e.startsWith('error_param') ||
    e === 'error_invalid_brand' ||
    e === 'error_invalid_attribute' ||
    e === 'error_invalid_category' ||
    e === 'error_invalid_days_to_ship' ||
    e.startsWith('error_busi_global_item_') ||
    e.startsWith('error_stock_') ||
    e.startsWith('error_image_') ||
    e === 'error_busi_cannot_publish' ||
    e === 'error_repeated_mtsku' ||
    e === 'error_busi_region_not_supported'
  ) {
    return 'PLATFORM_VALIDATION_ERROR';
  }

  return 'PLATFORM_UNKNOWN';
}

// ---------------------------------------------------------------------------
// Map Shopee item status string → AdapterResult.listingStatus
// ---------------------------------------------------------------------------
function mapShopeeItemStatus(shopeeStatus: unknown): AdapterResult['listingStatus'] {
  // Shopee global item statuses observed in get_global_item_info response
  const s = String(shopeeStatus || '').toUpperCase();
  if (s === 'NORMAL') return 'listed';
  if (s === 'BANNED' || s === 'DELETED') return 'banned';
  if (s === 'REVIEWING') return 'pending';
  if (s === 'DRAFT') return 'draft';
  if (s === 'PAUSED' || s === 'PUNISHED') return 'paused';
  if (s === 'REJECTED') return 'rejected';
  // Unknown → listed (if we got item info it presumably exists)
  return 'listed';
}

// ---------------------------------------------------------------------------
// create_listing_multi_region — Phase A multi-region register_cbsc handler.
//
// Plan ref: register-shopee-rebuild-phase-a.md §B
// Input (from dispatcher ctx, extended fields):
//   ctx.masterProduct.*            — includes new shopee_* columns
//   ctx.regions: string[]          — ['SG','TW','TH','MY','PH','BR'] (subset)
//   ctx.lifecycle_state?           — overrides masterProduct.lifecycle_state
//   ctx.publishRequestId           — idempotency key
//   ctx.dryRun                     — dry_run: steps a-c only, no bridge call
//
// Flow:
//   a) Extract master product fields including new shopee_* columns.
//   b) Validate required fields → PLATFORM_VALIDATION_ERROR with field name.
//   c) Build register_cbsc body with multi-region targets[].
//   d) POST to shopee-bridge /register_cbsc (dry_run skips this step).
//   e) Parse per-region results, upsert product_shopee_listings rows.
//   f) Log to platform_listings via upsert_platform_listing RPC.
//   g) Send Telegram alert summary (if ALERT_BOT_URL is set).
//   h) Return { ok, results: [{region, status, global_item_id?, shop_item_id?, error?}] }
// ---------------------------------------------------------------------------

// Env references for DB access (needed for product_shopee_listings upserts).
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ALERT_BOT_URL = Deno.env.get('ALERT_BOT_URL') || '';
const ALERT_HMAC_SECRET = Deno.env.get('ALERT_HMAC_SECRET') || '';

function shopeeLifecycleOf(master: Record<string, unknown> = {}, override: unknown = ''): string {
  const lifecycle = String(override || (master as any).lifecycle_state || '').toLowerCase();
  return lifecycle === 'pre_order' ? 'pre_order' : 'ready_stock';
}

function shopeeLifecyclePrefix(lifecycle: string): string {
  return lifecycle === 'pre_order' ? '[PRE ORDER]' : '[READY STOCK]';
}

function stripShopeeLifecycleTags(value: unknown): string {
  return String(value || '').replace(/\s*\[(?:PRE\s*[- ]?\s*ORDER|READY\s*[- ]?\s*STOCK|ON\s*HAND|FAST\s*DELIVERY)\]\s*/gi, ' ').replace(/\s+/g, ' ').trim();
}

function shopeeLifecycleProductName(value: unknown, lifecycle: string, fallback = ''): string {
  const body = stripShopeeLifecycleTags(value) || stripShopeeLifecycleTags(fallback) || String(fallback || '').trim();
  return `${shopeeLifecyclePrefix(lifecycle)} ${body}`.replace(/\s+/g, ' ').trim();
}

// HMAC helper (mirrors index.ts; both files use @ts-nocheck so duplication is acceptable).
async function _hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Fire-and-forget Telegram alert (matches dispatchAlert in index.ts).
function _dispatchAlert(payload: Record<string, unknown>): void {
  if (!ALERT_BOT_URL) return;
  if (!ALERT_HMAC_SECRET) {
    console.warn(JSON.stringify({
      service: 'platform-publish/shopee-adapter',
      event: 'alert_dispatch_skipped',
      reason: 'ALERT_BOT_URL set but ALERT_HMAC_SECRET missing',
      ts: new Date().toISOString(),
    }));
    return;
  }
  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  (async () => {
    try {
      const sig = await _hmacSha256Hex(ALERT_HMAC_SECRET, body);
      await fetch(ALERT_BOT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Alert-Signature': sig },
        body,
        signal: controller.signal,
      });
    } catch { /* swallow */ } finally { clearTimeout(timer); }
  })();
}

// Supabase service-role client for product_shopee_listings upserts.
function makeSvcClient() {
  return _createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function handleCreateListingMultiRegion(ctx: ShopeeAdapterContext): Promise<AdapterResult> {
  const master = ctx.masterProduct as any;
  const regions: string[] = Array.isArray((ctx as any).regions) ? (ctx as any).regions : [];
  const lifecycle_state: string = shopeeLifecycleOf(master, (ctx as any).lifecycle_state);

  // ------------------------------------------------------------------
  // STEP B: Validate required master-data fields (gate 7 pre-checks).
  // Returns PLATFORM_VALIDATION_ERROR with a human-readable message.
  // ------------------------------------------------------------------
  if (!master.shopee_category_id) {
    console.log(JSON.stringify({ service: 'platform-publish/shopee-adapter', event: 'create_listing_multi_region_validation_fail', field: 'shopee_category_id', master_product_id: master.id, ts: new Date().toISOString() }));
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'SHOPEE_CATEGORY_MISSING',
      errorMsg: 'shopee_category_id가 설정되지 않았습니다. Shopee 카테고리를 먼저 지정해 주세요.',
    };
  }
  if (!master.shopee_image_id && !master.main_image) {
    console.log(JSON.stringify({ service: 'platform-publish/shopee-adapter', event: 'create_listing_multi_region_validation_fail', field: 'shopee_image_id', master_product_id: master.id, ts: new Date().toISOString() }));
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'SHOPEE_IMAGE_MISSING',
      errorMsg: 'shopee_image_id와 main_image가 모두 없습니다. 이미지를 먼저 등록해 주세요.',
    };
  }
  if (!master.shopee_brand_id && master.shopee_brand_id !== 0) {
    console.log(JSON.stringify({ service: 'platform-publish/shopee-adapter', event: 'create_listing_multi_region_validation_fail', field: 'shopee_brand_id', master_product_id: master.id, ts: new Date().toISOString() }));
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'SHOPEE_BRAND_MISSING',
      errorMsg: 'shopee_brand_id가 설정되지 않았습니다.',
    };
  }
  const cost_krw = Number(master.cost_krw);
  if (!cost_krw || cost_krw <= 0) {
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'SHOPEE_COST_KRW_INVALID',
      errorMsg: '매입가(cost_krw)가 0 이하입니다. 가격을 먼저 설정해 주세요.',
    };
  }
  const weight_g = Number(master.weight_g);
  if (!weight_g || weight_g <= 0) {
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'SHOPEE_WEIGHT_MISSING',
      errorMsg: '상품 무게(weight_g)가 0 이하입니다. 무게를 먼저 입력해 주세요.',
    };
  }
  if (!['ready_stock', 'pre_order'].includes(lifecycle_state)) {
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'SHOPEE_LIFECYCLE_INVALID',
      errorMsg: `lifecycle_state가 잘못되었습니다 (${lifecycle_state}). ready_stock 또는 pre_order만 허용됩니다.`,
    };
  }
  if (!regions.length) {
    return {
      ok: false,
      listingStatus: 'not_listed',
      errorCode: 'PLATFORM_VALIDATION_ERROR',
      errorMsg: 'regions 배열이 비어 있습니다.',
    };
  }

  // ------------------------------------------------------------------
  // STEP C: Build register_cbsc request body.
  // Price model C: cost_krw is the Global SKU price (KRW).
  // Shopee auto-converts to local currency via Price Calculation Formula.
  // ------------------------------------------------------------------
  const dtsMap = master.shopee_days_to_ship || {};
  const dtsSection = lifecycle_state === 'ready_stock'
    ? (dtsMap.ready_stock || {})
    : (dtsMap.pre_order || {});

  // Brand is sent via the top-level `brand` object in add_global_item, NOT in
  // attribute_list. Shopee returns "Chocolate Type(100012) is not mapped with the
  // category" if brand appears in attribute_list. Strip any 100012 entry that
  // upstream might have stored, and emit a separate brand object below.
  const extraAttrs: any[] = Array.isArray(master.shopee_extra_attributes) ? master.shopee_extra_attributes : [];
  const attribute_list = extraAttrs.filter((a: any) => Number(a.attribute_id) !== 100012);
  const brand_obj = master.shopee_brand_id === 0 || master.shopee_brand_id == null
    ? { brand_id: 0, original_brand_name: 'No Brand' }
    : { brand_id: Number(master.shopee_brand_id), original_brand_name: master.shopee_brand_name || 'No Brand' };

  // Per-region image_ids — caller (SPA) uploads one image per region (KRSC
  // requires images live in the target region's image space) and BR needs at
  // least 2 images. If ctx.region_image_ids is missing for a region we fall
  // back to master.shopee_image_id (still works for SG-style same-region
  // upload) but BR will fail at publish_task if only 1 image provided.
  const regionImageIds: Record<string, string[]> = (ctx as any).region_image_ids || {};
  const regionPrices: Record<string, number> = (ctx as any).region_prices || {};
  const targets = regions.map((r: string) => {
    const ids = Array.isArray(regionImageIds[r]) && regionImageIds[r].length ? regionImageIds[r] : null;
    const computedPrice = Number(regionPrices[r]);
    const targetPrice = Number.isFinite(computedPrice) && computedPrice > 0 ? computedPrice : cost_krw;
    return {
      region: r,
      price: targetPrice,
      price_krw: cost_krw,
      days_to_ship: dtsSection[r] ?? 2,
      ...(ids ? { image_id_list: ids } : {}),
    };
  });

  // Codex P1 (code review): bridge `register_cbsc` derives base context from
  // body.region || 'SG'. Without an explicit region, every multi-region publish
  // creates the global item in SG context regardless of target regions. Send
  // the first requested region as the explicit base — bridge then fans out
  // per-target publish tasks. SG is the safest default if the list is empty.
  const baseRegion = regions[0] || 'SG';

  // Operator msg #679/#680: pre_order distinction matters at every step.
  // - add_global_item Global DTS capped at 10 (bridge enforces via PRE_ORDER_GLOBAL_DTS).
  // - per-region create_publish_task DTS can be 3-150 (bridge clamps per is_pre_order).
  // - buildPublishItemPayload must send is_pre_order:true for pre_order lifecycle,
  //   otherwise items publish as Ready Stock with DTS > 10 → Shopee rejects.
  const is_pre_order = lifecycle_state === 'pre_order';
  const registerName = String(
    (ctx as any).shopee_product_name
    || shopeeLifecycleProductName(master.product_name, lifecycle_state, master.sku)
    || master.sku
    || ''
  ).trim();
  const registerDescription = String(
    (ctx as any).shopee_description
    || master.shopee_description
    || master.description
    || registerName
    || master.sku
    || ''
  ).trim();
  const stockOverride = Number((ctx as any).stock_override);
  const registerStock = Number.isFinite(stockOverride) && stockOverride > 0
    ? Math.floor(stockOverride)
    : Math.max(0, Math.floor(Number(master.inventory) || 0));

  const bridgeBody: Record<string, unknown> = {
    region: baseRegion,
    name: registerName,
    sku: master.sku,
    category_id: Number(master.shopee_category_id),
    brand: brand_obj,
    image_id: master.shopee_image_id || undefined,
    image_url: !master.shopee_image_id ? (master.main_image || undefined) : undefined,
    weight_g: Number(master.weight_g) || 100,
    price: cost_krw,            // Global SKU KRW price (model C — no margin multiplication)
    stock: registerStock,
    description: registerDescription || registerName || master.sku,
    attribute_list,
    targets,
    lifecycle_state,            // 'ready_stock' | 'pre_order' — bridge consults this
    is_pre_order,               // explicit boolean for buildPublishItemPayload
    publish_request_id: ctx.publishRequestId,
    dry_run: ctx.dryRun ? true : undefined,
  };

  console.log(JSON.stringify({
    service: 'platform-publish/shopee-adapter',
    event: 'create_listing_multi_region_start',
    master_product_id: master.id,
    regions,
    lifecycle_state,
    dry_run: ctx.dryRun,
    ts: new Date().toISOString(),
  }));

  // ------------------------------------------------------------------
  // STEP D: dry_run — return computed payload without API call.
  // ------------------------------------------------------------------
  if (ctx.dryRun) {
    return {
      ok: true,
      listingStatus: 'draft',
      rawResponse: { dry_run: true, computed_payload: bridgeBody },
    };
  }

  // ------------------------------------------------------------------
  // STEP D: POST to shopee-bridge /register_cbsc.
  // ------------------------------------------------------------------
  const raw = await bridgePost('register_cbsc', bridgeBody, ctx.userAuthToken || '') as any;

  // Bridge-level error (before any publish task).
  if (!raw.ok || raw.error) {
    const shopeeErrCode = mapShopeeError(raw.error || '');
    const errCode = shopeeErrCode === 'PLATFORM_UNKNOWN' && raw.error && !String(raw.error).startsWith('error_')
      ? 'PLATFORM_VALIDATION_ERROR' as const
      : shopeeErrCode;
    console.log(JSON.stringify({
      service: 'platform-publish/shopee-adapter',
      event: 'create_listing_multi_region_bridge_error',
      master_product_id: master.id,
      error: raw.error,
      ts: new Date().toISOString(),
    }));
    return {
      ok: false,
      listingStatus: 'error',
      errorCode: errCode,
      errorMsg: raw.message || raw.error || 'register_cbsc failed',
      rawResponse: raw,
    };
  }

  const global_item_id: number | undefined = raw.global_item_id;
  const perRegionResults: any[] = Array.isArray(raw.results) ? raw.results : [];

  // ------------------------------------------------------------------
  // STEP E: Upsert product_shopee_listings per region.
  // ------------------------------------------------------------------
  const svc = makeSvcClient();

  const regionSummary: Array<{ region: string; status: string; global_item_id?: number; shop_item_id?: number; error?: string }> = [];

  for (const r of perRegionResults) {
    const regionCode: string = String(r.region || '').toUpperCase();
    const regionOk: boolean = r.ok === true;
    const shopItemId: number | undefined = r.item_id || r.shop_item_id || undefined;
    // Extract the richest possible failure reason — bridge wraps the raw publish_task
    // response in `task`, which may carry { response: { publish_result: [...] } } or
    // { response: { failed: { ... } } }. Surface those details so operators can act
    // on the real Shopee error rather than just "publish failed".
    let errorMsg: string | undefined = r.error ? (r.message || r.error) : undefined;
    if (!regionOk) {
      const parts: string[] = [];
      if (r.stage) parts.push(`stage=${r.stage}`);
      if (r.raw_create?.error) parts.push(`create_err=${r.raw_create.error}:${r.raw_create.message || ''}`);
      const taskBody = r.raw_task?.response || r.task?.response || r.raw_task || r.task || {};
      const failedList = Array.isArray(taskBody.publish_result)
        ? taskBody.publish_result.filter((p: any) => p && (p.error || p.failed_reason || p.message))
        : [];
      const taskFailed = taskBody.failed || failedList[0];
      const failedReason = taskFailed?.failed_reason || taskFailed?.message || taskFailed?.error;
      if (failedReason) parts.push(`task_failed=${failedReason}`);
      if (r.poll_attempts != null) parts.push(`polls=${r.poll_attempts}`);
      try { parts.push(`task_raw=${JSON.stringify(taskBody).slice(0, 600)}`); } catch {}
      if (Array.isArray(raw.publishable_shops?.response?.publishable_shop)) {
        const eligible = raw.publishable_shops.response.publishable_shop.find((s: any) => Number(s.shop_id) === Number(r.shop_id) || String(s.shop_region || s.region || '').toUpperCase() === regionCode);
        if (!eligible) parts.push(`shop_not_publishable_for_global_item`);
      }
      const composed = parts.join(' | ');
      errorMsg = errorMsg ? `${errorMsg} | ${composed}` : (composed || 'publish failed');
    }

    // Upsert product_shopee_listings (primary key: product_id + region).
    const upsertPayload: Record<string, unknown> = {
      product_id: master.id,
      region: regionCode,
      global_item_id: global_item_id ? Number(global_item_id) : null,
      shop_item_id: shopItemId ? Number(shopItemId) : null,
      status: regionOk ? 'mapped' : 'failed',
      last_error: errorMsg || null,
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await svc
      .from('product_shopee_listings')
      .upsert(upsertPayload, { onConflict: 'product_id,region' });

    if (upsertErr) {
      console.log(JSON.stringify({
        service: 'platform-publish/shopee-adapter',
        event: 'create_listing_multi_region_listing_upsert_failed',
        master_product_id: master.id,
        region: regionCode,
        error: upsertErr.message,
        ts: new Date().toISOString(),
      }));
    }

    regionSummary.push({
      region: regionCode,
      status: regionOk ? 'mapped' : 'failed',
      global_item_id: global_item_id ? Number(global_item_id) : undefined,
      shop_item_id: shopItemId ? Number(shopItemId) : undefined,
      error: errorMsg,
    });
  }

  // Also cover any requested regions that didn't appear in results (bridge may omit on error).
  // Codex P1 (code review): previously only added to in-memory regionSummary but skipped
  // the product_shopee_listings upsert, leaving the DB blind to partial failures.
  // Now upsert a 'failed' row so subsequent retries can target only the missing regions.
  for (const reqRegion of regions) {
    const regionCode = reqRegion.toUpperCase();
    if (!regionSummary.find((s) => s.region === regionCode)) {
      const upsertPayload: Record<string, unknown> = {
        product_id: master.id,
        region: regionCode,
        global_item_id: global_item_id ? Number(global_item_id) : null,
        shop_item_id: null,
        status: 'failed',
        last_error: 'no result from bridge',
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const { error: upsertErr } = await svc
        .from('product_shopee_listings')
        .upsert(upsertPayload, { onConflict: 'product_id,region' });
      if (upsertErr) {
        console.log(JSON.stringify({
          service: 'platform-publish/shopee-adapter',
          event: 'create_listing_multi_region_missing_region_upsert_failed',
          master_product_id: master.id,
          region: regionCode,
          error: upsertErr.message,
          ts: new Date().toISOString(),
        }));
      }
      regionSummary.push({ region: regionCode, status: 'failed', error: 'no result from bridge' });
    }
  }

  // ------------------------------------------------------------------
  // STEP F: Log to platform_listings via upsert_platform_listing RPC.
  // One row per (master_product_id, platform='shopee', country=region).
  // ------------------------------------------------------------------
  for (const summary of regionSummary) {
    const { error: rpcErr } = await svc.rpc('upsert_platform_listing', {
      p_master_product_id: master.id,
      p_platform: 'shopee',
      p_shop_id: null,
      p_country: summary.region,
      p_platform_item_id: summary.global_item_id ? String(summary.global_item_id) : null,
      p_listing_status: summary.status === 'mapped' ? 'listed' : 'error',
      p_last_publish_request_id: ctx.publishRequestId,
      p_last_payload: { capability: 'create_listing_multi_region', regions, lifecycle_state, shopee_product_name: registerName },
      p_last_sync_at: new Date().toISOString(),
      p_error_msg: summary.error || null,
      p_error_code: summary.error ? 'PLATFORM_VALIDATION_ERROR' : null,
    });
    if (rpcErr) {
      console.log(JSON.stringify({
        service: 'platform-publish/shopee-adapter',
        event: 'create_listing_multi_region_platform_listing_rpc_failed',
        master_product_id: master.id,
        region: summary.region,
        error: rpcErr.message,
        ts: new Date().toISOString(),
      }));
    }
  }

  // ------------------------------------------------------------------
  // STEP G: Telegram alert summary (fire-and-forget).
  // ------------------------------------------------------------------
  const successCount = regionSummary.filter((s) => s.status === 'mapped').length;
  const failCount = regionSummary.filter((s) => s.status !== 'mapped').length;
  _dispatchAlert({
    entity_type: 'shopee_multi_region_publish',
    master_product_id: master.id,
    sku: master.sku,
    global_item_id: global_item_id ?? null,
    regions_requested: regions.length,
    regions_ok: successCount,
    regions_failed: failCount,
    publish_request_id: ctx.publishRequestId,
    summary: regionSummary,
    ts: new Date().toISOString(),
  });

  console.log(JSON.stringify({
    service: 'platform-publish/shopee-adapter',
    event: 'create_listing_multi_region_done',
    master_product_id: master.id,
    global_item_id,
    regions_ok: successCount,
    regions_failed: failCount,
    ts: new Date().toISOString(),
  }));

  const overallOk = successCount > 0;
  return {
    ok: overallOk,
    listingStatus: overallOk ? 'listed' : 'error',
    platformItemId: global_item_id ? String(global_item_id) : undefined,
    rawResponse: { global_item_id, results: regionSummary },
  };
}

// ---------------------------------------------------------------------------
// create_listing — composite register_cbsc action
// (spec §2, bridge index.ts:2112-2241)
// ---------------------------------------------------------------------------
async function handleCreateListing(ctx: ShopeeAdapterContext): Promise<AdapterResult> {
  const { masterProduct, country: region, shopId, dryRun, userAuthToken, publishRequestId } = ctx;
  if (!region) {
    return { ok: false, listingStatus: 'error', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'country/region required for create_listing' };
  }
  if (!shopId) {
    return { ok: false, listingStatus: 'error', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'shop_id required for create_listing' };
  }

  // Defense-in-depth: block banned shop IDs regardless of how this adapter was called.
  if (BANNED_SHOPEE_SHOP_IDS.has(String(shopId))) {
    return { ok: false, listingStatus: 'error', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: `shop_id ${shopId} is permanently banned and cannot be used` };
  }

  // P0: refuse create_listing when price/stock are missing on the master product.
  // Publishing at 0 stock would silently create an unavailable listing.
  // TODO (D2.5): replace this guard with a real pricing-rule lookup
  //   (products.cost_krw → regional price via country_settings markup).
  // 2026-05-21 Codex hot-fix re-review: products.cost_krw is the ACTUAL
  // master-data field. Previous guard only checked price/global_price/price_krw,
  // which would silently block every real master product.
  const price = (masterProduct as any).price
    ?? (masterProduct as any).global_price
    ?? (masterProduct as any).price_krw
    ?? (masterProduct as any).cost_krw;
  const stock = (masterProduct as any).stock
    ?? (masterProduct as any).available_stock
    ?? (masterProduct as any).inventory;     // products.inventory is the live qty column
  if (price == null || price <= 0 || stock == null) {
    return {
      ok: false,
      listingStatus: 'error',
      errorCode: 'PLATFORM_VALIDATION_ERROR',
      errorMsg: 'price/stock missing on master product — set cost_krw + inventory before publishing (D2.5 pricing-rule TODO)',
    };
  }

  // Build the register_cbsc payload.
  // register_cbsc expects: name, sku, category_id, image_id/image_url, weight_g, days_to_ship,
  // targets: [{region, shop_id, ...}], variation? (spec §2a, bridge index.ts:2118-2121)
  //
  // masterProduct.main_image is a URL; the dispatcher/bridge's /upload_image step handles
  // actual image IDs. For now, pass image_url and let shopee-bridge attempt to upload
  // if needed. For a smoke-test/sync path, the product must already have pre-uploaded images.
  // NOTE: a production create_listing flow requires the image to be pre-uploaded via
  // shopee-bridge's /upload_image action first. The adapter passes image_url here;
  // the bridge's register_cbsc handles the logistics of getting an image_id if needed.

  const lifecycle_state = shopeeLifecycleOf(masterProduct as any, (ctx as any).lifecycle_state);
  const is_pre_order = lifecycle_state === 'pre_order';
  const payload: Record<string, unknown> = {
    region,
    name: shopeeLifecycleProductName(masterProduct.product_name, lifecycle_state, masterProduct.sku) || masterProduct.sku,
    sku: masterProduct.sku,
    // category_id must be set on masterProduct or provided via shopee_listings;
    // dispatcher gate 7 does not yet check this for shopee. We'll pass null and
    // let shopee-bridge return a validation error (register_cbsc checks at index.ts:2120).
    category_id: (masterProduct as any).shopee_category_id ?? null,
    image_url: masterProduct.main_image || null,
    weight_g: masterProduct.weight_g || 100,
    days_to_ship: (masterProduct as any).days_to_ship ?? (is_pre_order ? 10 : 2),
    price: Number(price),
    stock: Number(stock),
    targets: [{ region, shop_id: Number(shopId) }],
    lifecycle_state,
    is_pre_order,
    publish_request_id: publishRequestId,
    dry_run: dryRun ? true : undefined,
  };

  // Variants (if any are present on the master product)
  if ((masterProduct as any).variants && Array.isArray((masterProduct as any).variants)) {
    payload.variation = (masterProduct as any).variants;
  }

  const raw = await bridgePost('register_cbsc', payload, userAuthToken || '') as any;

  // register_cbsc returns { ok, global_item_id, stage_logs, results[] }
  // (bridge index.ts:2241)
  if (!raw.ok || raw.error) {
    // Distinguish bridge pre-flight errors (e.g. "category_id required",
    // "mandatory_attribute_missing") from Shopee API errors (error_auth, etc.)
    // Bridge pre-flight errors come back as { ok: false, error: '...plain text...' }
    // without a Shopee error code format. Map them to PLATFORM_VALIDATION_ERROR.
    const shopeeErrCode = mapShopeeError(raw.error || '');
    const errCode = shopeeErrCode === 'PLATFORM_UNKNOWN' && raw.error && !String(raw.error).startsWith('error_')
      ? 'PLATFORM_VALIDATION_ERROR' as const
      : shopeeErrCode;
    return {
      ok: false,
      listingStatus: 'error',
      errorCode: errCode,
      errorMsg: raw.message || raw.error || 'register_cbsc failed',
      rawResponse: raw,
    };
  }

  // Check publish results per target (bridge index.ts:2215-2240)
  const results: any[] = Array.isArray(raw.results) ? raw.results : [];
  const targetResult = results[0];
  if (!targetResult) {
    return {
      ok: false,
      listingStatus: 'pending',
      platformItemId: String(raw.global_item_id || ''),
      errorCode: 'PLATFORM_UNKNOWN',
      errorMsg: 'register_cbsc returned no publish results',
      rawResponse: raw,
    };
  }

  if (!targetResult.ok) {
    return {
      ok: false,
      listingStatus: 'error',
      platformItemId: String(raw.global_item_id || ''),
      errorCode: mapShopeeError(targetResult.error || ''),
      errorMsg: targetResult.message || targetResult.error || 'publish task failed',
      rawResponse: raw,
    };
  }

  // Success: publish task completed (bridge parsePublishOutcome returns item_id)
  return {
    ok: true,
    listingStatus: 'listed',
    platformItemId: String(raw.global_item_id || ''),
    rawResponse: raw,
  };
}

// ---------------------------------------------------------------------------
// update_metadata — update_global_item via V2 mutation pipeline
// (spec §3a, bridge index.ts:1112-1142)
// Maps to dispatcher capability 'update_metadata'.
// Only passes title/description/sku fields; leave out image_id_list.
// ---------------------------------------------------------------------------
async function handleUpdateMetadata(ctx: ShopeeAdapterContext): Promise<AdapterResult> {
  const { masterProduct, country: region, userAuthToken, platformItemId, publishRequestId } = ctx;
  if (!platformItemId) {
    return { ok: false, listingStatus: 'error', errorCode: 'PLATFORM_VALIDATION_ERROR', errorMsg: 'platformItemId required for update_metadata' };
  }

  const lifecycle_state = shopeeLifecycleOf(masterProduct as any, (ctx as any).lifecycle_state);

  // NOTE: weight is intentionally omitted here.
  // Sending weight on update_global_item overwrites child model weights too,
  // which breaks per-variant weight on multi-variation listings.
  // TODO: add a separate update_weight capability when needed.
  const payload: Record<string, unknown> = {
    region: region || 'SG',
    global_item_id: Number(platformItemId),
    global_item_name: shopeeLifecycleProductName(masterProduct.product_name, lifecycle_state, masterProduct.sku) || undefined,
    description: masterProduct.description || undefined,
    global_item_sku: masterProduct.sku || undefined,
    publish_request_id: publishRequestId,
  };

  const raw = await bridgePost('update_global_item', payload, userAuthToken || '') as any;

  if (!raw.ok || raw.error) {
    return {
      ok: false,
      listingStatus: 'error',
      errorCode: mapShopeeError(raw.error || ''),
      errorMsg: raw.message || raw.error || 'update_global_item failed',
      rawResponse: raw,
    };
  }
  return {
    ok: true,
    listingStatus: 'listed',
    platformItemId,
    rawResponse: raw,
  };
}

// ---------------------------------------------------------------------------
// update_images — NOT YET IMPLEMENTED in the bridge layer.
// docs_ready=false in platform_capabilities (migration 202605200025).
// The V2 mutation pipeline (shopee-bridge runV2MutationAction, index.ts:1112-1142)
// only passes sku/name/description/pre_order fields — image_id_list is not
// wired. Gate 3 will refuse this capability before we're ever called (because
// docs_ready=false), but we also pre-check here as defense-in-depth.
//
// TODO (bridge extension needed):
//   1. Add image.image_id_list to runV2MutationAction update_global_item block.
//   2. Expose a /upload_image → /update_global_item composite action on the bridge.
//   3. Flip docs_ready back to true and remove this early return.
// ---------------------------------------------------------------------------
async function handleUpdateImages(_ctx: ShopeeAdapterContext): Promise<AdapterResult> {
  return {
    ok: false,
    listingStatus: 'error',
    errorCode: 'CAPABILITY_UNSUPPORTED',
    errorMsg: 'update_images is not yet supported: shopee-bridge V2 pipeline does not wire image_id_list. Pre-upload via /upload_image + /update_global_item directly. See TODO in adapters/shopee.ts handleUpdateImages.',
  };
}

// ---------------------------------------------------------------------------
// sync — get_global_item_info (PUBLIC_ACTION, no auth needed)
// (spec §5b, bridge index.ts:2378-2382)
// global_item_info is in PUBLIC_ACTIONS so no auth header is required.
// ---------------------------------------------------------------------------
async function handleSync(ctx: ShopeeAdapterContext): Promise<AdapterResult> {
  const { platformItemId, country: region, userAuthToken } = ctx;
  if (!platformItemId) {
    return { ok: false, listingStatus: 'not_listed', errorCode: 'PLATFORM_NOT_FOUND', errorMsg: 'platformItemId required for sync (no existing platform_item_id on this listing)' };
  }

  // global_item_info: GET /functions/v1/shopee-bridge/global_item_info?region=SG&global_item_id=<id>
  // (bridge index.ts:2378-2382 — PUBLIC_ACTIONS, bridge skips requireAuthenticatedUser)
  // The Supabase gateway still needs a valid JWT in Authorization header (verify_jwt=true on
  // shopee-bridge), so we forward the user token. The bridge skips its own role check for
  // PUBLIC_ACTIONS regardless of which JWT the gateway accepted.
  const raw = await bridgeGet('global_item_info', {
    region: region || 'SG',
    global_item_id: platformItemId,
  }, userAuthToken || '') as any;

  if (!raw.ok || raw.error) {
    return {
      ok: false,
      listingStatus: 'error',
      platformItemId,
      errorCode: mapShopeeError(raw.error || raw.result?.error || ''),
      errorMsg: raw.message || raw.result?.message || raw.error || 'global_item_info failed',
      rawResponse: raw,
    };
  }

  // Response: { ok, region, global_item_id_list, result: { response: { global_item_list: [...] } } }
  const itemList: any[] = raw.result?.response?.global_item_list || [];
  const item = itemList[0];
  if (!item) {
    return {
      ok: false,
      listingStatus: 'not_listed',
      platformItemId,
      errorCode: 'PLATFORM_NOT_FOUND',
      errorMsg: 'global_item_info returned empty item list',
      rawResponse: raw,
    };
  }

  const listingStatus = mapShopeeItemStatus(item.item_status);
  return {
    ok: true,
    listingStatus,
    platformItemId: String(item.global_item_id || platformItemId),
    rawResponse: raw,
  };
}

// ---------------------------------------------------------------------------
// Exported adapter
// ---------------------------------------------------------------------------
export const shopeeAdapter: PlatformAdapter = {
  // Capabilities this adapter handles. Gate 3 (docs_ready) already refuses
  // update_price_qty and update_variant_inventory before we're invoked.
  // activate_listing is explicitly unsupported (Shopee auto-activates).
  supports: new Set([
    'create_listing',
    'create_listing_multi_region',
    'update_metadata',
    'update_images',
    'sync',
  ]),

  async execute(ctx: AdapterContext): Promise<AdapterResult> {
    const sctx = ctx as ShopeeAdapterContext;

    switch (ctx.capability) {
      case 'create_listing':
        return handleCreateListing(sctx);
      case 'create_listing_multi_region':
        return handleCreateListingMultiRegion(sctx);
      case 'update_metadata':
        return handleUpdateMetadata(sctx);
      case 'update_images':
        return handleUpdateImages(sctx);
      case 'sync':
        return handleSync(sctx);
      default:
        return {
          ok: false,
          listingStatus: 'not_listed',
          errorCode: 'CAPABILITY_UNSUPPORTED',
          errorMsg: `Shopee adapter does not support capability='${ctx.capability}'`,
        };
    }
  },
};
