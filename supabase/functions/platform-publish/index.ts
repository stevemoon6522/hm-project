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
// D0 invariants:
//   - All 5 platforms dispatch to stubAdapter → CAPABILITY_UNSUPPORTED.
//   - docs_ready gate (gate 3) runs BEFORE banned-shop + preflight gates.
//   - Qoo10 auth_verified gate (gate 4) enforced.
//   - Idempotency via SELECT … FOR UPDATE on platform_listings (gate 5).
//   - Audit_log written unconditionally (§A.3 step 2).
//   - Alert dispatch conditional on ALERT_BOT_URL env (§A.3 step 3, Codex P0 #1).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { requireAuthenticatedUser, AUTH_CORS, extractBearerToken } from '../_shared/auth.ts';
import type { AdapterCapability, AdapterErrorCode, PlatformAdapter } from './_shared/contract.ts';
import { stubAdapter } from './adapters/stub.ts';
import { shopeeAdapter } from './adapters/shopee.ts';

// ---------------------------------------------------------------------------
// Adapter registry (D2: Shopee wired; all others still stub)
// ---------------------------------------------------------------------------
const ADAPTERS: Record<string, PlatformAdapter> = {
  shopee: shopeeAdapter,
  // joom, qoo10, ebay, alibaba — still stub until D3-D6
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
const ALERT_HMAC_SECRET = Deno.env.get('ALERT_HMAC_SECRET') || ''; // optional; absent in D0

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const VALID_PLATFORMS = new Set(['shopee', 'joom', 'qoo10', 'ebay', 'alibaba']);

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
  const authResult = await requireAuthenticatedUser(req);
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
    'create_listing', 'activate_listing', 'update_metadata',
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
  // GATE 4: Qoo10 auth_verified check (plan §A.2 step 4, Codex P2 #5)
  // =========================================================================
  if (platform === 'qoo10' && !capRow.auth_verified) {
    audit('qoo10_auth_not_verified', { platform, capability });
    await writeAuditLog(svc, {
      entity_uuid: master_product_id,
      actor: actorLabel,
      action: 'publish',
      after_json: { platform, capability, listing_status: 'not_listed', error_code: 'AUTH_NOT_VERIFIED' },
      batch_id: publish_request_id,
    });
    return jsonResp(200, {
      ok: false,
      publish_request_id,
      platform_listing_id: null,
      platform_item_id: null,
      listing_status: 'not_listed',
      error_code: 'AUTH_NOT_VERIFIED',
      error_msg: 'Qoo10 auth_verified=false; run GetCatagoryListAll smoke test to flip the flag',
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
      p_shop_id: shop_id ?? null,
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
    .select('id, sku, product_name, description, main_image, extra_images, cost_krw, weight_g, joom_variant_grouping, ebay_category_id, qoo10_category_id')
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
  if (platform === 'qoo10' && capability === 'create_listing' && !product.qoo10_category_id) {
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

  // EBAY_CATEGORY_ID_MISSING — eBay only, for create_listing.
  if (platform === 'ebay' && capability === 'create_listing' && !product.ebay_category_id) {
    audit('ebay_category_missing', { sku: product.sku });
    await writeAuditLog(svc, {
      entity_uuid: master_product_id,
      actor: actorLabel,
      action: 'publish',
      after_json: { platform, capability, listing_status: 'not_listed', error_code: 'EBAY_CATEGORY_ID_MISSING' },
      batch_id: publish_request_id,
    });
    return jsonResp(200, {
      ok: false,
      publish_request_id,
      platform_listing_id: existingListing?.id ?? null,
      platform_item_id: null,
      listing_status: 'not_listed',
      error_code: 'EBAY_CATEGORY_ID_MISSING',
      error_msg: 'products.ebay_category_id is null; set an eBay Taxonomy category ID first',
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

  // D4/D5 gates (Alibaba attrs/shipping + eBay aspects) — stubbed to pass in D0.
  // They are populated by real adapter data in D4/D5.

  // =========================================================================
  // GATE 8: Adapter dispatch (plan §A.2 step 8)
  // D2: Shopee routes to shopeeAdapter; others still use stubAdapter.
  // pickAdapter() returns shopeeAdapter for platform='shopee', stubAdapter
  // for everything else.
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
    const { data: upsertedId, error: upsertErr } = await svc.rpc('upsert_platform_listing', {
      p_master_product_id: master_product_id,
      p_platform: platform,
      p_shop_id: shop_id ?? null,
      p_country: country ?? null,
      p_platform_item_id: adapterResult.platformItemId ?? existingListing?.platform_item_id ?? null,
      p_listing_status: adapterResult.listingStatus,
      p_last_publish_request_id: publish_request_id,
      p_last_payload: dry_run ? null : { capability, dry_run },
      p_last_sync_at: adapterResult.ok ? new Date().toISOString() : (existingListing?.last_sync_at ?? null),
      p_error_msg: adapterResult.errorMsg ?? null,
      p_error_code: adapterResult.errorCode ?? null,
    });

    if (upsertErr) {
      audit('listing_upsert_failed', { error: upsertErr.message });
      // Non-fatal: continue with audit + response.
    } else if (upsertedId) {
      listingId = upsertedId;
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
    raw_response: adapterResult.rawResponse
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
