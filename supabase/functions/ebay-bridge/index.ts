// ebay-bridge — v1
// eBay Sell API integration for shopee-dashboard.
// Handles OAuth refresh, merchantLocation/policy bootstrap, and single-SKU listing publish.
// Pattern: mirrors joom-bridge (OAuth refresh + Supabase token table + endpoint orchestration).
//
// Endpoints:
//   GET  /healthz            — token ping
//   GET  /lookup-item?sku=   — GET inventory_item + offer for published SKU (post-publish verify)
//   POST /publish            — full listing orchestration (inventory_item → offer → publish)
//
// Codex Adversarial Round 2 BLOCKER resolutions:
//   §a: condition=NEW only, no conditionDescription/conditionDescriptors
//   §a: fulfillmentTime is NOT used (belongs to in-store pickup, not shipped listings)
//   §b: merchantLocation idempotent GET→create flow
//   §b: policy IDs persisted to ebay_policy_ids table per marketplace
//   §b: Business Policies assumed already active (operator confirmed in Operator Decisions #3)
//   §d: lookup-item verifies status=PUBLISHED + listing container present
// Operator Decisions:
//   #4: EAN field EXCLUDED from inventory_item PUT body
//   #6: description is operator-supplied (required field in /publish body)
//   #5: merchantLocationKey = STARONE-SUWON-B105; postalCode from EBAY_LOC_POSTAL_CODE env

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { AUTH_CORS, requireAuthenticatedUser } from "../_shared/auth.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EBAY_API   = "https://api.ebay.com";
const EBAY_OAUTH_ENDPOINT = (Deno as any)["env"]["get"]("EBAY_OAUTH_ENDPOINT") || `${EBAY_API}/identity/v1/oauth2/token`;

// Default merchantLocationKey — Operator Decision #5
const MERCHANT_LOCATION_KEY = "STARONE-SUWON-B105";

// eBay Inventory API required scopes (Authorization Code grant)
const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
].join(" ");

// Default listing duration for fixed-price: GTC (Good 'Til Cancelled)
// Codex review §d WARNING: listingDuration must be GTC
const LISTING_DURATION = "GTC";

const CORS: Record<string, string> = {
  ...AUTH_CORS,
  "Access-Control-Max-Age": "3600",
};

// @ts-ignore
const supabase = createClient(
  // @ts-ignore
  Deno.env.get("SUPABASE_URL")!,
  // @ts-ignore
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

async function getValidAccessToken(): Promise<string> {
  const { data, error } = await supabase
    .from("ebay_tokens")
    .select("access_token, refresh_token, expiry_time, client_id, client_secret")
    .eq("id", 1)
    .single();
  if (error || !data) throw new Error("ebay_tokens 조회 실패: " + (error?.message || "no row"));

  const now = Math.floor(Date.now() / 1000);
  if (data.expiry_time && now < data.expiry_time - 60) return data.access_token;

  // Refresh access token using stored refresh_token
  // Citation: authorization-guide.txt — Authorization Code Grant flow
  const credentials = btoa(`${data.client_id}:${data.client_secret}`);
  const r = await fetch(EBAY_OAUTH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: data.refresh_token,
      scope: EBAY_SCOPES,
    }),
  });

  if (!r.ok) {
    const errBody = await r.text();
    throw new Error(`eBay token refresh 실패 HTTP ${r.status}: ${errBody}`);
  }

  const j = await r.json();
  if (j.error) throw new Error("eBay token refresh 오류: " + j.error_description || j.error);

  const newExpiry = now + (j.expires_in || 7200);
  await supabase.from("ebay_tokens").update({
    access_token: j.access_token,
    expiry_time: newExpiry,
    updated_at: new Date().toISOString(),
  }).eq("id", 1);

  return j.access_token;
}

// ---------------------------------------------------------------------------
// eBay API fetch helper
// ---------------------------------------------------------------------------

// All Inventory write calls require Content-Language: en-US
// Citation: sell/inventory.yaml L733-743 (grill-with-docs Revision §1)
async function ebayFetch(
  path: string,
  init: RequestInit = {},
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const token = await getValidAccessToken();
  const url = path.startsWith("http") ? path : `${EBAY_API}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> || {}),
      "Authorization": `Bearer ${token}`,
      "Content-Language": "en-US",  // required for all inventory writes
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...extraHeaders,
    },
  });

  let body: any;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

// ---------------------------------------------------------------------------
// merchantLocation idempotent setup
// Citation: Codex BLOCKER §b — GET→create if missing
// Operator Decision #5: address constants
// ---------------------------------------------------------------------------

async function ensureMerchantLocation(): Promise<void> {
  // @ts-ignore
  const postalCode = Deno.env.get("EBAY_LOC_POSTAL_CODE") || "16677"; // 운영자 확정 (Telegram msg #962)

  // Attempt GET first (idempotent)
  const get = await ebayFetch(`/sell/inventory/v1/location/${MERCHANT_LOCATION_KEY}`);
  if (get.status === 200) {
    // Already exists — verify it's enabled
    if (get.body?.merchantLocationStatus === "DISABLED") {
      // Enable it
      await ebayFetch(
        `/sell/inventory/v1/location/${MERCHANT_LOCATION_KEY}/enable`,
        { method: "POST" }
      );
    }
    return;
  }

  if (get.status !== 404) {
    throw new Error(
      `merchantLocation GET failed HTTP ${get.status}: ${JSON.stringify(get.body)}`
    );
  }

  // Create location (PUT is idempotent)
  // Operator Decision #5: Suwon, Gyeonggi-do, KR
  const createResult = await ebayFetch(
    `/sell/inventory/v1/location/${MERCHANT_LOCATION_KEY}`,
    {
      method: "PUT",
      body: JSON.stringify({
        location: {
          address: {
            addressLine1: "Shinwon-ro 55, B105",
            city: "Suwon",
            stateOrProvince: "Gyeonggi-do",
            country: "KR",
            postalCode,
          },
        },
        locationInstructions: "K-Pop merchandise fulfillment center",
        locationTypes: ["WAREHOUSE"],
        merchantLocationStatus: "ENABLED",
        name: "StarOne Suwon B105",
        phone: "",
      }),
    }
  );

  if (createResult.status !== 204 && createResult.status !== 200 && createResult.status !== 201) {
    throw new Error(
      `merchantLocation PUT failed HTTP ${createResult.status}: ${JSON.stringify(createResult.body)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Business policy bootstrap
// Citation: Codex BLOCKER §b — persist policy IDs per marketplace
// Operator Decision #3: policies already active on seller account
// ---------------------------------------------------------------------------

async function ensurePolicies(marketplaceId: string): Promise<{
  fulfillmentPolicyId: string;
  returnPolicyId: string;
  paymentPolicyId: string;
}> {
  // Check persistent store first
  const { data: stored } = await supabase
    .from("ebay_policy_ids")
    .select("fulfillment_policy_id, return_policy_id, payment_policy_id")
    .eq("marketplace_id", marketplaceId)
    .single();

  if (stored?.fulfillment_policy_id && stored?.return_policy_id && stored?.payment_policy_id) {
    return {
      fulfillmentPolicyId: stored.fulfillment_policy_id,
      returnPolicyId: stored.return_policy_id,
      paymentPolicyId: stored.payment_policy_id,
    };
  }

  // Query eBay Account API for existing policies
  // Citation: sell/account.yaml — marketplace-scoped policy endpoints
  const [fpRes, rpRes, ppRes] = await Promise.all([
    ebayFetch(`/sell/account/v1/fulfillment_policy?marketplace_id=${marketplaceId}`),
    ebayFetch(`/sell/account/v1/return_policy?marketplace_id=${marketplaceId}`),
    ebayFetch(`/sell/account/v1/payment_policy?marketplace_id=${marketplaceId}`),
  ]);

  function firstId(res: { status: number; body: any }, field: string): string {
    if (res.status !== 200 || !res.body) {
      throw new Error(`Policy fetch failed HTTP ${res.status}: ${JSON.stringify(res.body)}`);
    }
    const items: any[] = res.body[field] || [];
    if (!items.length) throw new Error(`No ${field} found for marketplace ${marketplaceId}`);
    // Pick first active policy
    const active = items.find((p: any) => p.marketplaceId === marketplaceId) || items[0];
    return active.fulfillmentPolicyId || active.returnPolicyId || active.paymentPolicyId || active.id;
  }

  const fulfillmentPolicyId = firstId(fpRes, "fulfillmentPolicies");
  const returnPolicyId      = firstId(rpRes, "returnPolicies");
  const paymentPolicyId     = firstId(ppRes, "paymentPolicies");

  // Persist to ebay_policy_ids for subsequent calls
  await supabase.from("ebay_policy_ids").upsert({
    marketplace_id: marketplaceId,
    fulfillment_policy_id: fulfillmentPolicyId,
    return_policy_id: returnPolicyId,
    payment_policy_id: paymentPolicyId,
    merchant_location_key: MERCHANT_LOCATION_KEY,
    updated_at: new Date().toISOString(),
  }, { onConflict: "marketplace_id" });

  return { fulfillmentPolicyId, returnPolicyId, paymentPolicyId };
}

// ---------------------------------------------------------------------------
// Category tree helpers
// Citation: Codex WARNING §b — cache categoryTreeId + categoryTreeVersion
// ---------------------------------------------------------------------------

let _categoryTreeCache: { treeId: string; treeVersion: string; expiresAt: number } | null = null;

async function getCategoryTreeId(marketplaceId: string): Promise<{ treeId: string; treeVersion: string }> {
  const now = Date.now();
  if (_categoryTreeCache && now < _categoryTreeCache.expiresAt) {
    return { treeId: _categoryTreeCache.treeId, treeVersion: _categoryTreeCache.treeVersion };
  }

  // Citation: commerce/taxonomy.yaml — getDefaultCategoryTreeId
  const res = await ebayFetch(
    `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${marketplaceId}`
  );
  if (res.status !== 200 || !res.body?.categoryTreeId) {
    throw new Error(`getDefaultCategoryTreeId failed HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }

  _categoryTreeCache = {
    treeId: String(res.body.categoryTreeId),
    treeVersion: String(res.body.categoryTreeVersion || ""),
    expiresAt: now + 6 * 60 * 60 * 1000, // cache 6 hours
  };

  return { treeId: _categoryTreeCache.treeId, treeVersion: _categoryTreeCache.treeVersion };
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

// SKU max length 50 — sell/inventory.yaml L748 (grill-with-docs Revision §2)
function validateSku(sku: string): void {
  if (!sku || sku.trim().length === 0) throw new Error("sku 는 필수입니다");
  if (sku.length > 50) throw new Error(`sku 최대 50자 초과: ${sku.length}자 (spec L748)`);
}

// aspect name 40자, value 50자 — sell/inventory.yaml L10791 (grill-with-docs Revision §5)
function validateAspects(aspects: Record<string, string[]>): void {
  for (const [name, values] of Object.entries(aspects)) {
    if (name.length > 40) throw new Error(`aspect name 최대 40자: "${name}" (${name.length}자)`);
    for (const v of values) {
      if (v.length > 50) throw new Error(`aspect value 최대 50자: "${v}" (${v.length}자)`);
    }
  }
}

// description max 4000자 — sell/inventory.yaml L10843 (grill-with-docs Revision §6)
function validateDescription(desc: string): string {
  if (!desc || desc.trim().length === 0) throw new Error("description 은 필수입니다 (Operator Decision #6: 운영자 직접 입력)");
  if (desc.length > 4000) {
    console.warn(`[ebay-bridge] description ${desc.length}자 → 4000자로 절삭`);
    return desc.slice(0, 4000);
  }
  return desc;
}

function validateShippingSurcharges(rows: any[]): any[] {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 80).map((r) => {
    const countryCode = String(r?.countryCode || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) throw new Error(`invalid shipping surcharge countryCode: ${countryCode}`);
    const weightBucketG = Number(r?.weightBucketG || 0);
    const deltaKrw = Number(r?.deltaKrw || 0);
    const extraShippingUsd = Number(r?.extraShippingUsd || 0);
    if (!weightBucketG || weightBucketG < 100 || weightBucketG > 1000) throw new Error(`invalid shipping surcharge weightBucketG for ${countryCode}`);
    if (deltaKrw < 0 || extraShippingUsd < 0) throw new Error(`invalid negative shipping surcharge for ${countryCode}`);
    return {
      countryCode,
      countryName: String(r?.countryName || ''),
      weightBucketG,
      baselineKrw: Number(r?.baselineKrw || 0),
      standardKrw: Number(r?.standardKrw || 0),
      deltaKrw,
      extraShippingUsd: Number(extraShippingUsd.toFixed(2)),
    };
  });
}

// ---------------------------------------------------------------------------
// /publish handler — main listing orchestration
// ---------------------------------------------------------------------------

async function handlePublish(body: any): Promise<Response> {
  const {
    sku,
    title,
    description,
    imageUrls,
    aspects,
    condition,
    priceUsd,
    quantity,
    categoryId,
    weightG,
    packageDimensions,
    shippingSurchargePolicy = "delta_vs_us_baseline",
    shippingSurchargesUsd = [],
    marketplaceId = "EBAY_US",
  } = body;

  // Validate inputs
  validateSku(sku);
  if (!title) throw new Error("title 은 필수입니다");
  const safeDescription = validateDescription(description || "");
  if (!imageUrls || imageUrls.length === 0) throw new Error("imageUrls 는 최소 1개 필요합니다");
  if (!priceUsd || priceUsd <= 0) throw new Error("priceUsd > 0 필요합니다");
  if (!categoryId) throw new Error("categoryId 는 필수입니다");
  const safeShippingSurcharges = validateShippingSurcharges(shippingSurchargesUsd);

  // Validate aspects (name/value length guards)
  const safeAspects: Record<string, string[]> = aspects || {};
  validateAspects(safeAspects);

  // Condition: only NEW — Codex BLOCKER §a + Operator Decision #6 (conditionDescriptors OFF)
  // Citation: sell/inventory.yaml L8527 — NEW is the correct enum for brand new items
  const conditionEnum = "NEW";  // always NEW regardless of input

  // Step 0: Ensure merchantLocation exists (idempotent)
  await ensureMerchantLocation();

  // Step 1: Get policy IDs (from cache or Account API)
  const { fulfillmentPolicyId, returnPolicyId, paymentPolicyId } = await ensurePolicies(marketplaceId);

  // Step 2: PUT /sell/inventory/v1/inventory_item/{sku}
  // Citation: sell/inventory.yaml — createOrReplaceInventoryItem
  // NOTE: EAN EXCLUDED — Operator Decision #4 (avoid eBay catalog auto-match)
  // NOTE: conditionDescription excluded — Codex BLOCKER §a (ignored for NEW condition)
  // NOTE: fulfillmentTime excluded — Codex BLOCKER §a (for in-store pickup only)
  const inventoryItemBody: any = {
    availability: {
      shipToLocationAvailability: {
        quantity: quantity || 50,
      },
    },
    condition: conditionEnum,
    product: {
      title: title.slice(0, 80), // eBay title max 80 chars
      description: safeDescription,
      imageUrls: imageUrls.slice(0, 24), // eBay max 24 images
      aspects: safeAspects,
    },
  };

  // Package weight and size (optional but recommended for shipping calc)
  if (weightG || packageDimensions) {
    inventoryItemBody.packageWeightAndSize = {};
    if (weightG) {
      inventoryItemBody.packageWeightAndSize.weight = {
        value: Number((weightG / 1000).toFixed(3)),
        unit: "KILOGRAM",
      };
    }
    if (packageDimensions) {
      inventoryItemBody.packageWeightAndSize.dimensions = packageDimensions;
    }
  }

  const itemRes = await ebayFetch(
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    { method: "PUT", body: JSON.stringify(inventoryItemBody) }
  );

  // PUT returns 204 on success (create or replace)
  if (itemRes.status !== 204 && itemRes.status !== 200 && itemRes.status !== 201) {
    throw new Error(
      `inventory_item PUT failed HTTP ${itemRes.status}: ${JSON.stringify(itemRes.body)}`
    );
  }

  // Step 3: POST /sell/inventory/v1/offer
  // Citation: sell/inventory.yaml — createOffer
  // Retry semantics: Codex WARNING §a — sku+marketplaceId+format must be unique;
  // if offer already exists, we get an error and must use updateOffer instead.
  const offerBody = {
    sku,
    marketplaceId,
    format: "FIXED_PRICE",
    availableQuantity: quantity || 50,
    categoryId: String(categoryId),
    listingDescription: safeDescription,
    listingPolicies: {
      fulfillmentPolicyId,
      paymentPolicyId,
      returnPolicyId,
    },
    pricingSummary: {
      price: {
        value: String(Number(priceUsd).toFixed(2)),
        currency: "USD",
      },
    },
    merchantLocationKey: MERCHANT_LOCATION_KEY,
    listingDuration: LISTING_DURATION, // GTC for fixed-price — Codex §d WARNING
  };

  let offerId: string;

  const offerRes = await ebayFetch(
    "/sell/inventory/v1/offer",
    { method: "POST", body: JSON.stringify(offerBody) }
  );

  if (offerRes.status === 200 || offerRes.status === 201) {
    offerId = offerRes.body?.offerId;
    if (!offerId) throw new Error("createOffer returned no offerId: " + JSON.stringify(offerRes.body));
  } else if (offerRes.status === 409 || (offerRes.body?.errors || []).some((e: any) => String(e.errorId) === "25002")) {
    // Offer already exists for this sku+marketplaceId+format — use updateOffer
    // Citation: Codex WARNING §a — sell/inventory.yaml "SKU, marketplaceId and format should be unique"
    const existingOffers = await ebayFetch(
      `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`
    );
    if (existingOffers.status !== 200 || !existingOffers.body?.offers?.length) {
      throw new Error(`Offer already exists but could not find it: HTTP ${existingOffers.status}`);
    }
    offerId = existingOffers.body.offers[0].offerId;
    // Update the existing offer
    const updateRes = await ebayFetch(
      `/sell/inventory/v1/offer/${offerId}`,
      { method: "PUT", body: JSON.stringify(offerBody) }
    );
    if (updateRes.status !== 204 && updateRes.status !== 200) {
      throw new Error(`updateOffer PUT failed HTTP ${updateRes.status}: ${JSON.stringify(updateRes.body)}`);
    }
  } else {
    throw new Error(`createOffer failed HTTP ${offerRes.status}: ${JSON.stringify(offerRes.body)}`);
  }

  // Step 4: POST /sell/inventory/v1/offer/{offerId}/publish
  const publishRes = await ebayFetch(
    `/sell/inventory/v1/offer/${offerId}/publish`,
    { method: "POST", body: "{}" }
  );

  if (publishRes.status !== 200) {
    throw new Error(
      `publishOffer failed HTTP ${publishRes.status}: ${JSON.stringify(publishRes.body)}`
    );
  }

  const listingId = publishRes.body?.listingId;
  if (!listingId) throw new Error("publishOffer returned no listingId: " + JSON.stringify(publishRes.body));

  return jsonResp({
    ok: true,
    ebay_item_id: listingId,
    ebay_offer_id: offerId,
    marketplace_id: marketplaceId,
    shipping_surcharge_policy: shippingSurchargePolicy,
    shipping_surcharges_usd: safeShippingSurcharges,
    listingStatus: "PUBLISHED",
  });
}

// ---------------------------------------------------------------------------
// /lookup-item?sku= handler — post-publish verification
// Citation: Codex BLOCKER §d — assert status=PUBLISHED + listing container present
// ---------------------------------------------------------------------------

async function handleLookupItem(sku: string, marketplaceId: string): Promise<Response> {
  if (!sku) return jsonResp({ ok: false, error: "sku query param required" }, 400);
  validateSku(sku);

  const [itemRes, offersRes] = await Promise.all([
    ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`),
    ebayFetch(`/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`),
  ]);

  const itemOk = itemRes.status === 200;
  const itemMissing = itemRes.status === 404;
  const offersOk = offersRes.status === 200;
  const offersMissing = offersRes.status === 404;
  if (!itemOk && !itemMissing) {
    return jsonResp({ ok: false, error: "upstream_inventory_lookup_failed", upstream_status: itemRes.status }, itemRes.status === 401 || itemRes.status === 403 || itemRes.status === 429 ? itemRes.status : 502);
  }
  if (!offersOk && !offersMissing) {
    return jsonResp({ ok: false, error: "upstream_offer_lookup_failed", upstream_status: offersRes.status }, offersRes.status === 401 || offersRes.status === 403 || offersRes.status === 429 ? offersRes.status : 502);
  }
  const offers: any[] = offersOk ? (offersRes.body?.offers || []) : [];
  const publishedOffer = offers.find((o: any) => String(o.status || '').toUpperCase() === "PUBLISHED");
  const listingId = publishedOffer?.listing?.listingId || publishedOffer?.listingId || null;
  const listingStatus = publishedOffer?.listing?.listingStatus || publishedOffer?.listingStatus || null;

  // eBay Inventory API distinction (docs: getOffers retrieves offers for a SKU;
  // the listing container is returned only for published offers). For SKU sync,
  // an inventory item or an unpublished offer is still a real eBay-side record and
  // should be absorbed as draft instead of reported as "not found". The stricter
  // post-publish verification signal remains exposed separately for publish flows.
  // Citations: sell/inventory.yaml getOffers L3787-L3851, Offer.status L7478-L7483,
  // ListingDetails L9665-L9669.
  const publishedVerificationPassed = !!publishedOffer && !!listingId;
  const skuRecordFound = itemOk || offers.length > 0;

  return jsonResp({
    ok: skuRecordFound,
    verification: {
      inventory_item_found: itemOk,
      offer_count: offers.length,
      sku_record_found: skuRecordFound,
      published_offer_found: !!publishedOffer,
      published_verification_passed: publishedVerificationPassed,
      listing_id: listingId,
      listing_status: listingStatus,
    },
    inventory_item: itemOk ? itemRes.body : null,
    offers: offers.map((o: any) => ({
      offerId: o.offerId,
      status: o.status,
      sku: o.sku,
      marketplaceId: o.marketplaceId,
      listingId: o.listing?.listingId || o.listingId || null,
    })),
  });
}

// ---------------------------------------------------------------------------
// /healthz handler
// ---------------------------------------------------------------------------

async function handleHealthz(): Promise<Response> {
  try {
    const token = await getValidAccessToken();
    return jsonResp({ ok: true, service: "ebay-bridge", version: 1, token_ok: !!token });
  } catch (e: any) {
    return jsonResp({ ok: false, service: "ebay-bridge", version: 1, error: "healthz_failed" }, 500);
  }
}

// ---------------------------------------------------------------------------
// Response helper
// ---------------------------------------------------------------------------

function jsonResp(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function requireInternalBridge(req: Request): Response | null {
  const expected = (Deno as any)["env"]["get"]("PLATFORM_BRIDGE_INTERNAL_TOKEN") || "";
  const actual = req.headers.get("x-platform-bridge-token") || "";
  if (!expected || actual !== expected) {
    return jsonResp({ ok: false, error: "internal_bridge_required" }, 403);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handleRequest(req: Request): Promise<Response> {
  // CORS preflight — must return Response(null, {status:204})
  // Citation: memory feedback_supabase_cors_204_no_body
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const action = url.pathname.split("/").filter(Boolean).pop() || "";
  const authResult = await requireAuthenticatedUser(req);
  if (authResult.response) return authResult.response;

  try {
    if (action === "healthz" && req.method === "GET") {
      return await handleHealthz();
    }

    if (action === "lookup-item" && req.method === "GET") {
      // V2 eBay registration UI calls ebay-bridge directly, like shopee-bridge/joom-bridge.
      // requireAuthenticatedUser above remains the auth boundary; do not require the
      // server-only platform bridge token from browser-originated publish verification.
      const sku = url.searchParams.get("sku") || "";
      const marketplaceId = url.searchParams.get("marketplace_id") || "EBAY_US";
      return await handleLookupItem(sku, marketplaceId);
    }

    if (action === "publish" && req.method === "POST") {
      // V2 eBay registration UI calls ebay-bridge directly, like shopee-bridge/joom-bridge.
      // requireAuthenticatedUser above remains the auth boundary; do not require the
      // server-only platform bridge token from browser-originated publish requests.
      const body = await req.json();
      return await handlePublish(body);
    }

    return jsonResp({ ok: false, error: `unknown action: ${action} (${req.method})` }, 404);
  } catch (e: any) {
    console.error("[ebay-bridge] error", e);
    return jsonResp({
      ok: false,
      error: String(e?.message || e),
    }, 500);
  }
}

// @ts-ignore
Deno.serve(handleRequest);
