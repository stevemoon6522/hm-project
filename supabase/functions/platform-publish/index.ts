// @ts-nocheck
// platform-publish — dispatcher Edge Function (D0 skeleton).
//
// Plan ref: platform-publish-dispatcher-plan.md v2
//   §A.1 endpoint contract
//   §A.2 pre-flight gates (8, in order)
//   §A.3 post-flight side effects
//   §B.1 frozen error_code enum
//   §B.2 capability matrix
//   §D0 scope
//
// Current invariants:
//   - Shopee/Joom/eBay route to concrete adapters; Qoo10 is explicitly blocked
//     until auth smoke passes; Alibaba routes to its adapter but is likewise
//     gated by auth_verified=false until the ICBU auth smoke passes.
//   - docs_ready gate (gate 3) runs BEFORE banned-shop + preflight gates.
//   - Qoo10 auth_verified gate (gate 4) enforced.
//   - Idempotency uses existing platform_listings rows plus atomic upsert RPC.
//   - Audit_log written unconditionally (§A.3 step 2).
//   - Alert dispatch conditional on ALERT_BOT_URL env (§A.3 step 3, Codex P0 #1).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { requireAuthenticatedUser, AUTH_CORS, extractBearerToken } from '../_shared/auth.ts';
import type { AdapterCapability, AdapterErrorCode, PlatformAdapter } from './_shared/contract.ts';
import { stubAdapter } from './adapters/stub.ts';
import { shopeeAdapter } from './adapters/shopee.ts';
import { joomAdapter } from './adapters/joom.ts';
import { ebayAdapter } from './adapters/ebay.ts';
import { qoo10Adapter } from './adapters/qoo10.ts';
import { alibabaAdapter } from './adapters/alibaba.ts';
import { shopifyAdapter } from './adapters/shopify.ts';

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------
const ADAPTERS: Record<string, PlatformAdapter> = {
  shopee: shopeeAdapter,
  joom: joomAdapter,
  ebay: ebayAdapter,
  qoo10: qoo10Adapter,
  alibaba: alibabaAdapter,
  shopify: shopifyAdapter,
};
function pickAdapter(platform: string): PlatformAdapter {
  return ADAPTERS[platform] ?? stubAdapter;
}

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ALERT_BOT_URL = Deno.env.get('ALERT_BOT_URL') || ''; // optional; absent in D0
const ALERT_HMAC_SECRET = (Deno as any)['env']['get']('ALERT_HMAC_SECRET') || ''; // optional; absent in D0

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const VALID_PLATFORMS = new Set(['shopee', 'joom', 'qoo10', 'ebay', 'alibaba', 'shopify']);
const QOO10_GOODS_CATEGORY_ID = '300002855';
const PRODUCT_SELECT = 'id, sku, product_name, option_name, description, main_image, extra_images, sourcing_price, cost_krw, weight_g, inventory, lifecycle_state, product_group_id, variation_tier_names, variation_option_names, variation_tier_index, shopee_option_image_url, joom_product_id, joom_variant_id, joom_currency, joom_variant_grouping, ebay_category_id, qoo10_category_id, shopee_category_id, shopee_brand_id, shopee_brand_name, shopee_image_id, shopee_extra_image_ids, shopee_description, shopee_extra_attributes, shopee_days_to_ship, shopee_global_item_sku, shopee_global_model_sku';

// §A.2 gate 6: banned Shopee shop IDs.
// 1002269093 = legacy BR shop permanently banned 2026-05.
// [[project_shopee_br_shop_replaced]]
const BANNED_SHOPEE_SHOP_IDS = new Set(['1002269093']);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

// ASCII-only check for SKU (plan §A.2 gate 7 first bullet).
function isAsciiOnly(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]+$/.test(s);
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...AUTH_CORS, 'Content-Type': 'application/json' },
  });
}

function audit(event: string, extra: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ service: 'platform-publish', event, ts: new Date().toISOString(), ...extra }),
  );
}

// ---------------------------------------------------------------------------
// Alert dispatch (§A.3 step 3, Codex P0 #1).
// Fire-and-forget with 2s timeout; never blocks the response.
// Only called when ALERT_BOT_URL env is set.
// Signs the request body with HMAC-SHA256 so alert-bot can validate origin.
// ---------------------------------------------------------------------------
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
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

function dispatchAlert(payload: Record<string, unknown>): void {
  if (!ALERT_BOT_URL) return;
  // P1 fix: fail-closed when ALERT_BOT_URL is set but ALERT_HMAC_SECRET is not.
  // Sending an unsigned POST would result in alert-bot returning 401 silently,
  // dropping every alert. If only one of the two env vars is set, the operator
  // has misconfigured the deployment — skip dispatch and log a warning.
  if (!ALERT_HMAC_SECRET) {
    console.warn(JSON.stringify({
      service: 'platform-publish',
      event: 'alert_dispatch_skipped',
      reason: 'ALERT_BOT_URL is set but ALERT_HMAC_SECRET is missing — fix env config',
      ts: new Date().toISOString(),
    }));
    return;
  }
  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  (async () => {
    try {
      const sig = await hmacSha256Hex(ALERT_HMAC_SECRET, body);
      await fetch(ALERT_BOT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Alert-Signature': sig },
        body,
        signal: controller.signal,
      });
    } catch {
      // swallow — alert failure must never affect the response
    } finally {
      clearTimeout(timer);
    }
  })();
}

function shouldClearRemoteMissingMapping(capability: AdapterCapability, adapterResult: any): boolean {
  return capability === 'sync'
    && adapterResult?.listingStatus === 'not_listed'
    && (adapterResult?.errorCode === 'PLATFORM_NOT_FOUND' || adapterResult?.ok === true);
}

function platformListingMappingStatus(adapterResult: any): 'mapped' | 'needs_review' | 'unmatched' | 'mapping_failed' {
  const status = String(adapterResult?.listingStatus || '').toLowerCase();
  if (!adapterResult?.ok) return 'mapping_failed';
  if (status === 'listed' || status === 'paused') return 'mapped';
  if (status === 'pending' || status === 'draft') return 'needs_review';
  if (status === 'not_listed') return 'unmatched';
  if (status === 'rejected' || status === 'error' || status === 'banned') return 'mapping_failed';
  return 'needs_review';
}

function platformLookupShopId(platform: string, raw: any, fallback: string | undefined): string | null {
  if (platform === 'shopify') return String(raw?.shop_domain || fallback || '').trim() || null;
  return fallback ?? null;
}

async function clearRemoteMissingMapping(
  svc: any,
  args: {
    masterProductId: string;
    platform: string;
    shopId?: string;
    country?: string;
    publishRequestId: string;
    capability: AdapterCapability;
    adapterResult: any;
  },
): Promise<string | null> {
  const now = new Date().toISOString();
  const errorMsg = args.adapterResult?.errorMsg || 'Remote listing was not found during platform sync';
  const errorCode = args.adapterResult?.errorCode || 'PLATFORM_NOT_FOUND';
  const payload = {
    capability: args.capability,
    remote_missing: true,
    raw_response: args.adapterResult?.rawResponse || null,
  };

  const updatePayload: Record<string, unknown> = {
    listing_status: 'not_listed',
    mapping_status: 'unmatched',
    last_publish_request_id: args.publishRequestId,
    last_payload: payload,
    last_sync_at: now,
    last_seen_at: now,
    error_msg: errorMsg,
    error_code: errorCode,
    deleted_at: now,
    updated_at: now,
  };

  let q = svc
    .from('platform_listings')
    .update(updatePayload)
    .eq('master_product_id', args.masterProductId)
    .eq('platform', args.platform)
    .is('deleted_at', null)
    .select('id');
  if (args.shopId) q = q.eq('shop_id', args.shopId);
  else q = q.is('shop_id', null);
  if (args.country) q = q.eq('country', args.country);
  else q = q.is('country', null);

  const { data, error } = await q;
  if (error) {
    audit('remote_missing_clear_failed', { platform: args.platform, error: error.message });
  }

  if (args.platform === 'joom') {
    const { error: joomErr } = await svc
      .from('products')
      .update({
        joom_product_id: null,
        joom_variant_id: null,
        joom_status: 'archived',
        joom_mapping_status: null,
        joom_mapping_error: errorMsg,
        joom_published_at: null,
        joom_last_synced_at: now,
        joom_last_synced_price: null,
      })
      .eq('id', args.masterProductId);
    if (joomErr) audit('joom_legacy_clear_failed', { error: joomErr.message });
  }

  return Array.isArray(data) && data[0]?.id ? String(data[0].id) : null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: AUTH_CORS });
  }
  if (req.method !== 'POST') {
    return jsonResp(405, { ok: false, error: 'method_not_allowed' });
  }

  // =========================================================================
  // GATE 1: Auth — requireAuthenticatedUser (plan §A.2 step 1)
  // =========================================================================
  const authResult = await requireAuthenticatedUser(req, { allowGatewayVerifiedServiceRole: true });
  if (authResult.response) {
    audit('auth_rejected');
    return authResult.response;
  }
  const user = authResult.user;
  const actorLabel = `user:${user.email || user.id}`;

  // =========================================================================
  // GATE 2: Input validation (plan §A.2 step 2)
  // =========================================================================
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    audit('env_missing');
    return jsonResp(500, { ok: false, error: 'INPUT_INVALID', message: 'Server misconfigured' });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResp(400, { ok: false, error: 'INPUT_INVALID', message: 'Request body must be JSON' });
  }

  const platform = String(body.platform || '').toLowerCase();
  if (!VALID_PLATFORMS.has(platform)) {
    return jsonResp(400, {
      ok: false,
      error: 'INPUT_INVALID',
      message: `platform must be one of: ${[...VALID_PLATFORMS].join(', ')}`,
    });
  }

  const master_product_id = body.master_product_id as string;
  if (!isUuid(master_product_id)) {
    return jsonResp(400, {
      ok: false,
      error: 'INPUT_INVALID',
      message: 'master_product_id must be a valid UUID',
    });
  }

  // publish_request_id: auto-generate if absent; validate if provided.
  let publish_request_id: string;
  if (body.publish_request_id != null) {
    if (!isUuid(body.publish_request_id)) {
      return jsonResp(400, {
        ok: false,
        error: 'INPUT_INVALID',
        message: 'publish_request_id must be a valid UUID when provided',
      });
    }
    publish_request_id = body.publish_request_id as string;
  } else {
    publish_request_id = crypto.randomUUID();
  }

  // Capability: default to 'create_listing' when absent.
  const VALID_CAPABILITIES: AdapterCapability[] = [
    'create_listing', 'create_listing_multi_region', 'activate_listing', 'update_metadata',
    'update_price_qty', 'update_images', 'update_variant_inventory', 'sync',
  ];
  const rawCapability = body.capability as string | undefined;
  const capability: AdapterCapability =
    rawCapability && VALID_CAPABILITIES.includes(rawCapability as AdapterCapability)
      ? (rawCapability as AdapterCapability)
      : 'create_listing';

  const shop_id = body.shop_id ? String(body.shop_id) : undefined;
  const country = body.country ? String(body.country) : undefined;
  const dry_run = body.dry_run === true;

  // create_listing_multi_region: extract regions[] and optional lifecycle_state from body.
  // regions defaults to all 6 operating regions when omitted.
  const regions: string[] = Array.isArray(body.regions)
    ? (body.regions as string[]).map((r) => String(r).toUpperCase()).filter(Boolean)
    : [];
  const lifecycle_state: string | undefined = body.lifecycle_state ? String(body.lifecycle_state) : undefined;

  // =========================================================================
  // Service-role DB client (used for all mutating ops throughout)
  // =========================================================================
  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // =========================================================================
  // GATE 3: docs_ready check (plan §A.2 step 3)
  // Runs BEFORE banned-shop and master-data gates — no info leakage.
  // =========================================================================
  const { data: capRow, error: capErr } = await svc
    .from('platform_capabilities')
    .select('docs_ready, auth_verified')
    .eq('platform', platform)
    .eq('capability', capability)
    .maybeSingle();

  if (capErr) {
    audit('capability_check_error', { platform, capability, error: capErr.message });
    return jsonResp(500, {
      ok: false,
      publish_request_id,
      error_code: 'INPUT_INVALID',
      error_msg: 'Failed to check platform capabilities',
    });
  }

  if (!capRow || !capRow.docs_ready) {
    audit('docs_not_ready', { platform, capability });
    // Write audit_log row even for early refusals (§A.3 step 2 is unconditional).
    await writeAuditLog(svc, {
      entity_uuid: master_product_id,
      actor: actorLabel,
      action: 'publish',
      after_json: { platform, capability, listing_status: 'not_listed', error_code: 'DOCS_NOT_READY' },
      batch_id: publish_request_id,
    });
    return jsonResp(200, {
      ok: false,
      publish_request_id,
      platform_listing_id: null,
      platform_item_id: null,
      listing_status: 'not_listed',
      error_code: 'DOCS_NOT_READY',
      error_msg: `docs_ready=false for (platform='${platform}', capability='${capability}')`,
    });
  }

  // =========================================================================
  // GATE 4: auth_verified check (plan §A.2 step 4, Codex P2 #5)
  // Qoo10 and Alibaba both stay auth_verified=false until an operator runs a
  // platform auth smoke test and flips the flag (plans/alibaba-deep-lemon.md §5).
  // =========================================================================
  const AUTH_VERIFIED_GATED = new Set(['qoo10', 'alibaba', 'shopify']);
  if (AUTH_VERIFIED_GATED.has(platform) && !capRow.auth_verified) {
    audit('auth_not_verified', { platform, capability });
    await writeAuditLog(svc, {
      entity_uuid: master_product_id,
      actor: actorLabel,
      action: 'publish',
      after_json: { platform, capability, listing_status: 'not_listed', error_code: 'AUTH_NOT_VERIFIED' },
      batch_id: publish_request_id,
    });
    const smokeHint = platform === 'qoo10'
      ? 'run GetCatagoryListAll smoke test to flip the flag'
      : 'run an ICBU auth smoke call (e.g. product.status.get.v2) to flip the flag';
    return jsonResp(200, {
      ok: false,
      publish_request_id,
      platform_listing_id: null,
      platform_item_id: null,
      listing_status: 'not_listed',
      error_code: 'AUTH_NOT_VERIFIED',
      error_msg: `${platform} auth_verified=false; ${smokeHint}`,
    });
  }

  // =========================================================================
  // GATE 5: Idempotency + platform_listings row lookup (plan §A.2 step 5, §A.4)
  // The unique index uses coalesce(shop_id,'') so we match with a raw RPC.
  //
  // Idempotent replay check: read-only. The serialization point is the
  // upsert RPC at post-flight time (INSERT ... ON CONFLICT atomic). Two
  // concurrent calls with the same publish_request_id will both read the
  // same prior row OR both reach the adapter; the second's upsert is a
  // no-op (request_id matches existing). The adapter may run twice but
  // idempotency on the platform side (Shopee publish_request_id, Joom
  // PATCH semantics, etc.) keeps that safe. No FOR UPDATE here.
  // =========================================================================
  // Fetch existing listing using coalesce-aware SQL so null shop_id/country
  // matches the expression index correctly.
  let existingListing: Record<string, unknown> | null = null;
  {
    const { data: rows } = await svc.rpc('select_platform_listing_for_update', {
      p_master_product_id: master_product_id,
      p_platform: platform,
      p_shop_id: platformLookupShopId(platform, raw, shop_id),
      p_country: country ?? null,
    });
    if (rows && rows.length > 0) {
      existingListing = rows[0];
    } else {
      // Fallback plain select (RPC may not exist until a separate migration adds it).
      const q = svc
        .from('platform_listings')
        .select('*')
        .eq('master_product_id', master_product_id)
        .eq('platform', platform)
        .is('deleted_at', null);
      // Match shop_id/country with null awareness
      if (shop_id) q.eq('shop_id', shop_id); else q.is('shop_id', null);
      if (country) q.eq('country', country); else q.is('country', null);
      const { data: fallback } = await q.maybeSingle();
      existingListing = fallback ?? null;
    }
  }

  // Idempotency replay: same publish_request_id → return cached result.
  if (
    existingListing &&
    existingListing.last_publish_request_id === publish_request_id
  ) {
    audit('idempotent_replay', { publish_request_id });
    return jsonResp(200, {
      ok: existingListing.listing_status === 'listed',
      publish_request_id,
      platform_listing_id: existingListing.id,
      platform_item_id: existingListing.platform_item_id ?? null,
      listing_status: existingListing.listing_status,
      error_code: 'IDEMPOTENT_REPLAY',
      error_msg: 'Idempotent replay — returning cached result for this publish_request_id',
    });
  }

  // Codex P0 (code review): multi-region idempotency. The single-row
  // existingListing lookup above keys on (shop_id, country) which is null for
  // create_listing_multi_region requests, so it misses the per-region rows the
  // adapter writes. Fan out the replay check across all requested regions:
  // if every requested region already has a row with this publish_request_id
  // and a terminal status, short-circuit instead of re-calling Shopee.
  if (capability === 'create_listing_multi_region') {
    const requestedRegions = Array.isArray((body as any).regions)
      ? ((body as any).regions as unknown[]).map((r) => String(r).toUpperCase()).filter(Boolean)
      : [];
    if (requestedRegions.length > 0) {
      const { data: regionRows } = await svc
        .from('platform_listings')
        .select('country, last_publish_request_id, listing_status')
        .eq('master_product_id', master_product_id)
        .eq('platform', 'shopee')
        .in('country', requestedRegions)
        .is('deleted_at', null);
      const rows = regionRows || [];
      const allMatch =
        rows.length >= requestedRegions.length &&
        rows.every(
          (r: Record<string, unknown>) => r.last_publish_request_id === publish_request_id,
        );
      if (allMatch) {
        audit('idempotent_replay_multi_region', { publish_request_id, regions: requestedRegions });
        const successCount = rows.filter(
          (r: Record<string, unknown>) => r.listing_status === 'listed',
        ).length;
        return jsonResp(200, {
          ok: successCount === requestedRegions.length,
          publish_request_id,
          platform_listing_id: null,
          platform_item_id: null,
          listing_status: successCount === requestedRegions.length ? 'listed' : 'partial',
          error_code: 'IDEMPOTENT_REPLAY',
          error_msg: 'Idempotent replay (multi-region) — all requested regions already processed with this publish_request_id',
          regions_summary: rows,
        });
      }
    }
  }

  // =========================================================================
  // GATE 6: Banned shop check (plan §A.2 step 6)
  // Runs AFTER docs_ready + auth_verified so we don't leak banned-shop status
  // via non-doc-ready code paths.
  // =========================================================================
  if (platform === 'shopee' && shop_id && BANNED_SHOPEE_SHOP_IDS.has(shop_id)) {
    audit('banned_shop', { shop_id });
    await writeAuditLog(svc, {
      entity_uuid: master_product_id,
      actor: actorLabel,
      action: 'publish',
      after_json: { platform, capability, listing_status: 'banned', error_code: 'BANNED_SHOP' },
      batch_id: publish_request_id,
    });
    return jsonResp(200, {
      ok: false,
      publish_request_id,
      platform_listing_id: existingListing?.id ?? null,
      platform_item_id: null,
      listing_status: 'banned',
      error_code: 'BANNED_SHOP',
      error_msg: `shop_id='${shop_id}' is permanently banned and cannot be used`,
    });
  }

  // =========================================================================
  // GATE 7: Master-data preflight (plan §A.2 step 7)
  // Fetch the master product row first.
  // =========================================================================
  const { data: product, error: productErr } = await svc
    .from('products')
    .select(PRODUCT_SELECT)
    .eq('id', master_product_id)
    .maybeSingle();

  if (productErr || !product) {
    return jsonResp(400, {
      ok: false,
      publish_request_id,
      platform_listing_id: null,
      platform_item_id: null,
      listing_status: 'not_listed',
      error_code: 'INPUT_INVALID',
      error_msg: `master_product_id='${master_product_id}' not found`,
    });
  }

  let groupProducts: any[] = [];
  if ((capability === 'create_listing' || capability === 'create_listing_multi_region') && product.product_group_id) {
    const { data: groupRows, error: groupErr } = await svc
      .from('products')
      .select(PRODUCT_SELECT)
      .eq('product_group_id', product.product_group_id)
      .order('sku', { ascending: true });
    if (groupErr) {
      audit('group_products_fetch_failed', { product_group_id: product.product_group_id, error: groupErr.message });
    } else {
      groupProducts = Array.isArray(groupRows) ? groupRows : [];
    }
  }

  // SKU_ASCII_ONLY — all platforms.
  if (!isAsciiOnly(product.sku)) {
    audit('sku_not_ascii', { sku: product.sku });
    await writeAuditLog(svc, {
      entity_uuid: master_product_id,
      actor: actorLabel,
      action: 'publish',
      after_json: { platform, capability, listing_status: 'not_listed', error_code: 'SKU_ASCII_ONLY' },
      batch_id: publish_request_id,
    });
    return jsonResp(200, {
      ok: false,
      publish_request_id,
      platform_listing_id: existingListing?.id ?? null,
      platform_item_id: null,
      listing_status: 'not_listed',
      error_code: 'SKU_ASCII_ONLY',
      error_msg: `products.sku='${product.sku}' contains non-ASCII characters`,
    });
  }

  // QOO10_CATEGORY_UNMAPPED — Qoo10 only, for create_listing.
  const qoo10Input = (body as any).qoo10 || {};
  const qoo10GoodsDefault = String(product.product_kind || '').trim().toLowerCase() === 'goods' ? QOO10_GOODS_CATEGORY_ID : '';
  const qoo10CategoryId = qoo10Input.category_id || product.qoo10_category_id || qoo10GoodsDefault;
  if (platform === 'qoo10' && capability === 'create_listing' && !qoo10CategoryId) {
    audit('qoo10_category_unmapped', { sku: product.sku });
    await writeAuditLog(svc, {
      entity_uuid: master_product_id,
      actor: actorLabel,
      action: 'publish',
      after_json: { platform, capability, listing_status: 'not_listed', error_code: 'QOO10_CATEGORY_UNMAPPED' },
      batch_id: publish_request_id,
    });
    return jsonResp(200, {
      ok: false,
      publish_request_id,
      platform_listing_id: existingListing?.id ?? null,
      platform_item_id: null,
      listing_status: 'not_listed',
      error_code: 'QOO10_CATEGORY_UNMAPPED',
      error_msg: 'products.qoo10_category_id is null; set a 9-digit Qoo10 SecondSubCat code first',
    });
  }

  // OFFER_PUBLISH_OUT_OF_SCOPE — eBay activate_listing is explicitly refused.
  if (platform === 'ebay' && capability === 'activate_listing') {
    audit('ebay_offer_publish_oos', { sku: product.sku });
    await writeAuditLog(svc, {
      entity_uuid: master_product_id,
      actor: actorLabel,
      action: 'publish',
      after_json: { platform, capability, listing_status: 'not_listed', error_code: 'OFFER_PUBLISH_OUT_OF_SCOPE' },
      batch_id: publish_request_id,
    });
    return jsonResp(200, {
      ok: false,
      publish_request_id,
      platform_listing_id: existingListing?.id ?? null,
      platform_item_id: null,
      listing_status: 'not_listed',
      error_code: 'OFFER_PUBLISH_OUT_OF_SCOPE',
      error_msg: 'eBay Offer publish is out of scope; listings top out at draft state',
    });
  }

  // SHOPEE create_listing_multi_region preflight — gate 7 Shopee-specific checks.
  // These run in the dispatcher so errors are reported before the adapter is invoked,
  // giving the same structured error response format as other gates.
  // The adapter also re-checks these fields as defense-in-depth.
  if (platform === 'shopee' && capability === 'create_listing_multi_region') {
    if (!product.shopee_category_id) {
      audit('shopee_category_missing', { sku: product.sku });
      await writeAuditLog(svc, {
        entity_uuid: master_product_id,
        actor: actorLabel,
        action: 'publish',
        after_json: { platform, capability, listing_status: 'not_listed', error_code: 'SHOPEE_CATEGORY_MISSING' },
        batch_id: publish_request_id,
      });
      return jsonResp(200, {
        ok: false,
        publish_request_id,
        platform_listing_id: existingListing?.id ?? null,
        platform_item_id: null,
        listing_status: 'not_listed',
        error_code: 'SHOPEE_CATEGORY_MISSING',
        error_msg: 'shopee_category_id가 설정되지 않았습니다. Shopee 카테고리를 먼저 지정해 주세요.',
      });
    }
    if (!product.shopee_image_id && !product.main_image) {
      audit('shopee_image_missing', { sku: product.sku });
      await writeAuditLog(svc, {
        entity_uuid: master_product_id,
        actor: actorLabel,
        action: 'publish',
        after_json: { platform, capability, listing_status: 'not_listed', error_code: 'SHOPEE_IMAGE_MISSING' },
        batch_id: publish_request_id,
      });
      return jsonResp(200, {
        ok: false,
        publish_request_id,
        platform_listing_id: existingListing?.id ?? null,
        platform_item_id: null,
        listing_status: 'not_listed',
        error_code: 'SHOPEE_IMAGE_MISSING',
        error_msg: 'shopee_image_id와 main_image가 모두 없습니다. 이미지를 먼저 등록해 주세요.',
      });
    }
    if (product.shopee_brand_id == null) {
      audit('shopee_brand_missing', { sku: product.sku });
      await writeAuditLog(svc, {
        entity_uuid: master_product_id,
        actor: actorLabel,
        action: 'publish',
        after_json: { platform, capability, listing_status: 'not_listed', error_code: 'SHOPEE_BRAND_MISSING' },
        batch_id: publish_request_id,
      });
      return jsonResp(200, {
        ok: false,
        publish_request_id,
        platform_listing_id: existingListing?.id ?? null,
        platform_item_id: null,
        listing_status: 'not_listed',
        error_code: 'SHOPEE_BRAND_MISSING',
        error_msg: 'shopee_brand_id가 설정되지 않았습니다.',
      });
    }
    // Codex P1-2 (revision): explicit master-data sanity checks before adapter call.
    // Without these, malformed master rows reach the adapter and fail with vague messages.
    const _shopee_cost = Number(product.cost_krw);
    if (!_shopee_cost || _shopee_cost <= 0) {
      audit('shopee_cost_krw_invalid', { sku: product.sku, cost_krw: product.cost_krw });
      return jsonResp(200, {
        ok: false,
        publish_request_id,
        platform_listing_id: existingListing?.id ?? null,
        platform_item_id: null,
        listing_status: 'not_listed',
        error_code: 'SHOPEE_COST_KRW_INVALID',
        error_msg: '매입가(cost_krw)가 0 이하입니다. 가격을 먼저 설정해 주세요.',
      });
    }
    const _shopee_weight = Number(product.weight_g);
    if (!_shopee_weight || _shopee_weight <= 0) {
      audit('shopee_weight_missing', { sku: product.sku, weight_g: product.weight_g });
      return jsonResp(200, {
        ok: false,
        publish_request_id,
        platform_listing_id: existingListing?.id ?? null,
        platform_item_id: null,
        listing_status: 'not_listed',
        error_code: 'SHOPEE_WEIGHT_MISSING',
        error_msg: '상품 무게(weight_g)가 0 이하입니다. 무게를 먼저 입력해 주세요.',
      });
    }
    const _shopee_lifecycle = product.lifecycle_state;
    if (!['ready_stock', 'pre_order'].includes(_shopee_lifecycle)) {
      audit('shopee_lifecycle_invalid', { sku: product.sku, lifecycle_state: _shopee_lifecycle });
      return jsonResp(200, {
        ok: false,
        publish_request_id,
        platform_listing_id: existingListing?.id ?? null,
        platform_item_id: null,
        listing_status: 'not_listed',
        error_code: 'SHOPEE_LIFECYCLE_INVALID',
        error_msg: `lifecycle_state가 잘못되었습니다 (${_shopee_lifecycle}). ready_stock 또는 pre_order만 허용됩니다.`,
      });
    }
  }

  // Alibaba create_listing: the ICBU docs make category / attributes / shipping
  // template OPTIONAL (category is AI-predicted when omitted; shipping template
  // is only required for RTS products). The minimum (title + image + price) is
  // validated inside adapters/alibaba.ts, which returns PLATFORM_VALIDATION_ERROR
  // with field-specific messages. No dispatcher-level hard gate here.

  // D5 gate (eBay aspects) — stubbed to pass in D0; populated by adapter in D5.

  // =========================================================================
  // GATE 8: Adapter dispatch
  // Shopee/Joom/eBay/Alibaba route to concrete adapters; Qoo10/Alibaba return
  // AUTH_NOT_VERIFIED before dispatch until their auth smoke flips the flag.
  // =========================================================================
  const adapter = pickAdapter(platform);

  // Extract the user's raw Bearer token so we can forward it to shopee-bridge.
  // shopee-bridge requires role='authenticated' JWT for mutating actions
  // (bridge index.ts:1652-1658). The service-role key would fail that check.
  // We inject it as ctx.userAuthToken; the Shopee adapter reads it.
  const userAuthToken = extractBearerToken(req) || '';

  let adapterResult;
  if (!adapter.supports.has(capability)) {
    // Adapter doesn't support this capability — no API call.
    adapterResult = {
      ok: false,
      listingStatus: 'not_listed' as const,
      errorCode: 'CAPABILITY_UNSUPPORTED' as const,
      errorMsg: `${platform} adapter does not support capability='${capability}'`,
    };
  } else {
    try {
      adapterResult = await adapter.execute({
        masterProduct: product,
        groupProducts,
        shopId: shop_id,
        country,
        capability,
        dryRun: dry_run,
        publishRequestId: publish_request_id,
        platformItemId: existingListing?.platform_item_id as string | undefined,
        // Extra: user JWT forwarded for shopee-bridge auth (D2).
        // Not in the frozen AdapterContext type but passed via object spread;
        // the Shopee adapter casts ctx to ShopeeAdapterContext to read it.
        userAuthToken,
        // create_listing_multi_region extras (Phase A).
        regions,
        lifecycle_state,
        // Phase B per-region image_ids — caller uploads one image per region
        // (KRSC requires images live in the target region's image space) and
        // BR needs at least 2 images. Adapter passes through to bridge.
        region_image_ids: (body as any).region_image_ids || {},
        region_prices: (body as any).region_prices || {},
        account_key: (body as any).account_key || (body as any).accountKey || '',
        global_item_id: (body as any).global_item_id || (body as any).globalItemId || undefined,
        existing_global_item_id: (body as any).existing_global_item_id || (body as any).existingGlobalItemId || undefined,
        publish_existing_global_only: (body as any).publish_existing_global_only === true,
        shopee_description: (body as any).shopee_description || '',
        shopee_product_name: (body as any).shopee_product_name || '',
        stock_override: (body as any).stock_override,
        registration_kind: (body as any).registration_kind || '',
        // Qoo10 create_listing extras supplied by the V2 registration modal.
        qoo10: (body as any).qoo10 || {},
        // Alibaba create_listing extras supplied by the V2 registration modal.
        alibaba: (body as any).alibaba || {},
        // Shopify create_listing extras supplied by the V2 registration modal.
        shopify: (body as any).shopify || {},
      } as any);
    } catch (e) {
      adapterResult = {
        ok: false,
        listingStatus: 'error' as const,
        errorCode: 'PLATFORM_UNKNOWN' as const,
        errorMsg: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // =========================================================================
  // POST-FLIGHT §A.3 step 1: Upsert platform_listings row via RPC.
  // Uses upsert_platform_listing() which handles coalesce(shop_id,'')
  // expression index correctly.
  // =========================================================================
  let listingId: string | null = existingListing?.id as string ?? null;

  if (!dry_run) {
    const shouldClearMissing = shouldClearRemoteMissingMapping(capability, adapterResult);
    const shouldAbsorbLookup = !shouldClearMissing && adapterResult.ok && capability === 'sync' && ['joom', 'qoo10', 'ebay', 'shopify'].includes(platform);
    const raw = adapterResult.rawResponse || {};
    let rpcName = 'upsert_platform_listing';
    let rpcArgs: Record<string, unknown> = {
      p_master_product_id: master_product_id,
      p_platform: platform,
      p_shop_id: platformLookupShopId(platform, raw, shop_id),
      p_country: country ?? null,
      p_platform_item_id: adapterResult.platformItemId ?? existingListing?.platform_item_id ?? null,
      p_listing_status: adapterResult.listingStatus,
      p_last_publish_request_id: publish_request_id,
      p_last_payload: { capability, dry_run, ...(platform === 'shopee' ? { account_key: (body as any).account_key || (body as any).accountKey || null } : {}) },
      p_last_sync_at: new Date().toISOString(),
      p_error_msg: adapterResult.errorMsg ?? null,
      p_error_code: adapterResult.errorCode ?? null,
    };
    if (shouldAbsorbLookup) {
      rpcName = 'absorb_platform_sku_lookup';
      const offer = Array.isArray(raw.offers)
        ? raw.offers.find((row: any) => row?.listingId || row?.offerId || row?.legacyVariantId || row?.sku)
        : null;
      rpcArgs = {
        p_master_product_id: master_product_id,
        p_platform: platform,
        p_external_sku: platform === 'shopify' ? (raw.sku || product.sku) : product.sku,
        p_platform_item_id: adapterResult.platformItemId ?? raw.joom_product_id ?? raw.platform_item_id ?? raw.verification?.listing_id ?? null,
        p_external_variant_id: raw.joom_variant_id ?? raw.variant_id ?? offer?.offerId ?? offer?.legacyVariantId ?? offer?.sku ?? null,
        p_country: country ?? null,
        p_shop_id: platformLookupShopId(platform, raw, shop_id),
        p_listing_status: adapterResult.listingStatus,
        p_raw_payload: raw,
      };
    }
    if (shouldClearMissing) {
      const clearedId = await clearRemoteMissingMapping(svc, {
        masterProductId: master_product_id,
        platform,
        shopId: shop_id,
        country,
        publishRequestId: publish_request_id,
        capability,
        adapterResult,
      });
      if (clearedId) listingId = clearedId;
    } else {
      const { data: upsertedId, error: upsertErr } = await svc.rpc(rpcName, rpcArgs);

      if (upsertErr) {
        audit('listing_upsert_failed', { error: upsertErr.message });
        // Non-fatal: continue with audit + response.
      } else if (upsertedId) {
        listingId = upsertedId;
        const nextMappingStatus = platformListingMappingStatus(adapterResult);
        const { error: mappingErr } = await svc
          .from('platform_listings')
          .update({ mapping_status: nextMappingStatus, updated_at: new Date().toISOString() })
          .eq('id', upsertedId);
        if (mappingErr) audit('listing_mapping_status_update_failed', { error: mappingErr.message, mapping_status: nextMappingStatus });
      }
    }

    // Grouped create flows create one marketplace listing with several option
    // SKUs. Mirror that parent listing into each option product so rollups and
    // follow-up syncs can address the individual SKU rows.
    if (adapterResult.ok && ['qoo10', 'joom', 'ebay', 'shopify'].includes(platform) && capability === 'create_listing') {
      const optionProducts = Array.isArray((raw as any).option_products) ? (raw as any).option_products : [];
      for (const option of optionProducts) {
        const optionProductId = String(option?.product_id || '').trim();
        const optionSku = String(option?.sku || '').trim();
        if (!optionProductId || !optionSku) continue;
        const { error: absorbErr } = await svc.rpc('absorb_platform_sku_lookup', {
          p_master_product_id: optionProductId,
          p_platform: platform,
          p_external_sku: optionSku,
          p_platform_item_id: adapterResult.platformItemId ?? (raw as any).platform_item_id ?? null,
          p_external_variant_id: option?.variant_id ?? option?.option_code ?? option?.offer_id ?? optionSku,
          p_country: country ?? null,
          p_shop_id: shop_id ?? null,
          p_listing_status: adapterResult.listingStatus,
          p_raw_payload: { capability, publish_request_id, platform_item_id: adapterResult.platformItemId, option },
        });
        if (absorbErr) audit('group_option_absorb_failed', { platform, product_id: optionProductId, sku: optionSku, error: absorbErr.message });
      }
    }
  }

  // =========================================================================
  // POST-FLIGHT §A.3 step 2: Write audit_log (unconditional, even on failure).
  // =========================================================================
  await writeAuditLog(svc, {
    entity_uuid: master_product_id,
    actor: actorLabel,
    action: adapterResult.ok ? 'publish' : 'sync',
    after_json: {
      platform,
      capability,
      listing_status: adapterResult.listingStatus,
      error_code: adapterResult.errorCode ?? null,
      publish_request_id,
      dry_run,
    },
    batch_id: publish_request_id,
  });

  // =========================================================================
  // POST-FLIGHT §A.3 step 3: Alert on failure (conditional on ALERT_BOT_URL).
  // =========================================================================
  if (!adapterResult.ok && adapterResult.errorCode !== 'IDEMPOTENT_REPLAY') {
    dispatchAlert({
      entity_type: 'platform_listing',
      entity_uuid: listingId,
      error_code: adapterResult.errorCode,
      error_msg: adapterResult.errorMsg,
      platform,
      shop_id: shop_id ?? null,
      country: country ?? null,
      master_product_id,
      actor: actorLabel,
      publish_request_id,
    });
  }

  // =========================================================================
  // Response (§A.1)
  // =========================================================================
  return jsonResp(200, {
    ok: adapterResult.ok,
    publish_request_id,
    platform_listing_id: listingId,
    platform_item_id: adapterResult.platformItemId ?? null,
    listing_status: adapterResult.listingStatus,
    error_code: adapterResult.errorCode ?? null,
    error_msg: adapterResult.errorMsg ?? null,
    raw_response: adapterResult.rawResponse && dry_run
      ? JSON.stringify(adapterResult.rawResponse).slice(0, 2048)
      : null,
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function writeAuditLog(
  svc: ReturnType<typeof createClient>,
  params: {
    entity_uuid: string;
    actor: string;
    action: string;
    after_json: Record<string, unknown>;
    batch_id: string;
  },
): Promise<void> {
  const { error } = await svc.from('audit_log').insert({
    entity_type: 'platform_listing',
    entity_uuid: params.entity_uuid,
    actor: params.actor,
    action: params.action,
    after_json: params.after_json,
    reason: 'dispatcher_run',
    batch_id: params.batch_id,
  });
  if (error) {
    audit('audit_log_write_failed', { error: error.message });
  }
}
