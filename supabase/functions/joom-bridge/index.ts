// Joom Bridge — v12
// Changes from v11:
//   - Add /lookup-sku GET: resolve Joom productId/variantId/currency for a given merchant SKU
//   - /update-price: preserve variant's existing currency (was hardcoded to USD)
// v11:
//   - Fix: safeSku fallback no longer appends "-DEFAULT" for single-variant DEFAULT products
//   - Add /update-price handler
//   - Fix: include product SKU and categoryId in /products/create payload

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { AUTH_CORS, requireAuthenticatedUser } from "../_shared/auth.ts";

const JOOM_V2 = "https://api-merchant.joom.com/api/v2";
const JOOM_V3 = "https://api-merchant.joom.com/api/v3";

const EXCHANGE_RATE = 1380;
const SALES_FEE = 0.15;
const JOOM_DELETE_CONFIRM_PHRASE = "DELETE_JOOM_PRODUCT";

// Fallback hardcoded categories (used if Joom /categories API fails)
const FALLBACK_CATEGORIES: Record<string, string> = {
  fan_attributes:  "1473502946609422303-30-2-118-7804325",
  music_albums_cd: "1736947929385297579-20-2-9814-1701080485",
  music_albums:    "1567805338802406105-13-2-26202-1432821636",
  trading_cards:   "1733236484920831097-154-2-11859-956666916",
  memorabilia:     "1733235756332554566-61-2-11859-1440023039",
};

const CATEGORY_LABELS: Record<string, string> = {
  fan_attributes:  "응원봉 / Fan Attributes",
  music_albums_cd: "K-pop CD 앨범 (Record CD)",
  music_albums:    "음악 앨범 (Music Albums)",
  trading_cards:   "포토카드 / Trading Cards",
  memorabilia:     "기념품 / Memorabilia",
};

const CORS: Record<string, string> = {
  ...AUTH_CORS,
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info, x-platform-bridge-token",
  "Access-Control-Max-Age": "3600",
};

// @ts-ignore
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

async function getValidAccessToken(): Promise<string> {
  const { data, error } = await supabase
    .from("joom_tokens")
    .select("access_token, refresh_token, expiry_time, client_id, client_secret")
    .eq("id", 1)
    .single();
  if (error || !data) throw new Error("joom_tokens 조회 실패: " + (error?.message || "no row"));
  const now = Math.floor(Date.now() / 1000);
  if (data.expiry_time && now < data.expiry_time - 60) return data.access_token;
  const r = await fetch(`${JOOM_V2}/oauth/refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: data.client_id, client_secret: data.client_secret,
      grant_type: "refresh_token", refresh_token: data.refresh_token,
    }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error("Joom refresh 실패: " + JSON.stringify(j));
  const nd = j.data;
  const newExpiry = nd.expiry_time || (now + (nd.expires_in || 0));
  await supabase.from("joom_tokens").update({
    access_token: nd.access_token, refresh_token: nd.refresh_token,
    expiry_time: newExpiry, updated_at: new Date().toISOString(),
  }).eq("id", 1);
  return nd.access_token;
}

async function joomFetch(path: string, init: RequestInit = {}): Promise<any> {
  const token = await getValidAccessToken();
  const url = path.startsWith("http") ? path : `${JOOM_V3}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), "Authorization": `Bearer ${token}` },
  });
  let body: any;
  try { body = await r.json(); } catch { body = { code: -1, message: "비-JSON 응답" }; }
  if (body.code !== 0) throw new Error(`Joom error code=${body.code} msg=${body.message} (HTTP ${r.status})`);
  return body.data;
}

async function markJoomListingRemoved(body: any, productId: string, raw: any) {
  if (body.reset_local === false || body.resetLocal === false) return null;
  const productIds = Array.isArray(body.product_ids)
    ? body.product_ids.map((id: unknown) => String(id || "").trim()).filter(Boolean)
    : [String(body.product_id || body.productId || "").trim()].filter(Boolean);
  if (!productIds.length) return { skipped: true, reason: "no_product_ids" };
  const now = new Date().toISOString();
  const { data: listingRows, error: listingErr } = await supabase
    .from("platform_listings")
    .update({
      listing_status: "not_listed",
      mapping_status: "unmatched",
      error_msg: "operator_listing_cleanup",
      error_code: null,
      last_sync_at: now,
      deleted_at: now,
      updated_at: now,
    })
    .eq("platform", "joom")
    .in("master_product_id", productIds)
    .is("deleted_at", null)
    .select("id,master_product_id,platform_item_id");
  const { data: productRows, error: productErr } = await supabase
    .from("products")
    .update({
      joom_product_id: null,
      joom_variant_id: null,
      joom_status: "archived",
      joom_mapping_status: null,
      joom_mapping_error: "operator_listing_cleanup",
      joom_last_synced_at: now,
    })
    .in("id", productIds)
    .select("id,sku");
  return {
    ok: !listingErr && !productErr,
    productId,
    product_ids: productIds,
    platform_listings: listingErr ? { ok: false, error: listingErr.message } : { ok: true, rows: listingRows || [] },
    products: productErr ? { ok: false, error: productErr.message } : { ok: true, rows: productRows || [] },
    raw,
  };
}

// ---------------------------------------------------------------------------
// Category management (dynamic fetch + fallback)
// ---------------------------------------------------------------------------

let _cachedCategories: Array<{ key: string; id: string; label: string }> | null = null;

async function getCategories(): Promise<Array<{ key: string; id: string; label: string }>> {
  if (_cachedCategories) return _cachedCategories;
  try {
    const data = await joomFetch("/productCategories");
    const cats = Array.isArray(data) ? data : (data?.categories || data?.productCategories || data?.items || []);
    if (cats.length > 0) {
      _cachedCategories = cats.map((c: any) => ({
        key: String(c.id || c.categoryId || c.key),
        id: String(c.id || c.categoryId || c.key),
        label: c.name || c.categoryName || c.title || c.label || String(c.id || c.categoryId),
      }));
      return _cachedCategories!;
    }
  } catch (e) {
    console.warn("[joom-bridge] Joom /productCategories failed, using fallback:", e);
  }
  // Fallback to hardcoded
  _cachedCategories = Object.entries(FALLBACK_CATEGORIES).map(([key, id]) => ({
    key, id, label: CATEGORY_LABELS[key] || key,
  }));
  return _cachedCategories!;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function calcListingUSD(costKrw: number): number {
  return Math.round((costKrw / EXCHANGE_RATE / (1 - SALES_FEE)) * 100) / 100;
}

function gramsToKg(grams: number): number {
  const g = parseFloat(String(grams)) || 0;
  return Math.round((g / 1000) * 1000) / 1000;
}

function safeSku(base: string, suffix: string): string {
  const s = (suffix || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "_").trim();
  return s ? `${base}-${s}` : base;
}

function stripKorean(s: string): string {
  return (s || "").replace(/[ㄱ-ㅎㅏ-ㅣ가-힣ᄀ-ᇿ]/g, "").replace(/\(\s*\)/g, "").replace(/\s+/g, " ").trim();
}

function joomPlainText(value: string): string {
  return stripKorean(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function hasLifecyclePrefix(value: string): boolean {
  return /^\s*\[(?:PRE\s*[- ]?\s*ORDER|READY\s*[- ]?\s*STOCK|ON\s*HAND|FAST\s*DELIVERY)\]/i.test(value || "");
}

function titleWithPrefix(prefix: string, title: string): string {
  const clean = (title || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const p = (prefix || "").replace(/\s+/g, " ").trim();
  if (!p || clean.toLowerCase().startsWith(p.toLowerCase()) || hasLifecyclePrefix(clean)) return clean;
  return `${p} ${clean}`.replace(/\s+/g, " ").trim();
}

function joomTitleCase(value: string): string {
  return String(value || "").replace(/\S+/g, (word) =>
    word.replace(/[A-Za-z][A-Za-z'’]*/g, (part) =>
      part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    )
  ).replace(/\s+/g, " ").trim();
}

function buildTitle(opts: { namePrefix: string; artist?: string; album?: string; fallbackName?: string }): string {
  const prefix = (opts.namePrefix || "").trim();
  const fallback = joomPlainText(opts.fallbackName || "");
  if (fallback) return joomTitleCase(titleWithPrefix(prefix, fallback)).slice(0, 200);
  const artist = joomPlainText(opts.artist || "");
  const album = joomPlainText(opts.album || "");
  if (artist && album) return joomTitleCase(titleWithPrefix(prefix, `${artist} - ${album}`)).slice(0, 200);
  return joomTitleCase(titleWithPrefix(prefix, "K-POP Album")).slice(0, 200);
}

function buildDescription(opts: { artist?: string; album?: string; contents?: string; fallbackName?: string }): string {
  const productTitle = buildTitle({ namePrefix: "", artist: opts.artist, album: opts.album, fallbackName: opts.fallbackName }) || "K-POP Album";
  const defaultContents = `- PACKAGE\n- CD\n- PHOTOCARD\n- POSTER (varies by version)`;
  const contents = joomPlainText(opts.contents || "") || defaultContents;
  return [
    productTitle, "",
    "100% Official & Authentic K-POP Album",
    "- Brand new, sealed, and sourced directly from the official distributor", "",
    "Chart Certified",
    "- This album counts toward Hanteo and Circle (Gaon) charts",
    "- Your purchase directly supports the artist's chart performance", "",
    "Fast & Secure Shipping",
    "- Ships from Korea with tracking",
    "- Safely packed with bubble wrap and a sturdy box",
    "- Items labeled [READY STOCK], [ON HAND], or [FAST DELIVERY] are dispatched within 1 business day", "",
    "Contents", "",
    contents, "",
    "Important Notice",
    "- The outer box is for protection and may have minor dents, scratches, or creases.",
    "- The outer vinyl wrap may have slight tears or marks due to shipping.",
    "- These are not considered defects and are not grounds for return or refund.",
    "- Please purchase only if you agree to the above conditions.",
    "",
    "Cash on Delivery (COD) Policy",
    "- COD availability depends on Joom buyer eligibility and destination rules.",
    "- If COD is unavailable, please use prepaid payment methods.",
  ].join("\n");
}

function joomProductListingStatus(product: any): string {
  const state = String(product?.state || "").toLowerCase();
  if (state === "archived") return "not_listed";
  if (state === "rejected" || state === "banned") return "rejected";
  if (state === "disabledbyjoom" || state === "disabledbymerchant") return "paused";
  if (state === "pending" || state === "locked") return "pending";
  if (product?.hasActiveVersion === false) return "pending";
  if (state === "active" || state === "warning" || product?.hasActiveVersion === true) return "listed";
  return product?.id ? "pending" : "not_listed";
}

function imageBundleSummary(bundle: any): any {
  if (!bundle) return null;
  const processed = Array.isArray(bundle.processed) ? bundle.processed : [];
  return {
    imageState: bundle.imageState || null,
    origUrl: bundle.origUrl || null,
    processed: processed.slice(0, 5).map((img: any) => ({
      url: img?.url || null,
      width: img?.width ?? null,
      height: img?.height ?? null,
      isSquare: !!img?.width && img.width === img.height,
    })),
  };
}

function isJoomLookupMiss(e: any): boolean {
  const detail = String(e?.message || e || "");
  const lower = detail.toLowerCase();
  return lower.includes("not found")
    || lower.includes("not_found")
    || lower.includes("code=404")
    || lower.includes("code=100");
}

async function lookupJoomProductBySku(sku: string): Promise<any | null> {
  const productSku = String(sku || "").trim();
  if (!productSku) return null;
  try {
    const product = await joomFetch(`/products?sku=${encodeURIComponent(productSku)}`);
    return product?.id ? product : null;
  } catch (e) {
    if (isJoomLookupMiss(e)) return null;
    throw e;
  }
}

async function createOrUpdateJoomProduct(payload: any): Promise<{ data: any; operation: "create" | "update"; existingProductId?: string | null }> {
  const productSku = String(payload?.sku || "").trim();
  const existing = await lookupJoomProductBySku(productSku);
  if (existing?.id && String(existing.state || "").toLowerCase() !== "archived") {
    const { sku: _sku, ...updatePayload } = payload;
    const data = await joomFetch(`/products/update?sku=${encodeURIComponent(productSku)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updatePayload),
    });
    return { data, operation: "update", existingProductId: existing.id || null };
  }
  const data = await joomFetch("/products/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { data, operation: "create", existingProductId: existing?.id || null };
}

// ---------------------------------------------------------------------------
// Cloudinary upload helper (for split image tiles)
// ---------------------------------------------------------------------------

async function sha1Hex(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  // @ts-ignore
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function uploadTileToCloudinary(imageData: Uint8Array): Promise<string | null> {
  // @ts-ignore
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME") || "";
  // @ts-ignore
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY") || "";
  // @ts-ignore
  const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET") || "";
  if (!cloudName || !apiKey || !apiSecret) return null;

  const folder = "joom-tiles";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const publicId = `${folder}/${uniqueId}`;
  const paramsToSign = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = await sha1Hex(paramsToSign);

  const formData = new FormData();
  formData.append("file", new Blob([imageData], { type: "image/jpeg" }), "tile.jpg");
  formData.append("api_key", apiKey);
  formData.append("timestamp", timestamp);
  formData.append("signature", signature);
  formData.append("public_id", publicId);
  formData.append("folder", folder);

  try {
    const r = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: "POST",
      body: formData,
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.secure_url as string) || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Detail image square processing.
// Every detail/extra image sent to Joom is converted into square image URLs.
// Very tall images are split into square tiles so important content is not lost.
// Prefer Cloudinary fetch transformations so we do not download/decode the full
// remote image. Fall back to Supabase Storage-hosted tiles when direct fetch
// transforms are unavailable.
// ---------------------------------------------------------------------------

type ImageDimensions = { width: number; height: number };
const JOOM_MAX_EXTRA_IMAGES = 20;
const JOOM_EXTRA_IMAGE_TILE_SIZE = 1500;
const JOOM_BLANK_IMAGE_SAMPLE_STEPS = 96;
const JOOM_BLANK_IMAGE_MIN_CONTENT_RATIO = 0.004;

function imageUrlKey(value: unknown): string {
  return String(value || "").trim();
}

function uniqueExtraImageUrls(scrapedAssets: any): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const mainKey = imageUrlKey(scrapedAssets?.mainImage);
  if (mainKey) seen.add(mainKey);

  const candidates = [
    ...(Array.isArray(scrapedAssets?.detailImages) ? scrapedAssets.detailImages : []),
    ...(Array.isArray(scrapedAssets?.extraImages) ? scrapedAssets.extraImages : []),
  ];
  for (const value of candidates) {
    const key = imageUrlKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= JOOM_MAX_EXTRA_IMAGES) break;
  }
  return out;
}

function parseJpegSize(bytes: Uint8Array): ImageDimensions | null {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xFF) { i++; continue; }
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) + bytes[i + 3];
    if (len < 2) return null;
    if (marker >= 0xC0 && marker <= 0xC3) {
      return { height: (bytes[i + 5] << 8) + bytes[i + 6], width: (bytes[i + 7] << 8) + bytes[i + 8] };
    }
    i += 2 + len;
  }
  return null;
}

function parsePngSize(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4E || bytes[3] !== 0x47) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function readImageDimensions(imageUrl: string): Promise<ImageDimensions | null> {
  const resp = await fetch(imageUrl, {
    headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.staronemall.com/", "Range": "bytes=0-65535" },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok && resp.status !== 206) return null;
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return parsePngSize(bytes) || parseJpegSize(bytes);
}

async function buildCloudinaryFetchTiles(imageUrl: string, img: ImageDimensions): Promise<string[]> {
  // @ts-ignore
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME") || "";
  if (!cloudName) return [];
  const targetSize = JOOM_EXTRA_IMAGE_TILE_SIZE;
  const encodedUrl = encodeURIComponent(imageUrl);
  if (img.height > img.width * 1.5) {
    const tileSize = img.width;
    const numTiles = Math.min(Math.ceil(img.height / tileSize), 9);
    return Array.from({ length: numTiles }, (_, i) => {
      const y = i * tileSize;
      const h = Math.min(tileSize, img.height - y);
      return `https://res.cloudinary.com/${cloudName}/image/fetch/c_crop,w_${img.width},h_${h},x_0,y_${y}/c_pad,b_white,w_${targetSize},h_${targetSize}/f_jpg,q_90/${encodedUrl}`;
    });
  }
  if (img.width > img.height * 1.5) {
    const tileSize = img.height;
    const numTiles = Math.min(Math.ceil(img.width / tileSize), 9);
    return Array.from({ length: numTiles }, (_, i) => {
      const x = i * tileSize;
      const w = Math.min(tileSize, img.width - x);
      return `https://res.cloudinary.com/${cloudName}/image/fetch/c_crop,w_${w},h_${img.height},x_${x},y_0/c_pad,b_white,w_${targetSize},h_${targetSize}/f_jpg,q_90/${encodedUrl}`;
    });
  }

  return [`https://res.cloudinary.com/${cloudName}/image/fetch/c_pad,b_white,w_${targetSize},h_${targetSize}/f_jpg,q_90/${encodedUrl}`];
}

async function buildCloudinaryUnknownSquare(imageUrl: string): Promise<string[]> {
  // @ts-ignore
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME") || "";
  if (!cloudName) return [];
  return [`https://res.cloudinary.com/${cloudName}/image/fetch/c_pad,b_white,w_1500,h_1500,f_jpg,q_90/${encodeURIComponent(imageUrl)}`];
}

function isLikelyBlankImage(img: any): boolean {
  const width = Number(img?.width || 0);
  const height = Number(img?.height || 0);
  const bitmap = img?.bitmap;
  if (!width || !height || !bitmap) return false;

  const cols = Math.min(JOOM_BLANK_IMAGE_SAMPLE_STEPS, width);
  const rows = Math.min(JOOM_BLANK_IMAGE_SAMPLE_STEPS, height);
  let total = 0;
  let informative = 0;
  let strongContent = 0;

  for (let row = 0; row < rows; row += 1) {
    const y = Math.min(height - 1, Math.floor((row + 0.5) * height / rows));
    for (let col = 0; col < cols; col += 1) {
      const x = Math.min(width - 1, Math.floor((col + 0.5) * width / cols));
      const idx = (y * width + x) * 4;
      const r = bitmap[idx] ?? 255;
      const g = bitmap[idx + 1] ?? 255;
      const b = bitmap[idx + 2] ?? 255;
      const a = bitmap[idx + 3] ?? 255;
      if (a < 16) continue;
      total += 1;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const nearWhite = r >= 245 && g >= 245 && b >= 245;
      const lowContrastWhite = r >= 238 && g >= 238 && b >= 238 && (max - min) <= 10;
      if (!nearWhite && !lowContrastWhite) informative += 1;
      if (r < 230 || g < 230 || b < 230 || (max - min) > 24) strongContent += 1;
    }
  }

  if (!total) return true;
  const informativeRatio = informative / total;
  const strongRatio = strongContent / total;
  return informativeRatio < JOOM_BLANK_IMAGE_MIN_CONTENT_RATIO && strongRatio < 0.002;
}

async function cloudinaryTileHasContent(tileUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(tileUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.staronemall.com/" },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`tile fetch failed: HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    // @ts-ignore
    const { Image } = await import("https://deno.land/x/imagescript@1.3.0/mod.ts");
    const img = await Image.decode(bytes);
    return !isLikelyBlankImage(img);
  } catch (e) {
    console.warn("[joom-bridge] blank-tile inspection failed; keeping tile:", tileUrl, e);
    return true;
  }
}

async function filterLikelyBlankCloudinaryTiles(tileUrls: string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const tileUrl of tileUrls) {
    if (await cloudinaryTileHasContent(tileUrl)) {
      kept.push(tileUrl);
    } else {
      console.warn("[joom-bridge] skipped mostly blank Joom detail tile:", tileUrl);
    }
  }
  return kept;
}

async function uploadTileToProductStorage(imageData: Uint8Array, sourceUrl: string, index: number): Promise<string | null> {
  const path = `joom-tiles/${Date.now()}-${index}.jpg`;
  const { error } = await supabase.storage
    .from("product-images")
    .upload(path, new Blob([imageData], { type: "image/jpeg" }), { contentType: "image/jpeg", upsert: true });
  if (error) {
    console.warn("[joom-bridge] product-images tile upload failed", sourceUrl, error.message);
    return null;
  }
  const { data } = supabase.storage.from("product-images").getPublicUrl(path);
  return data?.publicUrl || null;
}

function decodeBase64Image(value: string): Uint8Array {
  const clean = String(value || "").replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
  if (!clean) throw new Error("empty base64 image");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function processDetailImage(imageUrl: string): Promise<string[]> {
  try {
    let skippedBlankTile = false;
    let dims: ImageDimensions | null = null;
    try {
      dims = await readImageDimensions(imageUrl);
    } catch (dimensionError) {
      console.warn("[joom-bridge] readImageDimensions failed, trying Cloudinary unknown-square fallback:", imageUrl, dimensionError);
    }
    if (dims) {
      const cloudinaryTiles = await buildCloudinaryFetchTiles(imageUrl, dims);
      if (cloudinaryTiles.length) {
        const filteredTiles = await filterLikelyBlankCloudinaryTiles(cloudinaryTiles);
        if (filteredTiles.length) return filteredTiles;
        console.warn("[joom-bridge] all Cloudinary tiles were mostly blank; skipping source image:", imageUrl);
        return [];
      }
    } else {
      const cloudinarySquare = await buildCloudinaryUnknownSquare(imageUrl);
      if (cloudinarySquare.length) {
        const filteredTiles = await filterLikelyBlankCloudinaryTiles(cloudinarySquare);
        if (filteredTiles.length) return filteredTiles;
        console.warn("[joom-bridge] Cloudinary unknown-square tile was mostly blank; skipping source image:", imageUrl);
        return [];
      }
    }

    const resp = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.staronemall.com/" },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`image fetch failed: HTTP ${resp.status}`);
    const buf = new Uint8Array(await resp.arrayBuffer());

    // @ts-ignore
    const { Image } = await import("https://deno.land/x/imagescript@1.3.0/mod.ts");
    const img = await Image.decode(buf);
    const tiles: string[] = [];

    if (img.height > img.width * 1.5) {
      const tileSize = img.width;
      const numTiles = Math.min(Math.ceil(img.height / tileSize), 9);
      for (let i = 0; i < numTiles; i++) {
        const y = i * tileSize;
        const h = Math.min(tileSize, img.height - y);
        const tile = img.clone();
        tile.crop(0, y, img.width, h);

        let square;
        if (h < tileSize) {
          square = new Image(tileSize, tileSize);
          square.fill(0xFFFFFFFF);
          square.composite(tile, 0, 0);
        } else {
          square = tile;
        }

        if (isLikelyBlankImage(square)) {
          skippedBlankTile = true;
          console.warn("[joom-bridge] skipped mostly blank Joom detail tile:", imageUrl, i);
          continue;
        }
        const encoded: Uint8Array = await square.encodeJPEG(90);
        const url = await uploadTileToCloudinary(encoded) || await uploadTileToProductStorage(encoded, imageUrl, i);
        if (url) tiles.push(url);
      }
    } else if (img.width > img.height * 1.5) {
      const tileSize = img.height;
      const numTiles = Math.min(Math.ceil(img.width / tileSize), 9);
      for (let i = 0; i < numTiles; i++) {
        const x = i * tileSize;
        const w = Math.min(tileSize, img.width - x);
        const tile = img.clone();
        tile.crop(x, 0, w, img.height);

        let square;
        if (w < tileSize) {
          square = new Image(tileSize, tileSize);
          square.fill(0xFFFFFFFF);
          square.composite(tile, 0, 0);
        } else {
          square = tile;
        }

        if (isLikelyBlankImage(square)) {
          skippedBlankTile = true;
          console.warn("[joom-bridge] skipped mostly blank Joom detail tile:", imageUrl, i);
          continue;
        }
        const encoded: Uint8Array = await square.encodeJPEG(90);
        const url = await uploadTileToCloudinary(encoded) || await uploadTileToProductStorage(encoded, imageUrl, i);
        if (url) tiles.push(url);
      }
    } else {
      const tileSize = Math.max(img.width, img.height);
      const square = new Image(tileSize, tileSize);
      square.fill(0xFFFFFFFF);
      const x = Math.max(0, Math.floor((tileSize - img.width) / 2));
      const y = Math.max(0, Math.floor((tileSize - img.height) / 2));
      square.composite(img, x, y);
      if (isLikelyBlankImage(square)) {
        skippedBlankTile = true;
        console.warn("[joom-bridge] skipped mostly blank Joom detail tile:", imageUrl, 0);
      } else {
      const encoded: Uint8Array = await square.encodeJPEG(90);
      const url = await uploadTileToCloudinary(encoded) || await uploadTileToProductStorage(encoded, imageUrl, 0);
      if (url) tiles.push(url);
      }
    }

    if (tiles.length > 0) return tiles;
    if (skippedBlankTile) return [];
    throw new Error("square image upload failed");
  } catch (e) {
    console.error("[joom-bridge] processDetailImage failed:", imageUrl, e);
    throw new Error(`Joom detail image square processing failed: ${imageUrl}: ${String((e as any)?.message || e)}`);
  }
}

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

async function buildPayload(opts: any): Promise<any> {
  const { row, scrapedAssets, variantsConfig, categoryId, enabled, namePrefix, artist, album, contents, brand } = opts;
  if (!scrapedAssets?.mainImage) throw new Error("scrapedAssets.mainImage 가 비어있음");
  const brandName = String(brand || "").trim();
  if (!brandName) throw new Error("brand required");

  const productSku = String(row.sku || "").trim();
  if (!productSku) throw new Error("row.sku required");

  const listing = calcListingUSD(row.cost);
  const hasExplicitVariants = Array.isArray(variantsConfig) && variantsConfig.length > 0;
  const configs = hasExplicitVariants ? variantsConfig : [{ name: "DEFAULT", sku: productSku, inventory: 0 }];
  const defaultWeightKg = gramsToKg(row.weight || 0);
  const seenSkus = new Set<string>();

  const variants = configs.map((cfg: any, idx: number) => {
    const vName = (cfg.name || "DEFAULT").trim();
    const vSku = String(cfg.sku || (!hasExplicitVariants && vName.toUpperCase() === "DEFAULT" ? productSku : "")).trim();
    if (!vSku) throw new Error(`variant SKU required: ${vName || idx + 1}`);
    if (hasExplicitVariants && configs.length === 1 && vSku !== productSku) {
      throw new Error("single variant product sku must equal option sku");
    }
    if (seenSkus.has(vSku)) throw new Error(`duplicate variant SKU: ${vSku}`);
    seenSkus.add(vSku);
    // Per-variant weight: use cfg.weight (grams) if provided, else product-level weight
    const vWeightKg = cfg.weight ? gramsToKg(cfg.weight) : defaultWeightKg;

    const v: any = {
      sku: vSku,
      price: String(cfg.price || listing),
      currency: "USD",
      inventory: parseInt(cfg.inventory || 0),
      enabled: cfg.enabled !== undefined ? !!cfg.enabled : !!enabled,
      shippingWeight: vWeightKg,
      shippingPrice: "0.00",
      size: (vName && vName.toUpperCase() !== "DEFAULT") ? vName : "ONE SIZE",
    };
    if (cfg.image) v.mainImage = cfg.image;
    if (scrapedAssets.barcode) v.gtin = String(scrapedAssets.barcode).replace(/\s+/g, "");
    return v;
  });

  const productName = buildTitle({ namePrefix, artist, album, fallbackName: scrapedAssets.name });
  const description = buildDescription({ artist, album, contents, fallbackName: scrapedAssets.name });

  // Process detail images: split tall portraits into square tiles
  const rawExtras = uniqueExtraImageUrls(scrapedAssets);

  const processedExtras: string[] = [];
  for (const url of rawExtras) {
    if (processedExtras.length >= JOOM_MAX_EXTRA_IMAGES) break;
    const tiles = await processDetailImage(url);
    for (const t of tiles) {
      if (processedExtras.length < JOOM_MAX_EXTRA_IMAGES) processedExtras.push(t);
    }
  }

  const payload: any = {
    sku: productSku,
    name: productName,
    mainImage: scrapedAssets.mainImage,
    extraImages: processedExtras,
    description,
    enabled: !!enabled,
    categoryId,
    variants,
  };
  payload.brand = brandName;
  return payload;
}

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
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const action = url.pathname.split("/").filter(Boolean).pop() || "";

  try {
    if (action === "health" && req.method === "GET") {
      try {
        const token = await getValidAccessToken();
        return jsonResp({ ok: true, service: "joom-bridge", version: 13, token_ok: !!token });
      } catch (e: any) {
        return jsonResp({ ok: false, service: "joom-bridge", version: 13, error: "joom_auth_unavailable", message: String(e?.message || e) }, 503);
      }
    }

    if (action === "categories" && req.method === "GET") {
      const cats = await getCategories();
      return jsonResp({ ok: true, categories: cats });
    }

    if ((action === "publish" || action === "dryrun") && req.method === "POST") {
      const denied = await requireBridgeTokenOrAuthenticatedUser(req);
      if (denied) return denied;
      const body = await req.json();
      const row = body.row || {};
      const scraped = body.scrapedAssets || {};
      const variantsConfig: any[] = body.variantsConfig || [];
      const enabled = !!body.enabled;
      const namePrefix = body.namePrefix || "";
      const artist = body.artist || "";
      const album = body.album || "";
      const contents = body.contents || "";
      const brand = body.brand || "";

      // Resolve categoryId: support both legacy key ("music_albums_cd") and direct Joom ID
      const categoryId = String(FALLBACK_CATEGORIES[body.categoryId] || body.categoryId || "").trim();
      if (!String(row.sku || "").trim()) return jsonResp({ ok: false, error: "row.sku required" }, 400);

      if (!row.cost) return jsonResp({ ok: false, error: "row.cost 필요" }, 400);
      if (!scraped.mainImage) return jsonResp({ ok: false, error: "scrapedAssets.mainImage 필요" }, 400);
      if (!categoryId) return jsonResp({ ok: false, error: "categoryId 필요" }, 400);

      const payload = await buildPayload({
        row, scrapedAssets: scraped, variantsConfig, categoryId, enabled,
        namePrefix, artist, album, contents, brand,
      });
      const computed_listing_usd = calcListingUSD(row.cost);

      if (action === "dryrun") {
        return jsonResp({
          ok: true, dry_run: true, payload, computed_listing_usd,
          weight_kg: gramsToKg(row.weight),
          formula: `${row.cost} / ${EXCHANGE_RATE} / (1 - ${SALES_FEE})`,
        });
      }

      const { data, operation, existingProductId } = await createOrUpdateJoomProduct(payload);
      const joomCategoryId = String(data.categoryId || data.category?.id || data.categoryByJoom?.id || "");
      return jsonResp({
        ok: true,
        operation,
        recovered_existing_product_id: existingProductId || null,
        joom_product_id: data.id,
        joom_sku: data.sku,
        state: data.state,
        joom_product_state: data.state || null,
        hasActiveVersion: data.hasActiveVersion ?? null,
        listing_status: joomProductListingStatus(data),
        main_image_state: data.mainImage?.imageState,
        requested_category_id: categoryId,
        joom_category_id: joomCategoryId || null,
        category_assigned: joomCategoryId === categoryId,
        brand_assigned: !!data.brand,
        variants: (data.variants || []).map((v: any) => ({
          sku: v.sku, price: v.price, inventory: v.inventory,
          enabled: v.enabled, size: v.size, shippingWeight: v.shippingWeight,
        })),
        infractions: ((data.review || {}).infractions || []).map((i: any) => ({
          code: i.code, kind: i.kind, note: i.note, description: i.description,
          where: i.where, isPermanent: i.isPermanent, regions: i.regions,
        })),
        computed_listing_usd,
      });
    }

    if (action === "lookup-sku" && req.method === "GET") {
      const denied = await requireBridgeTokenOrAuthenticatedUser(req);
      if (denied) return denied;
      // GET /lookup-sku?sku=ABC&id=... → resolve Joom productId + variantId + currency.
      // Some imported/previously-published rows have products.joom_product_id even when
      // Joom no longer resolves the local master SKU as the parent SKU. In that case,
      // retry by id before declaring the remote product missing.
      const sku = (url.searchParams.get("sku") || "").trim();
      const id = (url.searchParams.get("id") || "").trim();
      if (!sku && !id) return jsonResp({ ok: false, error: "sku or id query param required" }, 400);

      const lookupJoomProductBySkuOrId = async () => {
        let skuError: any = null;
        if (sku) {
          try {
            return await joomFetch(`/products?sku=${encodeURIComponent(sku)}`);
          } catch (e) {
            skuError = e;
            if (!id || !isJoomLookupMiss(e)) throw e;
          }
        }
        if (id) return await joomFetch(`/products?id=${encodeURIComponent(id)}`);
        throw skuError;
      };
      const findLookupVariant = (product: any) => {
        const variants: any[] = Array.isArray(product?.variants) ? product.variants : [];
        if (sku) {
          const exact = variants.find((v: any) => String(v?.sku || "").trim() === sku);
          if (exact) return exact;
        }
        if (id && String(product?.id || "") === id && variants.length === 1) return variants[0];
        return null;
      };

      try {
        const product = await lookupJoomProductBySkuOrId();
        const variants: any[] = Array.isArray(product?.variants) ? product.variants : [];
        const matched = findLookupVariant(product);
        if (!matched) {
          return jsonResp({
            ok: false,
            error: "variant_sku_not_found",
            joom_product_id: product?.id || null,
            lookup_by_id: !!id,
            variant_count: variants.length,
            variant_skus_sample: variants.slice(0, 5).map((v: any) => v?.sku || null),
          }, 404);
        }
        return jsonResp({
          ok: true,
          joom_product_id: String(product?.id || ""),
          joom_variant_id: String(matched.id || ""),
          joom_currency: String(matched.currency || ""),
          joom_price: matched.price != null ? String(matched.price) : null,
          joom_enabled: !!matched.enabled,
          state: product?.state || null,
          joom_product_state: product?.state || null,
          hasActiveVersion: product?.hasActiveVersion ?? null,
          listing_status: joomProductListingStatus(product),
          product_name: product?.name || "",
          image_audit: {
            mainImage: imageBundleSummary(product?.mainImage),
            extraImages: (Array.isArray(product?.extraImages) ? product.extraImages : []).map(imageBundleSummary),
            matchedVariantMainImage: imageBundleSummary(matched?.mainImage),
          },
        });
      } catch (e: any) {
        console.error("[joom-bridge] lookup-sku failed", e);
        const detail = String(e?.message || e || '');
        const miss = isJoomLookupMiss(e);
        return jsonResp({
          ok: false,
          error: miss ? "joom_product_lookup_failed" : "upstream_joom_lookup_failed",
          lookup_error_detail: detail.slice(0, 500),
        }, miss ? 404 : 502);
      }
    }

    if (action === "update-images" && req.method === "POST") {
      const denied = await requireBridgeTokenOrAuthenticatedUser(req);
      if (denied) return denied;
      const body = await req.json();
      const sku = String(body.sku || "").trim();
      if (!sku) return jsonResp({ ok: false, error: "sku required" }, 400);

      const processedExtras: string[] = [];
      const imageDataRows = Array.isArray(body.imageData) ? body.imageData : [];
      for (let i = 0; i < imageDataRows.length; i += 1) {
        if (processedExtras.length >= JOOM_MAX_EXTRA_IMAGES) break;
        const row = imageDataRows[i] || {};
        const bytes = decodeBase64Image(row.base64 || row.data || "");
        const sourceUrl = String(row.sourceUrl || row.url || `inline-${i}`);
        const uploaded = await uploadTileToCloudinary(bytes) || await uploadTileToProductStorage(bytes, sourceUrl, i);
        if (uploaded) processedExtras.push(uploaded);
      }

      const rawExtras = uniqueExtraImageUrls({
        mainImage: body.mainImage || body.mainImageUrl || "",
        detailImages: Array.isArray(body.detailImages) ? body.detailImages : [],
        extraImages: Array.isArray(body.extraImages) ? body.extraImages : [],
      });
      if (!rawExtras.length && !processedExtras.length) return jsonResp({ ok: false, error: "detailImages, extraImages or imageData required" }, 400);

      for (const imageUrl of rawExtras) {
        if (processedExtras.length >= JOOM_MAX_EXTRA_IMAGES) break;
        const tiles = await processDetailImage(imageUrl);
        for (const tileUrl of tiles) {
          if (processedExtras.length < JOOM_MAX_EXTRA_IMAGES) processedExtras.push(tileUrl);
        }
      }
      if (!processedExtras.length) return jsonResp({ ok: false, error: "no processed extraImages" }, 400);

      const data = await joomFetch(`/products/update?sku=${encodeURIComponent(sku)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extraImages: processedExtras }),
      });
      return jsonResp({
        ok: true,
        operation: "update-images",
        joom_product_id: data?.id || null,
        state: data?.state || null,
        hasActiveVersion: data?.hasActiveVersion ?? null,
        requested_extra_images: rawExtras,
        updated_extra_images: processedExtras,
        image_audit: {
          extraImages: (Array.isArray(data?.extraImages) ? data.extraImages : []).map(imageBundleSummary),
        },
      });
    }

    if (action === "update-price" && req.method === "POST") {
      const denied = await requireBridgeTokenOrAuthenticatedUser(req);
      if (denied) return denied;
      const body = await req.json();
      const { productId, sku, price } = body;
      if (!productId || !price || price <= 0) return jsonResp({ ok: false, error: "productId, price 필요" }, 400);

      // Fetch current product to get full variant list
      const isHexId = /^[a-f0-9]{24}$/.test(String(productId));
      const qparam = isHexId ? `id=${encodeURIComponent(productId)}` : `sku=${encodeURIComponent(productId)}`;
      const product = await joomFetch(`/products?${qparam}`);

      const variants: any[] = product.variants || [];
      if (!variants.length) return jsonResp({ ok: false, error: "variant 없음" }, 404);

      const targets = sku ? variants.filter((v: any) => v.sku === sku) : variants;
      if (!targets.length) return jsonResp({ ok: false, error: `sku "${sku}" 없음` }, 404);

      // Preserve variant's existing currency. Joom requires the field on update; overwriting
      // with a hardcoded USD breaks variants in other currencies. Fallback to USD only when
      // the variant has no currency set (defensive — should never happen for published variants).
      const updatedVariants = targets.map((v: any) => ({
        ...v,
        price: String(price),
        currency: v.currency || "USD",
      }));
      const result = await joomFetch("/products/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: product.id || productId, variants: updatedVariants }),
      });
      return jsonResp({ ok: true, updated: updatedVariants.length, state: result?.state });
    }

    if (action === "delete" && req.method === "POST") {
      const denied = await requireBridgeTokenOrAuthenticatedUser(req);
      if (denied) return denied;
      const body = await req.json();
      const dryRun = body?.dry_run !== false && body?.dryRun !== false;
      const productId = body.productId || body.product_id || body.sku;
      if (!productId) return jsonResp({ ok: false, error: "productId 필요" }, 400);
      const isHexId = /^[a-f0-9]{24}$/.test(productId);
      const param = isHexId ? `id=${encodeURIComponent(productId)}` : `sku=${encodeURIComponent(productId)}`;
      if (dryRun) {
        return jsonResp({
          ok: true,
          dry_run: true,
          productId,
          remove_param: param,
          command: "/products/remove",
        });
      }
      const confirmed = body.confirm === JOOM_DELETE_CONFIRM_PHRASE || body.confirm_delete === true;
      if (!confirmed) {
        return jsonResp({
          ok: false,
          error: "confirm_required",
          message: `Set dry_run=false and confirm="${JOOM_DELETE_CONFIRM_PHRASE}" to remove the Joom product.`,
          productId,
        }, 400);
      }
      // Official local doc: C:\dev\api-refs\marketplaces\joom\openapi.yaml
      // POST /products/remove archives/removes the product and all variants.
      const result = await joomFetch(`/products/remove?${param}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const persisted = await markJoomListingRemoved(body, productId, result);
      return jsonResp({ ok: true, dry_run: false, deleted: productId, persisted });
    }

    return jsonResp({ ok: false, error: `unknown action: ${action} (${req.method})` }, 404);
  } catch (e: any) {
    console.error("[joom-bridge] error", e);
    return jsonResp({ ok: false, error: "joom_bridge_failed", message: String(e?.message || e) }, 500);
  }
}

// @ts-ignore
Deno.serve(handleRequest);
