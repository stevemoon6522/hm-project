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

// Steve's eBay shipping business policies for K-pop album listings.
// READY STOCK must use the ready-stock shipping policy; PRE-ORDER and
// unknown legacy calls keep the existing pre-order default.
const EBAY_PRE_ORDER_FULFILLMENT_POLICY_ID = "253030471025";
const EBAY_PRE_ORDER_FULFILLMENT_POLICY_NAME = "ALBUM PRE-ORDER";
const EBAY_READY_STOCK_FULFILLMENT_POLICY_ID = "233825118025";
const EBAY_READY_STOCK_FULFILLMENT_POLICY_NAME = "READY STOCK";
const EBAY_DEFAULT_FULFILLMENT_POLICY_ID = EBAY_PRE_ORDER_FULFILLMENT_POLICY_ID;
const EBAY_DEFAULT_FULFILLMENT_POLICY_NAME = EBAY_PRE_ORDER_FULFILLMENT_POLICY_NAME;
const EBAY_PRICE_GUARD_MIN_USD = 1.00;
const EBAY_PRICE_GUARD_TOLERANCE_USD = 0.02;
const EBAY_PRICE_GUARD_MAX_DELTA_RATIO = 0.50;

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

type EbayLifecycleState = "pre_order" | "ready_stock" | "";

function normalizeEbayLifecycleState(value: unknown): EbayLifecycleState {
  const normalized = s(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "ready_stock" || normalized === "ready" || normalized === "in_stock" || normalized === "on_hand") return "ready_stock";
  if (normalized === "pre_order" || normalized === "preorder") return "pre_order";
  return "";
}

function ebayFulfillmentPolicyForLifecycle(value: unknown): {
  lifecycleState: "pre_order" | "ready_stock";
  fulfillmentPolicyId: string;
  fulfillmentPolicyName: string;
} {
  const lifecycleState = normalizeEbayLifecycleState(value);
  if (lifecycleState === "ready_stock") {
    return {
      lifecycleState: "ready_stock",
      fulfillmentPolicyId: EBAY_READY_STOCK_FULFILLMENT_POLICY_ID,
      fulfillmentPolicyName: EBAY_READY_STOCK_FULFILLMENT_POLICY_NAME,
    };
  }
  return {
    lifecycleState: "pre_order",
    fulfillmentPolicyId: EBAY_DEFAULT_FULFILLMENT_POLICY_ID,
    fulfillmentPolicyName: EBAY_DEFAULT_FULFILLMENT_POLICY_NAME,
  };
}

async function ensurePolicies(marketplaceId: string, lifecycleState?: unknown): Promise<{
  fulfillmentPolicyId: string;
  fulfillmentPolicyName: string;
  returnPolicyId: string;
  paymentPolicyId: string;
  lifecycleState: "pre_order" | "ready_stock";
}> {
  const fulfillmentPolicy = ebayFulfillmentPolicyForLifecycle(lifecycleState);

  // Check persistent store first
  const { data: stored } = await supabase
    .from("ebay_policy_ids")
    .select("fulfillment_policy_id, return_policy_id, payment_policy_id")
    .eq("marketplace_id", marketplaceId)
    .single();

  if (stored?.return_policy_id && stored?.payment_policy_id) {
    return {
      ...fulfillmentPolicy,
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

  const fulfillmentPolicyId = fulfillmentPolicy.fulfillmentPolicyId;
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
    ...fulfillmentPolicy,
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
const EBAY_KPOP_CD_CATEGORY_ID = "176984";
const EBAY_KPOP_REQUIRED_ASPECTS = ["Artist", "Release Title"];
const EBAY_HEADLESS_CONFIRM_PHRASE = "PUBLISH_EBAY_LISTING";
const EBAY_HEADLESS_WITHDRAW_CONFIRM_PHRASE = "WITHDRAW_EBAY_LISTING";
const EBAY_HEADLESS_POLICY_CONFIRM_PHRASE = "UPDATE_EBAY_FULFILLMENT_POLICY";
const EBAY_US_DIRECT_SHIPPING_RATES_KRW: Record<number, number> = {
  100: 7200,
  200: 8900,
  300: 10500,
  400: 12300,
  500: 14400,
  600: 15800,
  700: 17200,
  800: 18500,
  900: 19900,
  1000: 20700,
};

function s(value: unknown, fallback = ""): string {
  return value == null ? fallback : String(value);
}

function n(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function hasAspectValue(aspects: Record<string, string[]>, name: string): boolean {
  const values = Array.isArray(aspects?.[name]) ? aspects[name] : [];
  return values.some((value) => String(value || "").trim().length > 0);
}

function validateRequiredMusicAspects(categoryId: string, aspects: Record<string, string[]>): void {
  if (String(categoryId || "") !== EBAY_KPOP_CD_CATEGORY_ID) return;
  const missing = EBAY_KPOP_REQUIRED_ASPECTS.filter((name) => !hasAspectValue(aspects, name));
  if (missing.length) {
    throw new Error(`eBay category ${EBAY_KPOP_CD_CATEGORY_ID} requires item specific ${missing.join(", ")}.`);
  }
}

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

function parseLooseStringArray(value: any): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v || ""));
  const text = String(value || "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v || ""));
    } catch {
      // Fall through to delimiter parsing.
    }
  }
  return text.split(/[\n,;]+/).map((v) => v.trim()).filter(Boolean);
}

function stripLifecycleTags(value: unknown): string {
  return s(value)
    .replace(/\s*\[(?:PRE\s*[- ]?\s*ORDER|READY\s*[- ]?\s*STOCK|ON\s*HAND|FAST\s*DELIVERY)\]\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isListingStatusTag(value: unknown): boolean {
  return /^(?:PRE\s*[- ]?\s*ORDER|READY\s*[- ]?\s*STOCK|ON\s*HAND|FAST\s*DELIVERY)$/i.test(s(value).trim());
}

function normalizeDerivedTitleToken(value: unknown): string {
  return s(value)
    .replace(/[^\x00-\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'`]+|[\s"'`]+$/g, "");
}

function stripListingStatusPrefix(value: unknown): string {
  let out = s(value).trim();
  for (let i = 0; i < 5; i++) {
    const next = out
      .replace(/^\s*\[(?:PRE\s*[- ]?\s*ORDER|READY\s*[- ]?\s*STOCK|ON\s*HAND|FAST\s*DELIVERY)\]\s*/i, "")
      .replace(/^\s*(?:PRE\s*[- ]?\s*ORDER|READY\s*[- ]?\s*STOCK|ON\s*HAND|FAST\s*DELIVERY)\s*[-:]\s*/i, "")
      .trim();
    if (next === out) break;
    out = next;
  }
  return normalizeDerivedTitleToken(out);
}

function firstMeaningfulBracketValue(title: string): string {
  const re = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(title))) {
    const value = normalizeDerivedTitleToken(m[1]);
    if (value && !isListingStatusTag(value)) return value;
  }
  return "";
}

function fallbackAlbumFromDashRemainder(value: string): string {
  return normalizeDerivedTitleToken(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:\d+(?:st|nd|rd|th)?\s+)?(?:EP|ALBUM|MINI|FULL|SINGLE)\b.*$/i, " ")
    .replace(/\b(?:WEVERSE|PLATFORM|PHOTOBOOK|DIGIPACK|JEWEL|STANDARD)\s+VER\.?.*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function leadingUppercaseTokenBlock(value: string): string {
  const tokens = String(value || "").trim().split(/\s+/);
  const artistTokens: string[] = [];
  for (const token of tokens) {
    const cleaned = token.replace(/^[^A-Za-z0-9&]+|[^A-Za-z0-9&]+$/g, "");
    if (!cleaned) continue;
    if (!/^[A-Z0-9&]+$/.test(cleaned) || !/[A-Z]/.test(cleaned)) break;
    artistTokens.push(cleaned);
  }
  return artistTokens.join(" ");
}

function deriveEbayKpopFromTitle(title: unknown): { artist: string; album: string; version: string; member: string } {
  const out = { artist: "", album: "", version: "", member: "" };
  const eng = stripListingStatusPrefix(title);
  if (!eng) return out;

  const dashM = eng.match(/^(.+?)\s+-\s+(.+)$/);
  let remainder = eng;
  if (dashM) {
    const artist = normalizeDerivedTitleToken(dashM[1].replace(/\([^)]*\)\s*$/, ""));
    if (artist) out.artist = artist;
    remainder = stripListingStatusPrefix(dashM[2]);
  } else {
    out.artist = leadingUppercaseTokenBlock(eng);
  }

  const album = firstMeaningfulBracketValue(remainder) || firstMeaningfulBracketValue(eng);
  if (album) out.album = album;
  else if (dashM) out.album = fallbackAlbumFromDashRemainder(remainder);

  const verM = eng.match(/\(([^)]+?)\s+[Vv][Ee][Rr]\.?\s*\)/);
  if (verM) out.version = verM[1].trim();
  if (!out.version) {
    const parenRe = /\(([^)]+)\)/g;
    const parenCandidates: string[] = [];
    let parenM: RegExpExecArray | null;
    while ((parenM = parenRe.exec(eng))) {
      const value = normalizeDerivedTitleToken(parenM[1]);
      if (!value || isListingStatusTag(value)) continue;
      if (out.artist && value.toUpperCase() === out.artist.toUpperCase()) continue;
      parenCandidates.push(value.replace(/\s+[Vv][Ee][Rr]\.?$/i, "").trim());
    }
    out.version = parenCandidates.filter(Boolean).pop() || "";
  }
  return out;
}

function ebayShippingWeightBucketG(weightG: unknown): number {
  const w = Number(weightG) || 0;
  if (w <= 0) return 0;
  if (w <= 1000) return Math.ceil(w / 100) * 100;
  return 1000;
}

function ebayGetUsShippingRateKrw(weightG: unknown): number {
  const bucket = ebayShippingWeightBucketG(weightG);
  return bucket ? EBAY_US_DIRECT_SHIPPING_RATES_KRW[bucket] || 0 : 0;
}

async function loadEbayExCountrySettings(): Promise<Record<string, number>> {
  const fallback = {
    exchangeRate: 1380,
    pgFee: 1.45,
    salesFee: 15.3,
    fspFee: 0,
    otherFee: 0,
    settlementFee: 0,
    gst: 0,
    fspCcb: 0,
    importDuty: 0,
    fixedServiceFee: 0.40,
    purchaseVat: 0,
  };
  const { data, error } = await supabase
    .from("country_settings")
    .select("exchange_rate,pg_fee,sales_fee,fsp_fee,other_fee,settlement_fee,gst,fsp_ccb,import_duty,fixed_service_fee,purchase_vat")
    .eq("country_code", "EX")
    .maybeSingle();
  if (error || !data) return fallback;
  const nf = (value: unknown, defaultValue: number) =>
    value === null || value === undefined || value === "" ? defaultValue : n(value, defaultValue);
  return {
    exchangeRate: nf(data.exchange_rate, fallback.exchangeRate),
    pgFee: nf(data.pg_fee, fallback.pgFee),
    salesFee: nf(data.sales_fee, fallback.salesFee),
    fspFee: nf(data.fsp_fee, fallback.fspFee),
    otherFee: nf(data.other_fee, fallback.otherFee),
    settlementFee: nf(data.settlement_fee, fallback.settlementFee),
    gst: nf(data.gst, fallback.gst),
    fspCcb: nf(data.fsp_ccb, fallback.fspCcb),
    importDuty: nf(data.import_duty, fallback.importDuty),
    fixedServiceFee: nf(data.fixed_service_fee, fallback.fixedServiceFee),
    purchaseVat: nf(data.purchase_vat, fallback.purchaseVat),
  };
}

function calcEbayUsdListing(costKrw: number, weightG: number, c: Record<string, number>): number {
  if (!costKrw || costKrw <= 0) return 0;
  const exchangeRate = Number(c.exchangeRate || 0);
  if (!exchangeRate || exchangeRate <= 0) return 0;
  const usShippingKrw = ebayGetUsShippingRateKrw(weightG);
  if (!usShippingKrw) return 0;
  const shipping = usShippingKrw / exchangeRate;
  const effectiveCost = costKrw * (1 - (c.purchaseVat || 0) / 100);
  const settlementLocal = effectiveCost / exchangeRate;
  const cr = (c.salesFee || 0) / 100;
  const vr = (c.gst || 0) / 100;
  const salesPg = (c.pgFee || 0) / 100;
  const salesFsp = (c.fspFee || 0) / 100;
  const salesOther = (c.otherFee || 0) / 100;
  const salesCcb = (c.fspCcb || 0) / 100;
  const settlePct = (c.settlementFee || 0) / 100;
  const fixedFee = c.fixedServiceFee || 0;
  const sf = salesPg + salesFsp + salesOther + salesCcb;
  if (settlePct >= 1) return 0;
  const incomeTarget = settlementLocal / (1 - settlePct);
  const denom = (1 + vr) * (1 - sf) - (cr + vr);
  const raw = denom > 0 ? (incomeTarget + shipping + fixedFee) / denom : 0;
  return Math.round(raw * 100) / 100;
}

async function loadEbayShippingSurchargeRows(weightG: number, exchangeRate: number): Promise<any[]> {
  const bucket = ebayShippingWeightBucketG(weightG);
  if (!bucket || !exchangeRate || exchangeRate <= 0) return [];
  const { data, error } = await supabase
    .from("ebay_shipping_country_rates")
    .select("country_code,country_name,weight_g,baseline_krw,standard_krw,delta_krw,surcharge_usd")
    .eq("weight_g", bucket)
    .gt("delta_krw", 0)
    .order("country_code", { ascending: true });
  if (error || !Array.isArray(data)) return [];
  return data
    .map((row: any) => {
      const deltaKrw = n(row.delta_krw, 0);
      const extraUsd = deltaKrw > 0 ? Math.ceil((deltaKrw / exchangeRate) * 100) / 100 : n(row.surcharge_usd, 0);
      return extraUsd > 0 ? {
        countryCode: s(row.country_code).toUpperCase(),
        countryName: s(row.country_name),
        weightBucketG: bucket,
        baselineKrw: n(row.baseline_krw, 0),
        standardKrw: n(row.standard_krw, 0),
        deltaKrw,
        extraShippingUsd: Number(extraUsd.toFixed(2)),
      } : null;
    })
    .filter(Boolean)
    .slice(0, 80);
}

async function buildEbayPricingContext(costKrw: number, weightG: number): Promise<any> {
  const exCountry = await loadEbayExCountrySettings();
  const exchangeRate = n(exCountry.exchangeRate, 0);
  const weightBucketG = ebayShippingWeightBucketG(weightG);
  const usShippingKrw = ebayGetUsShippingRateKrw(weightG);
  const usShippingUsd = exchangeRate > 0 ? usShippingKrw / exchangeRate : 0;
  const shippingSurchargesUsd = await loadEbayShippingSurchargeRows(weightG, exchangeRate);
  const priceUsd = calcEbayUsdListing(costKrw, weightG, exCountry);
  return { exCountry, priceUsd, weightBucketG, usShippingKrw, usShippingUsd, shippingSurchargesUsd };
}

function buildEbayImageUrlsFromProduct(product: any, body: any = {}): string[] {
  const raw = [
    s(body.mainImage || body.main_image || product.main_image),
    ...parseLooseStringArray(body.extraImages || body.extra_images || product.extra_images),
    ...parseLooseStringArray(body.imageUrls || body.image_urls),
  ];
  return normalizeImageUrls(raw, 24);
}

function ebayDescriptionForPayload(value: unknown): string {
  const text = s(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (/<(?:table|tr|td|th|thead|tfoot|tbody|caption|colgroup|col|ul|ol|li|br|strong|b)\b/i.test(text)) {
    return text.slice(0, 4000);
  }
  return text.replace(/\n/g, "<br>\n").slice(0, 4000);
}

function ebayHtmlEscape(value: unknown): string {
  return s(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch] || ch));
}

function ebayDescriptionCard(title: string, bodyHtml: string, bgColor = "#fff7fb"): string {
  return `<table width="100%" bgcolor="${bgColor}"><tr><td><b>${ebayHtmlEscape(title)}</b><br>${bodyHtml}</td></tr></table>`;
}

function ebayDescriptionList(items: string[]): string {
  const html = items
    .map((value) => s(value).trim())
    .filter(Boolean)
    .map((value) => `<li>${ebayHtmlEscape(value.slice(0, 260))}</li>`)
    .join("");
  return html ? `<ul>${html}</ul>` : "";
}

function ebayDescriptionTable(headers: string[], rows: string[][]): string {
  const head = `<tr>${(headers || [])
    .map((value) => `<td><b>${ebayHtmlEscape(s(value).slice(0, 80))}</b></td>`)
    .join("")}</tr>`;
  const body = (rows || [])
    .map((row) => `<tr>${(row || [])
      .map((value) => `<td>${ebayHtmlEscape(s(value).slice(0, 220))}</td>`)
      .join("")}</tr>`)
    .join("");
  return `<table width="100%" border="1">${head}${body}</table>`;
}

function ebayComponentLines(components: string): string[] {
  return s(components)
    .split(/\n+/)
    .map((value) => value.replace(/^[\s*-]+/, "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function buildEbayDescriptionText(product: any, title: string, lifecycleState: EbayLifecycleState = ""): string {
  const components = s(product.components_extracted_en).trim() || "- EACH OPTION INCLUDE 1 ALBUM";
  const componentLines = ebayComponentLines(components);
  const stockLine = lifecycleState === "ready_stock"
    ? "Ready stock ships in about 1 business day, excluding weekends and Korean holidays."
    : "Pre-order ships after official release and warehouse arrival; distributor delays may change the schedule.";
  const shippingTable = ebayDescriptionTable(
    ["Service", "Destination area", "Estimated transit after dispatch"],
    [
      ["Economy / Standard", "US, CA, AU, JP, SG, HK, Asia", "Usually 5-20 business days; delayed parcels may take 20-30."],
      ["Economy / Standard", "UK, DE, FR, ES, most Europe", "Usually 10-30 business days; customs or local backlog may add days."],
      ["Economy / Standard", "Brazil, Italy, South America, Africa, remote regions", "Usually 20-50 business days; slower customs is common."],
      ["Expedited", "US/CA/MX 2-5 days; Asia/AU 3-7; UK/EU 4-8; South America/Africa/remote 5-10+", "Used when selected, upgraded, or required for a destination."],
    ],
  );
  const cards = [
    ebayDescriptionCard(
      "Album product information",
      `Hello, K-pop collector. Official K-pop goods from Korea, packed carefully.<br><br><strong>${ebayHtmlEscape(title)}</strong><br>${
        ebayDescriptionList([
          "100% Official & Authentic K-POP item, brand new from official Korean distributors.",
          "Eligible albums may support Hanteo and Circle chart counts through official channels.",
        ])
      }`,
      "#fff7fb",
    ),
    ebayDescriptionCard(
      "What is included / Handling before shipment",
      ebayDescriptionList((componentLines.length ? componentLines : ["Each option includes 1 album. Random inclusions follow the official manufacturer policy."]).concat([
        stockLine,
        "Ships only to the buyer's eBay checkout address. Confirm name, address, and phone before payment.",
        "Tracking uploads after dispatch; the first scan may take 24-48 hours.",
      ])),
      "#f8fbff",
    ),
    ebayDescriptionCard(
      "International shipping time guide",
      `Estimates exclude handling, weekends, holidays, customs, and local delays.<br>${shippingTable}`,
      "#fffaf0",
    ),
    ebayDescriptionCard(
      "Customs, Duties & Taxes",
      `<strong>For buyers in the United States (DDP Service)</strong>${
        ebayDescriptionList([
          "Guaranteed Landed Cost: For standard US DDP orders, applicable import duties and customs taxes are handled in advance through our logistics solution. Checkout price is final for covered orders.",
          "Zero Hidden Fees: Customs costs are prepaid, so the courier should not request extra brokerage or delivery customs fees on arrival.",
          "Optimization Promise: Specialized logistics consolidation helps keep customs clearance compliant and administrative costs low.",
        ])
      }<strong>For international buyers (Europe, Asia, Australia, Canada & More)</strong>${
        ebayDescriptionList([
          "Transparent Pricing: Listing prices generally do not include destination import duties or VAT unless eBay collects them at checkout.",
          "Payment of Taxes: Local duties, VAT, GST, brokerage, or handling charges are government taxes, not shipping fees, and may be collected by the carrier before delivery.",
          "Our Promise: We prepare customs documents carefully. If documents are needed, message us via eBay and we will respond quickly.",
          "Delivery Cooperation: Please check local customs rules. If returned because customs charges are unpaid, return shipping costs may be deducted from the refund.",
        ])
      }`,
      "#f8fafc",
    ),
    ebayDescriptionCard(
      "Important notice and friendly support",
      ebayDescriptionList([
        "Outer packaging may have small marks from production or shipping. Random inclusions cannot be selected unless the option title says so.",
        "Please message us via eBay first. Returns follow eBay policy; items must be unused, unopened, and complete. Address errors, refusal, or unpaid fees may reduce the refund.",
      ]),
      "#fff7fb",
    ),
  ];
  return cards.join("<br>\n").slice(0, 4000);
}

function buildEbayAspectsFromProduct(product: any, title: string): Record<string, string[]> {
  const derived = deriveEbayKpopFromTitle(title || product.product_name || product.sku);
  const storedArtist = normalizeDerivedTitleToken(product.artist || product.brand || product.shopee_brand_name || "");
  const storedAlbum = normalizeDerivedTitleToken(product.album || product.release_title || "");
  const artist = String(derived.artist || (isListingStatusTag(storedArtist) ? "" : storedArtist) || "").trim().slice(0, 50);
  const releaseTitle = String((isListingStatusTag(storedAlbum) ? "" : storedAlbum) || derived.album || stripLifecycleTags(product.product_name) || product.sku || "").trim().slice(0, 50);
  const releaseTypeSource = `${product.product_name || ""} ${storedAlbum || ""}`.toLowerCase();
  const aspects: Record<string, string[]> = {
    Type: [releaseTypeSource.includes("mini") || releaseTypeSource.includes("ep") ? "Mini Album" : "Album"],
    Format: ["CD"],
    Genre: ["K-Pop"],
    Style: ["K-Pop"],
    "Country of Origin": ["Korea, South"],
  };
  if (artist) {
    aspects.Artist = [artist];
    aspects["Record Label"] = [s(product.record_label || artist).slice(0, 50)];
  }
  if (releaseTitle) aspects["Release Title"] = [releaseTitle];
  const year = s(product.release_year || product.year).trim();
  if (/^(19|20)\d{2}$/.test(year)) aspects["Release Year"] = [year];
  return aspects;
}

function mergeAspects(base: Record<string, string[]>, override: any): Record<string, string[]> {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const out: Record<string, string[]> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const values = Array.isArray(value) ? value : [value];
    const clean = values.map((v) => s(v).trim()).filter(Boolean).slice(0, 10);
    if (key && clean.length) out[key] = clean;
  }
  return out;
}

async function buildHeadlessEbayProductPayload(product: any, body: any = {}): Promise<{ payload: any; pricing: any; derived: any }> {
  const sku = s(body.sku || body.ebay_sku || product.ebay_sku || product.sku).trim();
  const title = s(body.title || product.product_name || sku).replace(/\s+/g, " ").trim().slice(0, 80);
  const categoryId = s(body.categoryId || body.category_id || product.ebay_category_id || EBAY_KPOP_CD_CATEGORY_ID).trim() || EBAY_KPOP_CD_CATEGORY_ID;
  const costKrw = n(body.costKrw || body.cost_krw || product.cost_krw, 0);
  const weightG = n(body.weightG || body.weight_g || product.weight_g, 0);
  const pricing = await buildEbayPricingContext(costKrw, weightG);
  const overridePrice = n(body.priceUsd || body.price_usd || product.ebay_price_usd || product.ebay_last_synced_price, 0);
  const priceUsd = overridePrice > 0 ? overridePrice : n(pricing.priceUsd, 0);
  const qRaw = Number(body.quantity ?? body.inventory ?? product.inventory ?? product.stock ?? 0);
  const quantity = Number.isFinite(qRaw) && qRaw > 0 ? Math.max(1, Math.floor(qRaw)) : 3;
  const lifecycleState = normalizeEbayLifecycleState(body.lifecycleState || body.lifecycle_state || product.lifecycle_state) || "pre_order";
  const imageUrls = buildEbayImageUrlsFromProduct(product, body);
  const aspects = mergeAspects(buildEbayAspectsFromProduct(product, title), body.aspects);
  const descriptionText = s(body.description || body.ebay_description || "").trim()
    || buildEbayDescriptionText(product, title, lifecycleState);
  const derived = deriveEbayKpopFromTitle(title);

  return {
    payload: {
      listingMode: "single",
      productId: product.id || body.product_id || null,
      productGroupId: product.product_group_id || body.product_group_id || "",
      sku,
      title,
      description: ebayDescriptionForPayload(descriptionText),
      imageUrls,
      aspects,
      condition: "NEW",
      priceUsd: Number(priceUsd).toFixed(2),
      quantity,
      categoryId,
      lifecycleState,
      storeCategoryNames: normalizeStoreCategoryNames(body.storeCategoryNames || body.store_category_names || ["/K-pop"]),
      weightG,
      weightBucketG: pricing.weightBucketG,
      usShippingKrw: pricing.usShippingKrw,
      usShippingUsd: Number(n(pricing.usShippingUsd, 0).toFixed(2)),
      shippingSurchargePolicy: "delta_vs_us_baseline",
      shippingSurchargesUsd: pricing.shippingSurchargesUsd,
      marketplaceId: s(body.marketplaceId || body.marketplace_id || product.ebay_marketplace_id || "EBAY_US"),
    },
    pricing,
    derived,
  };
}

function validateHeadlessSinglePayload(payload: any): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  try { validateSku(payload.sku); } catch (e: any) { errors.push(String(e?.message || e)); }
  if (!payload.title) errors.push("title is required");
  if (payload.title && payload.title.length > 80) errors.push(`title max length exceeded: ${payload.title.length}`);
  if (!payload.categoryId || !/^\d+$/.test(String(payload.categoryId))) errors.push("numeric categoryId is required");
  try { validateDescription(payload.description || ""); } catch (e: any) { errors.push(String(e?.message || e)); }
  const images = normalizeImageUrls(payload.imageUrls, 24);
  if (!images.length) errors.push("at least one HTTPS image URL is required");
  if (images.length === 1) warnings.push("Only one image URL is present; eBay can publish it, but extra detail images are recommended.");
  const price = Number(payload.priceUsd || 0);
  if (!Number.isFinite(price) || price < 1) errors.push("priceUsd must be at least 1.00");
  const quantity = Number(payload.quantity || 0);
  if (!Number.isFinite(quantity) || quantity < 1) errors.push("quantity must be at least 1");
  const weightG = Number(payload.weightG || 0);
  if (!Number.isFinite(weightG) || weightG <= 0) errors.push("weightG must be greater than 0");
  try { validateAspects(payload.aspects || {}); } catch (e: any) { errors.push(String(e?.message || e)); }
  try { validateRequiredMusicAspects(String(payload.categoryId), payload.aspects || {}); } catch (e: any) { errors.push(String(e?.message || e)); }
  return { ok: errors.length === 0, errors, warnings };
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
    lifecycleState,
    lifecycle_state,
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
  validateRequiredMusicAspects(String(categoryId), safeAspects);

  // Condition: only NEW — Codex BLOCKER §a + Operator Decision #6 (conditionDescriptors OFF)
  // Citation: sell/inventory.yaml L8527 — NEW is the correct enum for brand new items
  const conditionEnum = "NEW";  // always NEW regardless of input

  // Step 0: Ensure merchantLocation exists (idempotent)
  await ensureMerchantLocation();

  // Step 1: Get policy IDs (from cache or Account API)
  const {
    fulfillmentPolicyId,
    fulfillmentPolicyName,
    returnPolicyId,
    paymentPolicyId,
    lifecycleState: policyLifecycleState,
  } = await ensurePolicies(marketplaceId, lifecycleState || lifecycle_state);

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
    lifecycle_state: policyLifecycleState,
    fulfillment_policy_id: fulfillmentPolicyId,
    fulfillment_policy_name: fulfillmentPolicyName,
    shipping_surcharge_policy: shippingSurchargePolicy,
    shipping_surcharges_usd: safeShippingSurcharges,
    listingStatus: "PUBLISHED",
  });
}

async function handlePublish(body: any): Promise<Response> {
  return await withEbayPublishRun("single", body, () => handlePublishSingle(body));
}

// ---------------------------------------------------------------------------
// /update-price handler — price-only revision of a single published offer
// Citation: sell/inventory.yaml bulkUpdatePriceQuantity :484-543
//   BulkPriceQuantity :6987, PriceQuantity :10544, OfferPriceQuantity :10177,
//   Amount :6734, BulkPriceQuantityResponse :7002, PriceQuantityResponse :10594
// Design: §RC1 stock-safe (no availableQuantity), §RC2 one SKU/call,
//   §RC3 PUBLISHED+FIXED_PRICE resolution, §RC4 strict per-offer success check,
//   §RC5 ebay_sku required (no fallback), §RC7 Amount shape
// ---------------------------------------------------------------------------

async function handleUpdatePrice(body: any): Promise<Response> {
  const { sku, priceUsd, offerId: callerOfferId, marketplaceId = "EBAY_US" } = body || {};
  let resolvedMarketplaceId = String(marketplaceId || "EBAY_US");
  let resolvedCallerOfferId = callerOfferId;

  // §RC5: sku is required; no fallback
  try { validateSku(sku); } catch (e: any) {
    return jsonResp({ ok: false, error: e.message }, 400);
  }

  // §RC7: priceUsd must be finite and > 0
  const priceNum = Number(priceUsd);
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    return jsonResp({ ok: false, error: "invalid_price" }, 400);
  }

  const priceGuard = await guardEbayUpdatePrice(body, String(sku), priceNum, resolvedMarketplaceId, callerOfferId);
  if (!priceGuard.ok) {
    const { status = 409, ...guardBody } = priceGuard;
    return jsonResp({ ok: false, ...guardBody }, status);
  }
  resolvedMarketplaceId = priceGuard.marketplaceId || resolvedMarketplaceId;
  resolvedCallerOfferId = priceGuard.offerId || resolvedCallerOfferId;

  // Step 1: getOffers for this SKU on this marketplace
  // Citation: sell/inventory.yaml getOffers :3787
  const offersRes = await ebayFetch(
    `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${resolvedMarketplaceId}`
  );

  // Mirror 401/403/429 passthrough — matches handleLookupItem :854-858
  if (offersRes.status !== 200 && offersRes.status !== 404) {
    const passthroughStatus = (offersRes.status === 401 || offersRes.status === 403 || offersRes.status === 429)
      ? offersRes.status : 502;
    return jsonResp({
      ok: false,
      error: "upstream_offer_lookup_failed",
      upstream_status: offersRes.status,
    }, passthroughStatus);
  }

  const allOffers: any[] = offersRes.status === 200 ? (offersRes.body?.offers || []) : [];
  if (!allOffers.length) {
    return jsonResp({ ok: false, error: "no_offer_for_sku" });
  }

  // §RC3: keep only PUBLISHED + FIXED_PRICE offers
  // Citation: Offer.status :7478-7483, Offer.format :7330-7334
  const candidates = allOffers.filter(
    (o: any) => String(o.status || "").toUpperCase() === "PUBLISHED"
      && String(o.format || "").toUpperCase() === "FIXED_PRICE"
  );

  let targetOffer: any;
  if (resolvedCallerOfferId) {
    // Caller passed an explicit offerId — it MUST be in the candidate set
    targetOffer = candidates.find((o: any) => String(o.offerId) === String(resolvedCallerOfferId));
    if (!targetOffer) {
      return jsonResp({ ok: false, error: "offer_id_not_published_fixed_price" });
    }
  } else if (candidates.length === 1) {
    targetOffer = candidates[0];
  } else if (candidates.length === 0) {
    return jsonResp({ ok: false, error: "offer_not_found" });
  } else {
    // >1 candidate and no offerId disambiguation — fail safely (§RC3)
    return jsonResp({
      ok: false,
      error: "ambiguous_offers",
      offerIds: candidates.map((o: any) => String(o.offerId)),
    });
  }

  const resolvedOfferId: string = String(targetOffer.offerId);

  // Step 2: build price-only BulkPriceQuantity payload
  // §RC1: NO availableQuantity, NO shipToLocationAvailability, NO request-level sku
  // §RC2: one SKU per call — single requests[] entry with one offer
  // §RC7: Amount.value is a string, currency required
  // Citation: BulkPriceQuantity :6987, PriceQuantity :10544, OfferPriceQuantity :10177, Amount :6734
  const payload = {
    requests: [
      {
        offers: [
          {
            offerId: resolvedOfferId,
            price: {
              value: priceNum.toFixed(2),
              currency: "USD",
            },
          },
        ],
      },
    ],
  };

  // Step 3: POST bulkUpdatePriceQuantity
  // Citation: sell/inventory.yaml :484
  const updateRes = await ebayFetch(
    "/sell/inventory/v1/bulk_update_price_quantity",
    { method: "POST", body: JSON.stringify(payload) }
  );

  // Mirror 401/403/429 passthrough
  if (updateRes.status !== 200) {
    const passthroughStatus = (updateRes.status === 401 || updateRes.status === 403 || updateRes.status === 429)
      ? updateRes.status : 502;
    return jsonResp({
      ok: false,
      error: "upstream_update_failed",
      upstream_status: updateRes.status,
      upstream: formatEbayErrorBody(updateRes.body),
    }, passthroughStatus);
  }

  // §RC4: strict per-offer success check
  // Citation: BulkPriceQuantityResponse.responses :7005-7013
  //   PriceQuantityResponse.statusCode :10614, PriceQuantityResponse.errors :10597
  const responses: any[] = updateRes.body?.responses || [];
  // Guard against a 200 with no per-offer response node — never report a silent no-op as success.
  if (responses.length === 0) {
    return jsonResp({ ok: false, error: "no_response_entries", upstream: updateRes.body });
  }
  const failedEntries = responses.filter(
    (r: any) => r.statusCode !== 200 || (Array.isArray(r.errors) && r.errors.length > 0)
  );
  if (failedEntries.length > 0) {
    return jsonResp({
      ok: false,
      error: "update_failed",
      upstream: failedEntries.map((r: any) => ({
        offerId: r.offerId,
        statusCode: r.statusCode,
        errors: r.errors || [],
      })),
    });
  }

  return jsonResp({ ok: true, offerId: resolvedOfferId, price: priceNum, serverPriceUsd: priceGuard.serverPriceUsd });
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
    lifecycleState,
    lifecycle_state,
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
  validateRequiredMusicAspects(String(categoryId), safeAspects);
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
  const {
    fulfillmentPolicyId,
    fulfillmentPolicyName,
    returnPolicyId,
    paymentPolicyId,
    lifecycleState: policyLifecycleState,
  } = await ensurePolicies(marketplaceId, lifecycleState || lifecycle_state);

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
    lifecycle_state: policyLifecycleState,
    fulfillment_policy_id: fulfillmentPolicyId,
    fulfillment_policy_name: fulfillmentPolicyName,
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

async function loadEbayProductForPriceGuard(sku: string, productId: unknown) {
  const select = [
    "id",
    "sku",
    "cost_krw",
    "weight_g",
    "ebay_sku",
    "ebay_offer_id",
    "ebay_item_id",
    "ebay_status",
    "ebay_last_synced_price",
    "ebay_marketplace_id",
  ].join(",");

  let query = supabase.from("products").select(select);
  if (productId) {
    query = query.eq("id", String(productId)).limit(1);
  } else {
    query = query.eq("ebay_sku", sku).limit(2);
  }

  const { data, error } = await query;
  if (error) {
    return { ok: false, status: 500, error: "product_lookup_failed", detail: error.message };
  }

  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  if (!rows.length) {
    return { ok: false, status: 409, error: "product_mapping_required" };
  }
  if (!productId && rows.length > 1) {
    return { ok: false, status: 409, error: "ambiguous_product_mapping" };
  }

  return { ok: true, product: rows[0] };
}

async function guardEbayUpdatePrice(body: any, sku: string, priceNum: number, marketplaceId: string, callerOfferId: unknown) {
  if (priceNum < EBAY_PRICE_GUARD_MIN_USD) {
    return { ok: false, status: 400, error: "min_price_guard_failed", minPriceUsd: EBAY_PRICE_GUARD_MIN_USD };
  }

  const productId = body?.productId || body?.product_id || null;
  const lookup = await loadEbayProductForPriceGuard(sku, productId);
  if (!lookup.ok) return lookup;

  const product = lookup.product;
  const productSku = s(product.ebay_sku).trim();
  if (productSku !== sku) {
    return { ok: false, status: 409, error: "sku_mapping_mismatch" };
  }

  const productStatus = s(product.ebay_status).toUpperCase();
  if (productStatus !== "PUBLISHED") {
    return { ok: false, status: 409, error: "product_not_published", productStatus: productStatus || null };
  }

  const productOfferId = s(product.ebay_offer_id).trim();
  if (!productOfferId) {
    return { ok: false, status: 409, error: "product_offer_mapping_required" };
  }
  if (callerOfferId && productOfferId !== String(callerOfferId)) {
    return { ok: false, status: 409, error: "offer_id_mismatch", productOfferId };
  }

  const resolvedMarketplaceId = s(product.ebay_marketplace_id || marketplaceId || "EBAY_US", "EBAY_US").trim() || "EBAY_US";
  if (product.ebay_marketplace_id && marketplaceId && resolvedMarketplaceId !== marketplaceId) {
    return { ok: false, status: 409, error: "marketplace_mismatch", productMarketplaceId: resolvedMarketplaceId };
  }

  const costKrw = n(product.cost_krw, 0);
  const weightG = n(product.weight_g, 0);
  if (costKrw <= 0 || weightG <= 0) {
    return { ok: false, status: 409, error: "product_cost_or_weight_required" };
  }

  const exCountry = await loadEbayExCountrySettings();
  const serverPriceUsd = calcEbayUsdListing(costKrw, weightG, exCountry);
  if (!Number.isFinite(serverPriceUsd) || serverPriceUsd <= 0) {
    return { ok: false, status: 409, error: "server_price_unavailable" };
  }

  const diff = Math.abs(priceNum - serverPriceUsd);
  if (diff > EBAY_PRICE_GUARD_TOLERANCE_USD) {
    return {
      ok: false,
      status: 409,
      error: "price_guard_failed",
      clientPriceUsd: Number(priceNum.toFixed(2)),
      serverPriceUsd,
      toleranceUsd: EBAY_PRICE_GUARD_TOLERANCE_USD,
    };
  }

  const previousPriceUsd = n(product.ebay_last_synced_price, 0);
  const allowLargePriceDelta =
    s(body?.confirmLargePriceDelta || body?.confirm_large_price_delta) === "ALLOW_EBAY_PRICE_DELTA";
  if (previousPriceUsd > 0 && !allowLargePriceDelta) {
    const deltaRatio = Math.abs(priceNum - previousPriceUsd) / previousPriceUsd;
    if (deltaRatio > EBAY_PRICE_GUARD_MAX_DELTA_RATIO) {
      return {
        ok: false,
        status: 409,
        error: "price_delta_guard_failed",
        previousPriceUsd: Number(previousPriceUsd.toFixed(2)),
        serverPriceUsd,
        maxDeltaRatio: EBAY_PRICE_GUARD_MAX_DELTA_RATIO,
      };
    }
  }

  return {
    ok: true,
    product,
    offerId: productOfferId,
    marketplaceId: resolvedMarketplaceId,
    serverPriceUsd,
  };
}

// ---------------------------------------------------------------------------
// /register-product handler -- headless DB product -> single-SKU publish path
// ---------------------------------------------------------------------------

async function loadHeadlessProduct(body: any): Promise<any> {
  const productId = s(body?.product_id || body?.productId).trim();
  const sku = s(body?.sku || body?.ebay_sku).trim();
  if (!productId && !sku) throw new Error("product_id or sku is required");

  let query = supabase.from("products").select("*").limit(1);
  query = productId ? query.eq("id", productId) : query.eq("sku", sku);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`product lookup failed: ${error.message || String(error)}`);
  if (!data) throw new Error("product_not_found");
  return data;
}

function isProductAlreadyMapped(product: any): boolean {
  return !!(
    product?.ebay_item_id
    || product?.ebay_offer_id
    || String(product?.ebay_status || "").toUpperCase() === "PUBLISHED"
  );
}

async function persistHeadlessEbayPublishResult(product: any, payload: any, publishJson: any): Promise<any> {
  const now = new Date().toISOString();
  const update = {
    ebay_sku: payload.sku,
    ebay_item_id: publishJson.ebay_item_id,
    ebay_offer_id: publishJson.ebay_offer_id,
    ebay_status: "PUBLISHED",
    ebay_published_at: now,
    ebay_last_synced_price: Number(Number(payload.priceUsd || 0).toFixed(2)),
    ebay_last_synced_at: now,
    ebay_marketplace_id: payload.marketplaceId || "EBAY_US",
    ebay_mapping_status: "mapped",
    ebay_mapping_error: null,
    ebay_category_id: String(payload.categoryId),
    ebay_listing_mode: "single",
    ebay_inventory_group_key: null,
    ebay_variation_axis: null,
    ebay_variation_value: null,
    ebay_variation_image_url: null,
  };

  let query = supabase.from("products").update(update);
  if (product?.id) query = query.eq("id", product.id);
  else query = query.eq("sku", payload.sku);
  const { error } = await query;
  if (error) throw new Error(`product ebay mapping update failed: ${error.message || String(error)}`);
  return update;
}

async function handleRegisterProduct(body: any): Promise<Response> {
  const dryRun = body?.dry_run !== false && body?.dryRun !== false;
  const force = body?.force === true;
  const product = await loadHeadlessProduct(body || {});
  const { payload, pricing, derived } = await buildHeadlessEbayProductPayload(product, body || {});
  const validation = validateHeadlessSinglePayload(payload);
  const fulfillmentPolicyPreview = ebayFulfillmentPolicyForLifecycle(payload.lifecycleState);

  if (!validation.ok) {
    return jsonResp({
      ok: false,
      dry_run: dryRun,
      error: "validation_failed",
      validation,
      product_id: product.id || null,
      sku: payload.sku,
      fulfillmentPolicyPreview,
      payload,
    }, 400);
  }

  if (dryRun) {
    return jsonResp({
      ok: true,
      dry_run: true,
      product_id: product.id || null,
      sku: payload.sku,
      derived,
      validation,
      fulfillmentPolicyPreview,
      pricing: {
        priceUsd: pricing.priceUsd,
        weightBucketG: pricing.weightBucketG,
        usShippingKrw: pricing.usShippingKrw,
        usShippingUsd: Number(n(pricing.usShippingUsd, 0).toFixed(2)),
        shippingSurchargeCount: Array.isArray(pricing.shippingSurchargesUsd) ? pricing.shippingSurchargesUsd.length : 0,
      },
      payload,
    });
  }

  const confirmed = body?.confirm === EBAY_HEADLESS_CONFIRM_PHRASE || body?.confirm_publish === true;
  if (!confirmed) {
    return jsonResp({
      ok: false,
      error: "confirm_required",
      message: `Set dry_run=false and confirm="${EBAY_HEADLESS_CONFIRM_PHRASE}" to publish.`,
      product_id: product.id || null,
      sku: payload.sku,
      fulfillmentPolicyPreview,
      payload,
    }, 400);
  }

  if (!force && isProductAlreadyMapped(product)) {
    return jsonResp({
      ok: false,
      error: "already_mapped",
      message: "Product already has eBay mapping columns. Pass force=true only after operator review.",
      product_id: product.id || null,
      sku: payload.sku,
      existing: {
        ebay_sku: product.ebay_sku || null,
        ebay_item_id: product.ebay_item_id || null,
        ebay_offer_id: product.ebay_offer_id || null,
        ebay_status: product.ebay_status || null,
      },
    }, 409);
  }

  if (!force) {
    const preLookupResp = await handleLookupItem(payload.sku, payload.marketplaceId || "EBAY_US");
    const preLookup = await jsonFromResponse(preLookupResp);
    if (preLookup?.verification?.published_verification_passed) {
      return jsonResp({
        ok: false,
        error: "already_published",
        message: "eBay already has a published listing for this SKU. Pass force=true only after operator review.",
        product_id: product.id || null,
        sku: payload.sku,
        lookup: preLookup,
      }, 409);
    }
  }

  const publishResp = await handlePublish(payload);
  const publishJson = await jsonFromResponse(publishResp);
  if (!publishResp.ok || !publishJson?.ok || !publishJson?.ebay_item_id) {
    return jsonResp({
      ok: false,
      error: "publish_failed",
      product_id: product.id || null,
      sku: payload.sku,
      publish: publishJson,
    }, publishResp.status >= 400 ? publishResp.status : 502);
  }

  const lookupResp = await handleLookupItem(payload.sku, payload.marketplaceId || "EBAY_US");
  const lookupJson = await jsonFromResponse(lookupResp);
  const persisted = await persistHeadlessEbayPublishResult(product, payload, publishJson);

  return jsonResp({
    ok: true,
    dry_run: false,
    product_id: product.id || null,
    sku: payload.sku,
    ebay_item_id: publishJson.ebay_item_id,
    ebay_offer_id: publishJson.ebay_offer_id,
    marketplace_id: publishJson.marketplace_id || payload.marketplaceId || "EBAY_US",
    lifecycle_state: publishJson.lifecycle_state || payload.lifecycleState || null,
    fulfillment_policy_id: publishJson.fulfillment_policy_id || fulfillmentPolicyPreview.fulfillmentPolicyId,
    fulfillment_policy_name: publishJson.fulfillment_policy_name || fulfillmentPolicyPreview.fulfillmentPolicyName,
    verification: lookupJson?.verification || null,
    lookup_ok: lookupResp.ok && lookupJson?.verification?.published_verification_passed === true,
    persisted,
    publish: publishJson,
    lookup: lookupJson,
  });
}

// ---------------------------------------------------------------------------
// /withdraw-product handler -- headless published offer withdrawal + DB cleanup
// ---------------------------------------------------------------------------

async function loadHeadlessEbayMappedProduct(body: any): Promise<any> {
  const product = await loadHeadlessProduct(body || {});
  const sku = s(body?.sku || body?.ebay_sku || product.ebay_sku || product.sku).trim();
  if (!sku) throw new Error("sku or ebay_sku is required");
  return { product, sku };
}

function pickPublishedSingleOffer(offers: any[], preferredOfferId = ""): any | null {
  const publishedFixedPrice = (offers || []).filter((offer: any) =>
    String(offer?.status || "").toUpperCase() === "PUBLISHED"
      && String(offer?.format || "").toUpperCase() === "FIXED_PRICE"
  );
  if (preferredOfferId) {
    return publishedFixedPrice.find((offer: any) => String(offer?.offerId || "") === preferredOfferId) || null;
  }
  return publishedFixedPrice.length === 1 ? publishedFixedPrice[0] : null;
}

function compactDefinedObject(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined || value === null) continue;
    output[key] = value;
  }
  return output;
}

function listingIdFromOffer(offer: any, fallback = ""): string | null {
  const listingId = s(offer?.listing?.listingId || offer?.listingId || fallback).trim();
  return listingId || null;
}

function ebayPolicyTargetForBody(body: any, lifecycleState: unknown): {
  lifecycleState: "pre_order" | "ready_stock";
  fulfillmentPolicyId: string;
  fulfillmentPolicyName: string;
} {
  const requestedPolicyId = s(body?.fulfillmentPolicyId || body?.fulfillment_policy_id).trim();
  if (!requestedPolicyId) return ebayFulfillmentPolicyForLifecycle(lifecycleState);

  const normalizedLifecycle = normalizeEbayLifecycleState(lifecycleState);
  const fallbackLifecycle: "pre_order" | "ready_stock" =
    requestedPolicyId === EBAY_READY_STOCK_FULFILLMENT_POLICY_ID ? "ready_stock" : "pre_order";
  const lifecycle = normalizedLifecycle || fallbackLifecycle;
  const policyName =
    s(body?.fulfillmentPolicyName || body?.fulfillment_policy_name).trim()
    || (requestedPolicyId === EBAY_READY_STOCK_FULFILLMENT_POLICY_ID ? EBAY_READY_STOCK_FULFILLMENT_POLICY_NAME : "")
    || (requestedPolicyId === EBAY_PRE_ORDER_FULFILLMENT_POLICY_ID ? EBAY_PRE_ORDER_FULFILLMENT_POLICY_NAME : "")
    || "CUSTOM";

  return {
    lifecycleState: lifecycle,
    fulfillmentPolicyId: requestedPolicyId,
    fulfillmentPolicyName: policyName,
  };
}

function buildOfferPolicyUpdatePayload(offer: any, listingPolicies: any, product: any, body: any): Record<string, unknown> {
  const allowedOfferFields = [
    "availableQuantity",
    "categoryId",
    "charity",
    "extendedProducerResponsibility",
    "hideBuyerDetails",
    "includeCatalogProductDetails",
    "listingDescription",
    "listingDuration",
    "listingStartDate",
    "lotSize",
    "merchantLocationKey",
    "pricingSummary",
    "quantityLimitPerBuyer",
    "regulatory",
    "secondaryCategoryId",
    "storeCategoryNames",
    "tax",
  ];
  const payload: Record<string, unknown> = {};
  for (const field of allowedOfferFields) {
    if (offer?.[field] !== undefined && offer?.[field] !== null) payload[field] = offer[field];
  }

  const fallbackQuantity = Math.floor(n(body?.quantity ?? product?.inventory, 0));
  if (!payload.availableQuantity && fallbackQuantity > 0) payload.availableQuantity = fallbackQuantity;
  if (!payload.categoryId && product?.ebay_category_id) payload.categoryId = String(product.ebay_category_id);
  if (!payload.includeCatalogProductDetails) payload.includeCatalogProductDetails = false;
  if (!payload.listingDescription) {
    const description = s(product?.description || product?.product_name || product?.title).trim();
    if (description) payload.listingDescription = description;
  }
  if (!payload.listingDuration) payload.listingDuration = LISTING_DURATION;
  if (!payload.merchantLocationKey) payload.merchantLocationKey = MERCHANT_LOCATION_KEY;
  if (!payload.pricingSummary && n(product?.ebay_last_synced_price, 0) > 0) {
    payload.pricingSummary = {
      price: {
        value: n(product.ebay_last_synced_price, 0).toFixed(2),
        currency: "USD",
      },
    };
  }
  payload.listingPolicies = compactDefinedObject(listingPolicies || {});

  return compactDefinedObject(payload);
}

function missingPublishedOfferUpdateFields(payload: Record<string, unknown>): string[] {
  const listingPolicies: any = payload.listingPolicies || {};
  const pricingSummary: any = payload.pricingSummary || {};
  const missing: string[] = [];
  if (!payload.categoryId) missing.push("categoryId");
  if (!payload.listingDescription) missing.push("listingDescription");
  if (!payload.listingDuration) missing.push("listingDuration");
  if (!payload.merchantLocationKey) missing.push("merchantLocationKey");
  if (!payload.pricingSummary || !pricingSummary.price?.value || !pricingSummary.price?.currency) missing.push("pricingSummary.price");
  if (!payload.listingPolicies) missing.push("listingPolicies");
  if (!listingPolicies.fulfillmentPolicyId) missing.push("listingPolicies.fulfillmentPolicyId");
  if (!listingPolicies.paymentPolicyId) missing.push("listingPolicies.paymentPolicyId");
  if (!listingPolicies.returnPolicyId) missing.push("listingPolicies.returnPolicyId");
  return missing;
}

async function handleEnsureFulfillmentPolicy(body: any): Promise<Response> {
  const dryRun = body?.dry_run !== false && body?.dryRun !== false;
  const marketplaceId = s(body?.marketplaceId || body?.marketplace_id || "EBAY_US", "EBAY_US").trim() || "EBAY_US";
  const { product, sku } = await loadHeadlessEbayMappedProduct(body || {});
  const preferredOfferId = s(body?.offerId || body?.offer_id || product.ebay_offer_id).trim();
  const lifecycleInput = body?.lifecycleState || body?.lifecycle_state || product.lifecycle_state;
  const policyTarget = ebayPolicyTargetForBody(body || {}, lifecycleInput);

  const offersRes = await ebayFetch(
    `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`
  );
  if (offersRes.status !== 200 && offersRes.status !== 404) {
    const passthroughStatus = (offersRes.status === 401 || offersRes.status === 403 || offersRes.status === 429)
      ? offersRes.status : 502;
    return jsonResp({
      ok: false,
      error: "upstream_offer_lookup_failed",
      upstream_status: offersRes.status,
      upstream: formatEbayErrorBody(offersRes.body),
      product_id: product.id || null,
      sku,
      marketplace_id: marketplaceId,
    }, passthroughStatus);
  }

  const offers = offersRes.status === 200 ? (offersRes.body?.offers || []) : [];
  const targetOffer = pickPublishedSingleOffer(offers, preferredOfferId);
  const publishedOfferIds = offers
    .filter((offer: any) => String(offer?.status || "").toUpperCase() === "PUBLISHED")
    .map((offer: any) => String(offer?.offerId || ""))
    .filter(Boolean);

  if (!targetOffer) {
    return jsonResp({
      ok: false,
      dry_run: dryRun,
      error: publishedOfferIds.length > 1 && !preferredOfferId ? "ambiguous_published_offers" : "published_offer_not_found",
      product_id: product.id || null,
      sku,
      marketplace_id: marketplaceId,
      preferred_offer_id: preferredOfferId || null,
      published_offer_ids: publishedOfferIds,
      desired_fulfillment_policy_id: policyTarget.fulfillmentPolicyId,
    }, 409);
  }

  const offerId = String(targetOffer.offerId);
  const offerRes = await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`);
  if (offerRes.status !== 200) {
    const passthroughStatus = (offerRes.status === 401 || offerRes.status === 403 || offerRes.status === 429)
      ? offerRes.status : 502;
    return jsonResp({
      ok: false,
      error: "upstream_get_offer_failed",
      upstream_status: offerRes.status,
      upstream: formatEbayErrorBody(offerRes.body),
      product_id: product.id || null,
      sku,
      marketplace_id: marketplaceId,
      ebay_offer_id: offerId,
    }, passthroughStatus);
  }

  const currentOffer = offerRes.body || {};
  const currentPolicies = currentOffer.listingPolicies || {};
  const currentFulfillmentPolicyId = s(currentPolicies.fulfillmentPolicyId).trim();
  const policyIds = await ensurePolicies(marketplaceId, policyTarget.lifecycleState);
  const nextListingPolicies = {
    ...currentPolicies,
    fulfillmentPolicyId: policyTarget.fulfillmentPolicyId,
    paymentPolicyId: currentPolicies.paymentPolicyId || policyIds.paymentPolicyId,
    returnPolicyId: currentPolicies.returnPolicyId || policyIds.returnPolicyId,
  };
  const changed = currentFulfillmentPolicyId !== policyTarget.fulfillmentPolicyId;
  const updatePayload = buildOfferPolicyUpdatePayload(currentOffer, nextListingPolicies, product, body || {});
  const missingFields = missingPublishedOfferUpdateFields(updatePayload);
  const baseResult = {
    product_id: product.id || null,
    sku,
    marketplace_id: marketplaceId,
    ebay_offer_id: offerId,
    ebay_item_id: listingIdFromOffer(currentOffer, product.ebay_item_id || "") || listingIdFromOffer(targetOffer, product.ebay_item_id || ""),
    lifecycle_state: policyTarget.lifecycleState,
    current_fulfillment_policy_id: currentFulfillmentPolicyId || null,
    desired_fulfillment_policy_id: policyTarget.fulfillmentPolicyId,
    desired_fulfillment_policy_name: policyTarget.fulfillmentPolicyName,
    changed,
    missing_update_fields: missingFields,
  };

  if (dryRun || !changed) {
    return jsonResp({
      ok: true,
      dry_run: dryRun,
      updated: false,
      can_update: changed && missingFields.length === 0,
      ...baseResult,
    });
  }

  const confirmed = body?.confirm === EBAY_HEADLESS_POLICY_CONFIRM_PHRASE || body?.confirm_policy_update === true;
  if (!confirmed) {
    return jsonResp({
      ok: false,
      error: "confirm_required",
      message: `Set dry_run=false and confirm="${EBAY_HEADLESS_POLICY_CONFIRM_PHRASE}" to update fulfillment policy.`,
      ...baseResult,
    }, 400);
  }

  if (missingFields.length > 0) {
    return jsonResp({
      ok: false,
      error: "offer_update_payload_incomplete",
      ...baseResult,
    }, 409);
  }

  const updateRes = await ebayFetch(
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
    { method: "PUT", body: JSON.stringify(updatePayload) }
  );
  if (updateRes.status !== 200 && updateRes.status !== 204) {
    const passthroughStatus = (updateRes.status === 401 || updateRes.status === 403 || updateRes.status === 429)
      ? updateRes.status : 502;
    return jsonResp({
      ok: false,
      error: "upstream_update_offer_failed",
      upstream_status: updateRes.status,
      upstream: formatEbayErrorBody(updateRes.body),
      ...baseResult,
    }, passthroughStatus);
  }

  const verifyRes = await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`);
  const verifiedPolicyId = verifyRes.status === 200
    ? s(verifyRes.body?.listingPolicies?.fulfillmentPolicyId).trim()
    : "";
  const verificationOk = verifiedPolicyId === policyTarget.fulfillmentPolicyId;

  return jsonResp({
    ok: verificationOk,
    dry_run: false,
    updated: true,
    ...baseResult,
    verified_fulfillment_policy_id: verifiedPolicyId || null,
    verification_ok: verificationOk,
    verify_upstream_status: verifyRes.status,
  }, verificationOk ? 200 : 502);
}

async function persistHeadlessEbayWithdrawResult(product: any, sku: string, reason = "operator_test_cleanup"): Promise<any> {
  const now = new Date().toISOString();
  const update = {
    ebay_sku: sku,
    ebay_item_id: null,
    ebay_offer_id: null,
    ebay_status: "WITHDRAWN",
    ebay_last_synced_price: null,
    ebay_last_synced_at: now,
    ebay_mapping_status: null,
    ebay_mapping_error: reason,
    ebay_inventory_group_key: null,
    ebay_listing_mode: null,
    ebay_variation_axis: null,
    ebay_variation_value: null,
    ebay_variation_image_url: null,
  };

  let query = supabase.from("products").update(update);
  if (product?.id) query = query.eq("id", product.id);
  else query = query.eq("sku", sku);
  const { error } = await query;
  if (error) throw new Error(`product ebay mapping reset failed: ${error.message || String(error)}`);
  return update;
}

async function persistHeadlessEbayGroupWithdrawResult(inventoryGroupKey: string, reason = "operator_test_cleanup"): Promise<any> {
  const now = new Date().toISOString();
  const update = {
    ebay_item_id: null,
    ebay_offer_id: null,
    ebay_status: "WITHDRAWN",
    ebay_last_synced_price: null,
    ebay_last_synced_at: now,
    ebay_mapping_status: null,
    ebay_mapping_error: reason,
    ebay_inventory_group_key: null,
    ebay_listing_mode: null,
    ebay_variation_axis: null,
    ebay_variation_value: null,
    ebay_variation_image_url: null,
  };
  const { error } = await supabase
    .from("products")
    .update(update)
    .eq("ebay_inventory_group_key", inventoryGroupKey);
  if (error) throw new Error(`product ebay group mapping reset failed: ${error.message || String(error)}`);
  return update;
}

async function markEbayPlatformListingsWithdrawn(productIds: string[], reason = "operator_test_cleanup"): Promise<any> {
  const ids = Array.from(new Set((productIds || []).map((id) => String(id || "").trim()).filter(Boolean)));
  if (!ids.length) return { skipped: true, reason: "no_product_ids" };
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("platform_listings")
    .update({
      listing_status: "not_listed",
      mapping_status: "unmatched",
      error_msg: reason,
      error_code: null,
      last_sync_at: now,
      deleted_at: now,
      updated_at: now,
    })
    .eq("platform", "ebay")
    .in("master_product_id", ids)
    .is("deleted_at", null)
    .select("id,master_product_id,platform_item_id");
  if (error) return { ok: false, error: error.message };
  return { ok: true, rows: data || [] };
}

async function handleWithdrawInventoryItemGroup(body: any, product: any, sku: string, inventoryGroupKey: string, marketplaceId: string, resetLocal: boolean, dryRun: boolean): Promise<Response> {
  const productIds = Array.isArray(body?.product_ids)
    ? body.product_ids.map((id: unknown) => String(id || "").trim()).filter(Boolean)
    : [String(product?.id || "").trim()].filter(Boolean);

  if (dryRun) {
    return jsonResp({
      ok: true,
      dry_run: true,
      product_id: product.id || null,
      product_ids: productIds,
      sku,
      marketplace_id: marketplaceId,
      inventory_group_key: inventoryGroupKey,
      reset_local: resetLocal,
      command: "/sell/inventory/v1/offer/withdraw_by_inventory_item_group",
      can_withdraw: true,
    });
  }

  const confirmed = body?.confirm === EBAY_HEADLESS_WITHDRAW_CONFIRM_PHRASE || body?.confirm_withdraw === true;
  if (!confirmed) {
    return jsonResp({
      ok: false,
      error: "confirm_required",
      message: `Set dry_run=false and confirm="${EBAY_HEADLESS_WITHDRAW_CONFIRM_PHRASE}" to withdraw.`,
      product_id: product.id || null,
      product_ids: productIds,
      sku,
      marketplace_id: marketplaceId,
      inventory_group_key: inventoryGroupKey,
    }, 400);
  }

  // Official local doc: C:\dev\api-refs\marketplaces\ebay\sell\inventory.yaml
  // POST /sell/inventory/v1/offer/withdraw_by_inventory_item_group ends a multiple-variation listing.
  const withdrawRes = await ebayFetch(
    "/sell/inventory/v1/offer/withdraw_by_inventory_item_group",
    {
      method: "POST",
      body: JSON.stringify({
        inventoryItemGroupKey: inventoryGroupKey,
        marketplaceId,
      }),
    }
  );
  if (withdrawRes.status !== 200 && withdrawRes.status !== 204) {
    const passthroughStatus = (withdrawRes.status === 401 || withdrawRes.status === 403 || withdrawRes.status === 429)
      ? withdrawRes.status : 502;
    return jsonResp({
      ok: false,
      error: "upstream_group_withdraw_failed",
      upstream_status: withdrawRes.status,
      upstream: formatEbayErrorBody(withdrawRes.body),
      product_id: product.id || null,
      product_ids: productIds,
      sku,
      marketplace_id: marketplaceId,
      inventory_group_key: inventoryGroupKey,
    }, passthroughStatus);
  }

  const persisted = resetLocal
    ? await persistHeadlessEbayGroupWithdrawResult(inventoryGroupKey, "operator_listing_cleanup")
    : null;
  const platform_listing_reset = resetLocal
    ? await markEbayPlatformListingsWithdrawn(productIds, "operator_listing_cleanup")
    : null;

  return jsonResp({
    ok: true,
    dry_run: false,
    product_id: product.id || null,
    product_ids: productIds,
    sku,
    marketplace_id: marketplaceId,
    inventory_group_key: inventoryGroupKey,
    withdrawn: true,
    persisted,
    platform_listing_reset,
    raw: withdrawRes.body || null,
  });
}

async function handleWithdrawProduct(body: any): Promise<Response> {
  const dryRun = body?.dry_run !== false && body?.dryRun !== false;
  const resetLocal = body?.reset_local !== false && body?.resetLocal !== false;
  const marketplaceId = s(body?.marketplaceId || body?.marketplace_id || "EBAY_US", "EBAY_US").trim() || "EBAY_US";
  const { product, sku } = await loadHeadlessEbayMappedProduct(body || {});
  const preferredOfferId = s(body?.offerId || body?.offer_id || product.ebay_offer_id).trim();
  const inventoryGroupKey = s(body?.inventoryGroupKey || body?.inventory_group_key || product.ebay_inventory_group_key).trim();
  if (inventoryGroupKey) {
    return await handleWithdrawInventoryItemGroup(body, product, sku, inventoryGroupKey, marketplaceId, resetLocal, dryRun);
  }

  const offersRes = await ebayFetch(
    `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`
  );
  if (offersRes.status !== 200 && offersRes.status !== 404) {
    const passthroughStatus = (offersRes.status === 401 || offersRes.status === 403 || offersRes.status === 429)
      ? offersRes.status : 502;
    return jsonResp({
      ok: false,
      error: "upstream_offer_lookup_failed",
      upstream_status: offersRes.status,
      upstream: formatEbayErrorBody(offersRes.body),
    }, passthroughStatus);
  }

  const offers = offersRes.status === 200 ? (offersRes.body?.offers || []) : [];
  const targetOffer = pickPublishedSingleOffer(offers, preferredOfferId);
  const publishedOfferIds = offers
    .filter((offer: any) => String(offer?.status || "").toUpperCase() === "PUBLISHED")
    .map((offer: any) => String(offer?.offerId || ""))
    .filter(Boolean);

  if (dryRun) {
    return jsonResp({
      ok: true,
      dry_run: true,
      product_id: product.id || null,
      sku,
      marketplace_id: marketplaceId,
      target_offer_id: targetOffer?.offerId || null,
      target_listing_id: targetOffer?.listing?.listingId || targetOffer?.listingId || product.ebay_item_id || null,
      published_offer_ids: publishedOfferIds,
      reset_local: resetLocal,
      can_withdraw: !!targetOffer,
    });
  }

  const confirmed = body?.confirm === EBAY_HEADLESS_WITHDRAW_CONFIRM_PHRASE || body?.confirm_withdraw === true;
  if (!confirmed) {
    return jsonResp({
      ok: false,
      error: "confirm_required",
      message: `Set dry_run=false and confirm="${EBAY_HEADLESS_WITHDRAW_CONFIRM_PHRASE}" to withdraw.`,
      product_id: product.id || null,
      sku,
      marketplace_id: marketplaceId,
    }, 400);
  }

  if (!targetOffer) {
    if (!resetLocal) {
      return jsonResp({
        ok: false,
        error: publishedOfferIds.length > 1 ? "ambiguous_published_offers" : "published_offer_not_found",
        product_id: product.id || null,
        sku,
        marketplace_id: marketplaceId,
        published_offer_ids: publishedOfferIds,
      }, 409);
    }
    const persisted = await persistHeadlessEbayWithdrawResult(product, sku, "no_published_offer_found_local_reset");
    const productIds = Array.isArray(body?.product_ids)
      ? body.product_ids.map((id: unknown) => String(id || "").trim()).filter(Boolean)
      : [String(product?.id || "").trim()].filter(Boolean);
    const platform_listing_reset = await markEbayPlatformListingsWithdrawn(productIds, "no_published_offer_found_local_reset");
    return jsonResp({
      ok: true,
      dry_run: false,
      product_id: product.id || null,
      sku,
      marketplace_id: marketplaceId,
      remote_withdraw_skipped: true,
      reason: "no_published_offer_found",
      persisted,
      platform_listing_reset,
    });
  }

  const offerId = String(targetOffer.offerId);
  // Official local doc: C:\dev\api-refs\marketplaces\ebay\sell\inventory.yaml
  // POST /sell/inventory/v1/offer/{offerId}/withdraw ends a single-variation listing.
  const withdrawRes = await ebayFetch(
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`,
    { method: "POST" }
  );
  if (withdrawRes.status !== 200) {
    const passthroughStatus = (withdrawRes.status === 401 || withdrawRes.status === 403 || withdrawRes.status === 429)
      ? withdrawRes.status : 502;
    return jsonResp({
      ok: false,
      error: "upstream_withdraw_failed",
      upstream_status: withdrawRes.status,
      upstream: formatEbayErrorBody(withdrawRes.body),
      product_id: product.id || null,
      sku,
      ebay_offer_id: offerId,
    }, passthroughStatus);
  }

  const persisted = resetLocal
    ? await persistHeadlessEbayWithdrawResult(product, sku, "operator_test_cleanup")
    : null;
  const productIds = Array.isArray(body?.product_ids)
    ? body.product_ids.map((id: unknown) => String(id || "").trim()).filter(Boolean)
    : [String(product?.id || "").trim()].filter(Boolean);
  const platform_listing_reset = resetLocal
    ? await markEbayPlatformListingsWithdrawn(productIds, "operator_listing_cleanup")
    : null;

  return jsonResp({
    ok: true,
    dry_run: false,
    product_id: product.id || null,
    sku,
    marketplace_id: marketplaceId,
    ebay_offer_id: offerId,
    ebay_item_id: targetOffer?.listing?.listingId || targetOffer?.listingId || product.ebay_item_id || null,
    withdrawn: true,
    persisted,
    platform_listing_reset,
    raw: withdrawRes.body || null,
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

async function requireBridgeTokenOrAuthenticatedUser(req: Request): Promise<Response | null> {
  const expected = (Deno as any)["env"]["get"]("PLATFORM_BRIDGE_INTERNAL_TOKEN") || "";
  const actual = req.headers.get("x-platform-bridge-token") || "";
  if (expected && actual === expected) return null;
  const authResult = await requireAuthenticatedUser(req);
  return authResult.response || null;
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

  try {
    if (action === "register-product" && req.method === "POST") {
      // Headless publish path: Supabase gateway still verifies the public anon JWT,
      // then this route requires the server-only bridge token instead of a browser session.
      const internal = requireInternalBridge(req);
      if (internal) return internal;
      const body = await req.json().catch(() => ({}));
      return await handleRegisterProduct(body);
    }

    if (action === "withdraw-product" && req.method === "POST") {
      // Cleanup path for repeatable test listings. Browser calls require a real
      // signed-in user plus the explicit withdraw confirmation phrase.
      const denied = await requireBridgeTokenOrAuthenticatedUser(req);
      if (denied) return denied;
      const body = await req.json().catch(() => ({}));
      return await handleWithdrawProduct(body);
    }

    if (action === "ensure-fulfillment-policy" && req.method === "POST") {
      // Server-only repair path for an existing live offer. The eBay updateOffer
      // call revises the active listing, so browser-originated calls are blocked.
      const internal = requireInternalBridge(req);
      if (internal) return internal;
      const body = await req.json().catch(() => ({}));
      return await handleEnsureFulfillmentPolicy(body);
    }

    const authResult = await requireAuthenticatedUser(req);
    if (authResult.response) return authResult.response;

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

    if (action === "update-price" && req.method === "POST") {
      // Price-only revision of one published fixed-price offer (Phase 2 live sync).
      // No internal bridge token required; requireAuthenticatedUser above is the auth boundary.
      const body = await req.json();
      return await handleUpdatePrice(body);
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
