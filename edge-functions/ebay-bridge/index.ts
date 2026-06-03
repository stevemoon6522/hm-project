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

// Steve's default eBay shipping business policy for K-pop album listings.
const EBAY_DEFAULT_FULFILLMENT_POLICY_ID = "253030471025";
const EBAY_DEFAULT_FULFILLMENT_POLICY_NAME = "ALBUM PRE-ORDER";

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
  if (j.error) throw new Error("eBay token refresh 오류: " + (j.error_description || j.error));

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
      "Accept-Language": "en-US",
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...extraHeaders,
    },
  });

  let body: any;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

function formatEbayErrorBody(body: any): string {
  if (!body) return "empty response";
  if (Array.isArray(body.errors) && body.errors.length) {
    return body.errors.map((e: any) =>
      [e.errorId, e.message, e.longMessage].filter(Boolean).join(" · ")
    ).filter(Boolean).join(" / ");
  }
  if (body.error_description || body.error) {
    return [body.error, body.error_description].filter(Boolean).join(" · ");
  }
  try { return JSON.stringify(body); } catch { return String(body); }
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
      `merchantLocation GET failed HTTP ${get.status}: ${formatEbayErrorBody(get.body)}`
    );
  }

  // Create location. The local 2026-05 snapshot listed PUT, but the live eBay
  // Inventory docs now require POST for createInventoryLocation.
  // Operator Decision #5: Suwon, Gyeonggi-do, KR
  const createResult = await ebayFetch(
    `/sell/inventory/v1/location/${MERCHANT_LOCATION_KEY}`,
    {
      method: "POST",
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
      `merchantLocation POST failed HTTP ${createResult.status}: ${formatEbayErrorBody(createResult.body)}`
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
  fulfillmentPolicyName: string;
  returnPolicyId: string;
  paymentPolicyId: string;
}> {
  // Check persistent store first
  const { data: stored } = await supabase
    .from("ebay_policy_ids")
    .select("fulfillment_policy_id, return_policy_id, payment_policy_id")
    .eq("marketplace_id", marketplaceId)
    .single();

  if (stored?.return_policy_id && stored?.payment_policy_id) {
    if (stored.fulfillment_policy_id !== EBAY_DEFAULT_FULFILLMENT_POLICY_ID) {
      await supabase.from("ebay_policy_ids").upsert({
        marketplace_id: marketplaceId,
        fulfillment_policy_id: EBAY_DEFAULT_FULFILLMENT_POLICY_ID,
        return_policy_id: stored.return_policy_id,
        payment_policy_id: stored.payment_policy_id,
        merchant_location_key: MERCHANT_LOCATION_KEY,
        updated_at: new Date().toISOString(),
      }, { onConflict: "marketplace_id" });
    }

    return {
      fulfillmentPolicyId: EBAY_DEFAULT_FULFILLMENT_POLICY_ID,
      fulfillmentPolicyName: EBAY_DEFAULT_FULFILLMENT_POLICY_NAME,
      returnPolicyId: stored.return_policy_id,
      paymentPolicyId: stored.payment_policy_id,
    };
  }

  // Query eBay Account API for existing policies
  // Citation: sell/account.yaml — marketplace-scoped policy endpoints
  const [rpRes, ppRes] = await Promise.all([
    ebayFetch(`/sell/account/v1/return_policy?marketplace_id=${marketplaceId}`),
    ebayFetch(`/sell/account/v1/payment_policy?marketplace_id=${marketplaceId}`),
  ]);

  function firstId(res: { status: number; body: any }, field: string): string {
    if (res.status !== 200 || !res.body) {
      throw new Error(`Policy fetch failed HTTP ${res.status}: ${formatEbayErrorBody(res.body)}`);
    }
    const items: any[] = res.body[field] || [];
    if (!items.length) throw new Error(`No ${field} found for marketplace ${marketplaceId}`);
    // Pick first active policy
    const active = items.find((p: any) => p.marketplaceId === marketplaceId) || items[0];
    return active.fulfillmentPolicyId || active.returnPolicyId || active.paymentPolicyId || active.id;
  }

  const fulfillmentPolicyId = EBAY_DEFAULT_FULFILLMENT_POLICY_ID;
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

  return {
    fulfillmentPolicyId,
    fulfillmentPolicyName: EBAY_DEFAULT_FULFILLMENT_POLICY_NAME,
    returnPolicyId,
    paymentPolicyId,
  };
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
    throw new Error(`getDefaultCategoryTreeId failed HTTP ${res.status}: ${formatEbayErrorBody(res.body)}`);
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

function normalizeStoreCategoryNames(value: any): string[] {
  const raw = Array.isArray(value) ? value : [];
  const clean = raw
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .map((v) => v.startsWith("/") ? v : `/${v}`)
    .slice(0, 2);
  return clean.length ? clean : ["/K-pop"];
}

function normalizeImageUrls(value: any, max = 24): string[] {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : [])
    .map((v) => String(v || "").trim())
    .filter((v) => /^https:\/\//i.test(v) && !seen.has(v) && seen.add(v))
    .slice(0, max);
}

function withPackageWeightAndSize(target: any, weightG: any, packageDimensions?: any): void {
  const grams = Number(weightG || 0);
  if (!grams && !packageDimensions) return;
  target.packageWeightAndSize = {};
  if (grams) {
    target.packageWeightAndSize.weight = {
      value: Number((grams / 1000).toFixed(3)),
      unit: "KILOGRAM",
    };
  }
  if (packageDimensions) target.packageWeightAndSize.dimensions = packageDimensions;
}

async function createOrUpdateOfferForSku(
  sku: string,
  marketplaceId: string,
  offerBody: Record<string, unknown>
): Promise<string> {
  const offerRes = await ebayFetch(
    "/sell/inventory/v1/offer",
    { method: "POST", body: JSON.stringify(offerBody) }
  );

  if (offerRes.status === 200 || offerRes.status === 201) {
    const offerId = offerRes.body?.offerId;
    if (!offerId) throw new Error("createOffer returned no offerId: " + JSON.stringify(offerRes.body));
    return offerId;
  }

  if (offerRes.status === 409 || (offerRes.body?.errors || []).some((e: any) => String(e.errorId) === "25002")) {
    const existingOffers = await ebayFetch(
      `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`
    );
    if (existingOffers.status !== 200 || !existingOffers.body?.offers?.length) {
      throw new Error(`Offer already exists but could not find it: HTTP ${existingOffers.status}`);
    }
    const offerId = existingOffers.body.offers[0].offerId;
    const updateRes = await ebayFetch(
      `/sell/inventory/v1/offer/${offerId}`,
      { method: "PUT", body: JSON.stringify(offerBody) }
    );
    if (updateRes.status !== 204 && updateRes.status !== 200) {
      throw new Error(`updateOffer PUT failed HTTP ${updateRes.status}: ${formatEbayErrorBody(updateRes.body)}`);
    }
    return offerId;
  }

  throw new Error(`createOffer failed HTTP ${offerRes.status}: ${formatEbayErrorBody(offerRes.body)}`);
}

async function startEbayPublishRun(listingMode: "single" | "variation", body: any): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("ebay_publish_runs")
      .insert({
        product_id: body.productId || body.product_id || null,
        product_group_id: body.productGroupId || body.product_group_id || null,
        listing_mode: listingMode,
        inventory_group_key: body.inventoryGroupKey || null,
        marketplace_id: body.marketplaceId || "EBAY_US",
        status: "started",
        request_payload: body || {},
      })
      .select("id")
      .single();
    if (error) throw error;
    return data?.id || null;
  } catch (e) {
    console.warn("[ebay-bridge] publish run insert skipped", e);
    return null;
  }
}

async function finishEbayPublishRun(runId: string | null, status: "published" | "failed", responsePayload: any, errorMsg = ""): Promise<void> {
  if (!runId) return;
  try {
    const offers = responsePayload?.offers_by_sku && typeof responsePayload.offers_by_sku === "object"
      ? Object.values(responsePayload.offers_by_sku).map((o: any) => String(o?.offerId || "")).filter(Boolean)
      : [responsePayload?.ebay_offer_id].map((v) => String(v || "")).filter(Boolean);
    await supabase
      .from("ebay_publish_runs")
      .update({
        status,
        response_payload: responsePayload || {},
        error_msg: errorMsg || null,
        ebay_item_id: responsePayload?.ebay_item_id || null,
        ebay_offer_ids: offers,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
  } catch (e) {
    console.warn("[ebay-bridge] publish run update skipped", e);
  }
}

async function jsonFromResponse(resp: Response): Promise<any> {
  try { return await resp.clone().json(); } catch { return {}; }
}

async function withEbayPublishRun(
  listingMode: "single" | "variation",
  body: any,
  fn: () => Promise<Response>
): Promise<Response> {
  const runId = await startEbayPublishRun(listingMode, body);
  try {
    const resp = await fn();
    const raw = await jsonFromResponse(resp);
    await finishEbayPublishRun(runId, resp.status < 400 && raw?.ok ? "published" : "failed", raw, raw?.error || raw?.message || "");
    return resp;
  } catch (e: any) {
    await finishEbayPublishRun(runId, "failed", {}, String(e?.message || e));
    throw e;
  }
}

// ---------------------------------------------------------------------------
// /publish handler — main listing orchestration
// ---------------------------------------------------------------------------

async function handlePublishSingle(body: any): Promise<Response> {
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
    storeCategoryNames,
    shippingSurchargePolicy = "delta_vs_us_baseline",
    shippingSurchargesUsd = [],
    marketplaceId = "EBAY_US",
  } = body;

  // Validate inputs
  validateSku(sku);
  if (!title) throw new Error("title 은 필수입니다");
  const safeDescription = validateDescription(description || "");
  const safeImageUrls = normalizeImageUrls(imageUrls, 24);
  if (!safeImageUrls.length) throw new Error("imageUrls 는 최소 1개 필요합니다");
  if (!priceUsd || priceUsd <= 0) throw new Error("priceUsd > 0 필요합니다");
  if (!categoryId) throw new Error("categoryId 는 필수입니다");
  const safeShippingSurcharges = validateShippingSurcharges(shippingSurchargesUsd);
  const safeStoreCategoryNames = normalizeStoreCategoryNames(storeCategoryNames);

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
      imageUrls: safeImageUrls, // eBay max 24 images
      aspects: safeAspects,
    },
  };

  // Package weight and size (optional but recommended for shipping calc)
  withPackageWeightAndSize(inventoryItemBody, weightG, packageDimensions);

  const itemRes = await ebayFetch(
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    { method: "PUT", body: JSON.stringify(inventoryItemBody) }
  );

  // PUT returns 204 on success (create or replace)
  if (itemRes.status !== 204 && itemRes.status !== 200 && itemRes.status !== 201) {
    throw new Error(
      `inventory_item PUT failed HTTP ${itemRes.status}: ${formatEbayErrorBody(itemRes.body)}`
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
    storeCategoryNames: safeStoreCategoryNames,
    includeCatalogProductDetails: false,
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

  const offerId = await createOrUpdateOfferForSku(sku, marketplaceId, offerBody);

  // Step 4: POST /sell/inventory/v1/offer/{offerId}/publish
  const publishRes = await ebayFetch(
    `/sell/inventory/v1/offer/${offerId}/publish`,
    { method: "POST", body: "{}" }
  );

  if (publishRes.status !== 200) {
    throw new Error(
      `publishOffer failed HTTP ${publishRes.status}: ${formatEbayErrorBody(publishRes.body)}`
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

async function handlePublish(body: any): Promise<Response> {
  return await withEbayPublishRun("single", body, () => handlePublishSingle(body));
}

function validateInventoryGroupKey(value: string): void {
  if (!value || !value.trim()) throw new Error("inventoryGroupKey 는 필수입니다");
  if (value.length > 50) throw new Error(`inventoryGroupKey 최대 50자 초과: ${value.length}자`);
}

function mergeVariationAspects(aspects: Record<string, string[]>, axis: string, value: string): Record<string, string[]> {
  return {
    ...(aspects || {}),
    [axis]: [value],
  };
}

async function handlePublishVariationCore(body: any): Promise<Response> {
  const {
    inventoryGroupKey,
    title,
    description,
    imageUrls,
    aspects,
    categoryId,
    storeCategoryNames,
    variationAxis = "Version",
    variations = [],
    shippingSurchargePolicy = "delta_vs_us_baseline",
    shippingSurchargesUsd = [],
    marketplaceId = "EBAY_US",
  } = body;

  validateInventoryGroupKey(String(inventoryGroupKey || ""));
  if (!title) throw new Error("title 은 필수입니다");
  if (!categoryId) throw new Error("categoryId 는 필수입니다");
  const safeDescription = validateDescription(description || "");
  const safeImageUrls = normalizeImageUrls(imageUrls, 24);
  if (!safeImageUrls.length) throw new Error("imageUrls 는 최소 1개 필요합니다");
  const safeStoreCategoryNames = normalizeStoreCategoryNames(storeCategoryNames);
  const safeShippingSurcharges = validateShippingSurcharges(shippingSurchargesUsd);
  const safeAspects: Record<string, string[]> = aspects || {};
  validateAspects(safeAspects);
  const axis = String(variationAxis || "Version").trim().slice(0, 40);
  if (!axis) throw new Error("variationAxis 는 필수입니다");
  if (!Array.isArray(variations) || variations.length < 2) throw new Error("variations 는 최소 2개 필요합니다");
  if (variations.length > 25) throw new Error("variations 는 한 번에 최대 25개까지 지원합니다");

  const normalizedVariations = variations.map((v: any, idx: number) => {
    const sku = String(v?.sku || "").trim();
    const variationValue = String(v?.variationValue || v?.optionName || "").trim().slice(0, 50);
    validateSku(sku);
    if (!variationValue) throw new Error(`variation ${idx + 1}: variationValue is required`);
    const priceUsd = Number(v?.priceUsd || 0);
    const quantity = Math.max(0, Math.floor(Number(v?.quantity || 0)));
    const weightG = Number(v?.weightG || 0);
    const optionImages = normalizeImageUrls(v?.imageUrls, 12);
    if (priceUsd <= 0) throw new Error(`variation ${idx + 1}: priceUsd > 0 필요`);
    if (quantity <= 0) throw new Error(`variation ${idx + 1}: quantity > 0 필요`);
    if (weightG <= 0) throw new Error(`variation ${idx + 1}: weightG > 0 필요`);
    if (!optionImages.length) throw new Error(`variation ${idx + 1}: option image is required`);
    return { sku, variationValue, priceUsd, quantity, weightG, imageUrls: optionImages };
  });

  const skus = normalizedVariations.map((v) => v.sku);
  const values = normalizedVariations.map((v) => v.variationValue);
  if (new Set(skus).size !== skus.length) throw new Error("variation SKU values must be unique");
  if (new Set(values).size !== values.length) throw new Error("variation values must be unique");

  validateAspects({ [axis]: values });

  await ensureMerchantLocation();
  const { fulfillmentPolicyId, returnPolicyId, paymentPolicyId } = await ensurePolicies(marketplaceId);

  const offersBySku: Record<string, { offerId: string; variationValue: string }> = {};

  for (const v of normalizedVariations) {
    const inventoryItemBody: any = {
      availability: {
        shipToLocationAvailability: {
          quantity: v.quantity,
        },
      },
      condition: "NEW",
      product: {
        imageUrls: v.imageUrls,
        aspects: mergeVariationAspects(safeAspects, axis, v.variationValue),
      },
    };
    withPackageWeightAndSize(inventoryItemBody, v.weightG);

    const itemRes = await ebayFetch(
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(v.sku)}`,
      { method: "PUT", body: JSON.stringify(inventoryItemBody) }
    );
    if (itemRes.status !== 204 && itemRes.status !== 200 && itemRes.status !== 201) {
      throw new Error(`variation inventory_item PUT failed for ${v.sku} HTTP ${itemRes.status}: ${formatEbayErrorBody(itemRes.body)}`);
    }

    const offerBody = {
      sku: v.sku,
      marketplaceId,
      format: "FIXED_PRICE",
      availableQuantity: v.quantity,
      categoryId: String(categoryId),
      storeCategoryNames: safeStoreCategoryNames,
      includeCatalogProductDetails: false,
      listingPolicies: {
        fulfillmentPolicyId,
        paymentPolicyId,
        returnPolicyId,
      },
      pricingSummary: {
        price: {
          value: String(Number(v.priceUsd).toFixed(2)),
          currency: "USD",
        },
      },
      merchantLocationKey: MERCHANT_LOCATION_KEY,
      listingDuration: LISTING_DURATION,
    };
    const offerId = await createOrUpdateOfferForSku(v.sku, marketplaceId, offerBody);
    offersBySku[v.sku] = { offerId, variationValue: v.variationValue };
  }

  const groupBody = {
    title: String(title).slice(0, 80),
    description: safeDescription,
    aspects: safeAspects,
    imageUrls: safeImageUrls,
    variantSKUs: skus,
    variesBy: {
      aspectsImageVariesBy: [axis],
      specifications: [
        {
          name: axis,
          values,
        },
      ],
    },
  };

  const groupRes = await ebayFetch(
    `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(String(inventoryGroupKey))}`,
    { method: "PUT", body: JSON.stringify(groupBody) }
  );
  if (groupRes.status !== 204 && groupRes.status !== 200 && groupRes.status !== 201) {
    throw new Error(`inventory_item_group PUT failed HTTP ${groupRes.status}: ${formatEbayErrorBody(groupRes.body)}`);
  }

  const publishRes = await ebayFetch(
    "/sell/inventory/v1/offer/publish_by_inventory_item_group",
    {
      method: "POST",
      body: JSON.stringify({
        inventoryItemGroupKey: inventoryGroupKey,
        marketplaceId,
      }),
    }
  );
  if (publishRes.status !== 200) {
    throw new Error(`publishOfferByInventoryItemGroup failed HTTP ${publishRes.status}: ${formatEbayErrorBody(publishRes.body)}`);
  }

  const listingId = publishRes.body?.listingId;
  if (!listingId) throw new Error("publishOfferByInventoryItemGroup returned no listingId: " + JSON.stringify(publishRes.body));

  return jsonResp({
    ok: true,
    ebay_item_id: listingId,
    ebay_inventory_group_key: inventoryGroupKey,
    offers_by_sku: offersBySku,
    marketplace_id: marketplaceId,
    variation_axis: axis,
    shipping_surcharge_policy: shippingSurchargePolicy,
    shipping_surcharges_usd: safeShippingSurcharges,
    listingStatus: "PUBLISHED",
  });
}

async function handlePublishVariation(body: any): Promise<Response> {
  return await withEbayPublishRun("variation", body, () => handlePublishVariationCore(body));
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

async function handleLookupGroup(inventoryGroupKey: string, marketplaceId: string): Promise<Response> {
  if (!inventoryGroupKey) return jsonResp({ ok: false, error: "inventory_group_key query param required" }, 400);
  validateInventoryGroupKey(inventoryGroupKey);

  const groupRes = await ebayFetch(`/sell/inventory/v1/inventory_item_group/${encodeURIComponent(inventoryGroupKey)}`);
  if (groupRes.status === 404) {
    return jsonResp({
      ok: false,
      verification: {
        inventory_group_found: false,
        offer_count: 0,
        published_offer_found: false,
        published_verification_passed: false,
      },
    });
  }
  if (groupRes.status !== 200) {
    return jsonResp({
      ok: false,
      error: "upstream_inventory_group_lookup_failed",
      upstream_status: groupRes.status,
      upstream_body: groupRes.body,
    }, groupRes.status === 401 || groupRes.status === 403 || groupRes.status === 429 ? groupRes.status : 502);
  }

  const variantSkus = Array.isArray(groupRes.body?.variantSKUs) ? groupRes.body.variantSKUs.map((v: any) => String(v || "")).filter(Boolean) : [];
  const offerRows: any[] = [];
  for (const sku of variantSkus) {
    const offersRes = await ebayFetch(`/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`);
    if (offersRes.status === 200 && Array.isArray(offersRes.body?.offers)) {
      offersRes.body.offers.forEach((offer: any) => offerRows.push({ sku, offer }));
    }
  }
  const publishedOffers = offerRows.filter(({ offer }) => String(offer?.status || "").toUpperCase() === "PUBLISHED");
  const listingId = publishedOffers.map(({ offer }) => offer?.listing?.listingId || offer?.listingId || null).find(Boolean) || null;

  return jsonResp({
    ok: true,
    verification: {
      inventory_group_found: true,
      variant_sku_count: variantSkus.length,
      offer_count: offerRows.length,
      published_offer_found: publishedOffers.length > 0,
      published_verification_passed: publishedOffers.length > 0 && !!listingId,
      listing_id: listingId,
    },
    inventory_item_group: groupRes.body,
    offers: offerRows.map(({ sku, offer }) => ({
      sku,
      offerId: offer.offerId,
      status: offer.status,
      marketplaceId: offer.marketplaceId,
      listingId: offer?.listing?.listingId || offer?.listingId || null,
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

    if (action === "lookup-group" && req.method === "GET") {
      const inventoryGroupKey = url.searchParams.get("inventory_group_key") || "";
      const marketplaceId = url.searchParams.get("marketplace_id") || "EBAY_US";
      return await handleLookupGroup(inventoryGroupKey, marketplaceId);
    }

    if (action === "publish" && req.method === "POST") {
      // V2 eBay registration UI calls ebay-bridge directly, like shopee-bridge/joom-bridge.
      // requireAuthenticatedUser above remains the auth boundary; do not require the
      // server-only platform bridge token from browser-originated publish requests.
      const body = await req.json();
      return await handlePublish(body);
    }

    if (action === "publish-variation" && req.method === "POST") {
      const body = await req.json();
      return await handlePublishVariation(body);
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
