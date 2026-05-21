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
  const price = (masterProduct as any).price ?? (masterProduct as any).global_price ?? (masterProduct as any).price_krw;
  const stock = (masterProduct as any).stock ?? (masterProduct as any).available_stock;
  if (price == null || stock == null) {
    return {
      ok: false,
      listingStatus: 'error',
      errorCode: 'PLATFORM_VALIDATION_ERROR',
      errorMsg: 'price/stock missing on master product — set price and stock before publishing (D2.5 pricing-rule TODO)',
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

  const payload: Record<string, unknown> = {
    region,
    name: masterProduct.product_name || masterProduct.sku,
    sku: masterProduct.sku,
    // category_id must be set on masterProduct or provided via shopee_listings;
    // dispatcher gate 7 does not yet check this for shopee. We'll pass null and
    // let shopee-bridge return a validation error (register_cbsc checks at index.ts:2120).
    category_id: (masterProduct as any).shopee_category_id ?? null,
    image_url: masterProduct.main_image || null,
    weight_g: masterProduct.weight_g || 100,
    days_to_ship: (masterProduct as any).days_to_ship ?? 2,
    price: Number(price),
    stock: Number(stock),
    targets: [{ region, shop_id: Number(shopId) }],
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

  // NOTE: weight is intentionally omitted here.
  // Sending weight on update_global_item overwrites child model weights too,
  // which breaks per-variant weight on multi-variation listings.
  // TODO: add a separate update_weight capability when needed.
  const payload: Record<string, unknown> = {
    region: region || 'SG',
    global_item_id: Number(platformItemId),
    global_item_name: masterProduct.product_name || undefined,
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
    'update_metadata',
    'update_images',
    'sync',
  ]),

  async execute(ctx: AdapterContext): Promise<AdapterResult> {
    const sctx = ctx as ShopeeAdapterContext;

    switch (ctx.capability) {
      case 'create_listing':
        return handleCreateListing(sctx);
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
