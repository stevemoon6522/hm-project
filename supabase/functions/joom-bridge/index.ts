// Joom Bridge — v12
// Changes from v11:
//   - Add /lookup-sku GET: resolve Joom productId/variantId/currency for a given merchant SKU
//   - /update-price: preserve variant's existing currency (was hardcoded to USD)
// v11:
//   - Fix: safeSku fallback no longer appends "-DEFAULT" for single-variant DEFAULT products
//   - Add /update-price handler
//   - Fix: include product SKU and categoryId in /products/create payload

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { requireAuthenticatedUser } from "../_shared/auth.ts";
import { uploadTileToCloudinary } from "../_shared/cloudinary.ts";

// Read-only routes that genuinely do not need a signed-in user. Everything
// else is treated as a Joom write (publish, price update, delete, etc.) and
// must pass requireAuthenticatedUser before any side effect.
const PUBLIC_JOOM_ACTIONS: ReadonlySet<string> = new Set([
  "health",
  "categories",
  "lookup-sku",
]);

const JOOM_V2 = "https://api-merchant.joom.com/api/v2";
const JOOM_V3 = "https://api-merchant.joom.com/api/v3";

const EXCHANGE_RATE = 1380;
const SALES_FEE = 0.15;

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
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
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

function buildTitle(opts: { namePrefix: string; artist?: string; album?: string; fallbackName?: string }): string {
  const prefix = (opts.namePrefix || "").trim();
  const space = prefix ? prefix + " " : "";
  if (opts.artist && opts.album) return `${space}${opts.artist.trim()} - ${opts.album.trim()}`.slice(0, 200);
  return `${space}${stripKorean(opts.fallbackName || "")}`.slice(0, 200);
}

function buildDescription(opts: { artist?: string; album?: string; contents?: string; fallbackName?: string }): string {
  const headLine = (opts.artist && opts.album)
    ? `🟣 ${opts.artist.trim()} - ${opts.album.trim()}`
    : `🟣 ${stripKorean(opts.fallbackName || "K-POP Album")}`;
  const defaultContents = `- PACKAGE\n- CD\n- PHOTOCARD\n- POSTER (varies by version)`;
  const contents = (opts.contents || "").trim() || defaultContents;
  return [
    headLine, "",
    "💿 100% Official & Authentic K-POP Album",
    "- Brand new, sealed, and sourced directly from the official distributor", "",
    "📊 Chart Certified",
    "- This album counts toward Hanteo and Circle (Gaon) charts",
    "- Your purchase directly supports the artist's chart performance", "",
    "📦 Fast & Secure Shipping",
    "- Ships from Korea with tracking",
    "- Safely packed with bubble wrap and a sturdy box",
    "- Items labeled [READY STOCK], [ON HAND], or [FAST DELIVERY] are dispatched within 1 business day", "",
    "📌 Contents", "",
    contents, "",
    "⚠️ Important Notice",
    "- The outer box is for protection and may have minor dents, scratches, or creases.",
    "- The outer vinyl wrap may have slight tears or marks due to shipping.",
    "- These are not considered defects and are not grounds for return or refund.",
    "- Please purchase only if you agree to the above conditions.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Portrait image splitting
// Tall images (height > width * 1.5) are split into square tiles.
// Requires CLOUDINARY_* env vars to host the split tiles.
// ---------------------------------------------------------------------------

function readImageDimensions(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length >= 24 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xFF) { offset++; continue; }
    const marker = buf[offset + 1];
    offset += 2;
    if (marker === 0xD8 || marker === 0xD9) continue;
    if (offset + 2 > buf.length) return null;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > buf.length) return null;
    const isSof =
      (marker >= 0xC0 && marker <= 0xC3) ||
      (marker >= 0xC5 && marker <= 0xC7) ||
      (marker >= 0xC9 && marker <= 0xCB) ||
      (marker >= 0xCD && marker <= 0xCF);
    if (isSof && length >= 7) {
      return {
        height: view.getUint16(offset + 3),
        width: view.getUint16(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

async function buildCloudinaryFetchTiles(
  imageUrl: string,
  width: number,
  height: number,
  cloudName: string,
): Promise<string[] | null> {
  if (!cloudName || !width || !height || height <= width * 1.5) return null;

  const tileSize = width;
  const numTiles = Math.min(Math.ceil(height / tileSize), 9);
  const encodedSource = encodeURIComponent(imageUrl);
  const tiles: string[] = [];

  for (let i = 0; i < numTiles; i++) {
    const y = i * tileSize;
    const h = Math.min(tileSize, height - y);
    const transform = [
      `c_crop,w_${width},h_${h},x_0,y_${y}`,
      `b_white,c_pad,w_${width},h_${width}`,
      "c_scale,w_1800",
      "f_jpg,q_auto",
    ].join("/");
    tiles.push(`https://res.cloudinary.com/${cloudName}/image/fetch/${transform}/${encodedSource}`);
  }

  try {
    const probe = await fetch(tiles[0], { method: "GET", signal: AbortSignal.timeout(15000) });
    await probe.body?.cancel();
    if (!probe.ok) {
      console.warn("[joom-bridge] cloudinary fetch probe failed:", probe.status);
      return null;
    }
    return tiles;
  } catch (e) {
    console.warn("[joom-bridge] cloudinary fetch probe threw:", e);
    return null;
  }
}

async function uploadTileToProductStorage(imageData: Uint8Array): Promise<string | null> {
  try {
    const path = [
      "joom-tiles",
      new Date().toISOString().slice(0, 10),
      `${crypto.randomUUID()}.jpg`,
    ].join("/");
    const { error } = await supabase.storage
      .from("product-images")
      .upload(path, new Blob([imageData], { type: "image/jpeg" }), {
        cacheControl: "31536000",
        contentType: "image/jpeg",
        upsert: false,
      });
    if (error) {
      console.warn("[joom-bridge] storage tile upload failed:", error.message || error);
      return null;
    }
    const { data } = supabase.storage.from("product-images").getPublicUrl(path);
    return data?.publicUrl || null;
  } catch (e) {
    console.warn("[joom-bridge] storage tile upload threw:", e);
    return null;
  }
}

async function processDetailImage(imageUrl: string): Promise<string[]> {
  // @ts-ignore
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME") || "";

  try {
    const resp = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.staronemall.com/" },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [imageUrl];
    const buf = new Uint8Array(await resp.arrayBuffer());
    const dims = readImageDimensions(buf);
    if (dims && dims.height > dims.width * 1.5) {
      const fetchTiles = await buildCloudinaryFetchTiles(imageUrl, dims.width, dims.height, cloudName);
      if (fetchTiles?.length) return fetchTiles;
    }

    // @ts-ignore
    const { Image } = await import("https://deno.land/x/imagescript@1.3.0/mod.ts");
    const img = await Image.decode(buf);

    // Only split if height > 1.5× width (portrait detail image)
    if (img.height <= img.width * 1.5) return [imageUrl];

    const tileSize = img.width;
    const numTiles = Math.min(Math.ceil(img.height / tileSize), 9); // Joom allows up to 9 extra images
    const tiles: string[] = [];

    for (let i = 0; i < numTiles; i++) {
      const y = i * tileSize;
      const h = Math.min(tileSize, img.height - y);
      const tile = img.clone();
      tile.crop(0, y, img.width, h);

      // Pad shorter last tile to square with white background
      let square;
      if (h < tileSize) {
        square = new Image(tileSize, tileSize);
        square.fill(0xFFFFFFFF);
        square.composite(tile, 0, 0);
      } else {
        square = tile;
      }

      const encoded: Uint8Array = await square.encodeJPEG(90);
      const url = await uploadTileToProductStorage(encoded) || await uploadTileToCloudinary(encoded);
      if (url) tiles.push(url);
    }

    return tiles.length > 0 ? tiles : [imageUrl];
  } catch (e) {
    console.error("[joom-bridge] processDetailImage failed:", imageUrl, e);
    return [imageUrl]; // fallback to original
  }
}

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

async function buildPayload(opts: any): Promise<any> {
  const { row, scrapedAssets, variantsConfig, categoryId, enabled, namePrefix, artist, album, contents, brand } = opts;
  if (!scrapedAssets?.mainImage) throw new Error("scrapedAssets.mainImage 가 비어있음");

  const productSku = String(row.sku || "").trim();
  if (!productSku) throw new Error("row.sku required");

  const listing = calcListingUSD(row.cost);
  const hasExplicitVariants = Array.isArray(variantsConfig) && variantsConfig.length > 0;
  const configs = hasExplicitVariants ? variantsConfig : [{ name: "DEFAULT", sku: productSku, inventory: 0 }];
  if (hasExplicitVariants && configs.length === 1) {
    const onlySku = String(configs[0]?.sku || "").trim();
    if (onlySku && onlySku !== productSku) {
      throw new Error("single variant product sku must equal option sku");
    }
  }
  const defaultWeightKg = gramsToKg(row.weight || 0);
  const seenSkus = new Set<string>();

  const variants = configs.map((cfg: any, idx: number) => {
    const vName = (cfg.name || "DEFAULT").trim();
    const vSku = String(cfg.sku || (!hasExplicitVariants && vName.toUpperCase() === "DEFAULT" ? productSku : "")).trim();
    if (!vSku) throw new Error(`variant SKU required: ${vName || idx + 1}`);
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
  const rawExtras: string[] = [
    ...(scrapedAssets.detailImages || []),
    ...(scrapedAssets.extraImages || []),
  ].slice(0, 9);

  const processedExtras: string[] = [];
  for (const url of rawExtras) {
    if (processedExtras.length >= 9) break;
    const tiles = await processDetailImage(url);
    for (const t of tiles) {
      if (processedExtras.length < 9) processedExtras.push(t);
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
  if (brand && brand.trim()) payload.brand = brand.trim();
  return payload;
}

function jsonResp(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const action = url.pathname.split("/").filter(Boolean).pop() || "";

  // Step 0 auth gate (plan v2.2): mutating Joom routes require a real signed-in
  // Supabase user. Public read-only routes (health/categories/lookup-sku) skip.
  if (!PUBLIC_JOOM_ACTIONS.has(action)) {
    const authResult = await requireAuthenticatedUser(req);
    if (authResult.response) {
      console.log(JSON.stringify({ service: "joom-bridge", event: "auth_rejected", action, ts: new Date().toISOString() }));
      return authResult.response;
    }
    console.log(JSON.stringify({ service: "joom-bridge", event: "auth_ok", action, user_id: authResult.user.id, ts: new Date().toISOString() }));
  }

  try {
    if (action === "health" && req.method === "GET") {
      return jsonResp({ ok: true, service: "joom-bridge", version: 12 });
    }

    if (action === "categories" && req.method === "GET") {
      const cats = await getCategories();
      return jsonResp({ ok: true, categories: cats });
    }

    if ((action === "publish" || action === "dryrun") && req.method === "POST") {
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

      const data = await joomFetch("/products/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const joomCategoryId = String(data.categoryId || data.category?.id || data.categoryByJoom?.id || "");
      return jsonResp({
        ok: true,
        joom_product_id: data.id,
        joom_sku: data.sku,
        state: data.state,
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
          code: i.code,
          kind: i.kind,
          note: i.note,
          regions: i.regions,
          description: i.description,
          where: i.where,
          brand_id: i.brandId,
          variant_sku: i.variantSku,
          is_permanent: i.isPermanent === true,
        })),
        computed_listing_usd,
      });
    }

    if (action === "lookup-sku" && req.method === "GET") {
      // GET /lookup-sku?sku=ABC → resolve Joom productId + variantId + currency + current price
      // for the variant whose sku matches. Also accepts ?id=<hex24> to lookup by Joom productId.
      // Returns product.state + variant.review when found so callers can poll moderation status.
      const sku = (url.searchParams.get("sku") || "").trim();
      const id = (url.searchParams.get("id") || "").trim();
      if (!sku && !id) return jsonResp({ ok: false, error: "sku or id query param required" }, 400);
      const isHexId = id && /^[a-f0-9]{24}$/.test(id);
      const qparam = isHexId ? `id=${encodeURIComponent(id)}` : `sku=${encodeURIComponent(sku)}`;
      try {
        const product = await joomFetch(`/products?${qparam}`);
        const variants: any[] = product?.variants || [];
        // If lookup is by id, return product+variants overview (no specific variant match needed).
        // If lookup is by sku, find matching variant; if no exact match still return product info
        // so callers can detect parent-vs-variant SKU confusion (was 404, now 200 with matched=null).
        const matched = sku ? variants.find((v: any) => String(v?.sku || "") === sku) : null;
        return jsonResp({
          ok: !sku || !!matched,
          joom_product_id: String(product?.id || ""),
          joom_product_state: product?.state || null,
          product_name: product?.name || "",
          main_image_state: product?.mainImage?.imageState || null,
          review: product?.review || null,
          variant_count: variants.length,
          variant_skus: variants.map((v: any) => v?.sku || null),
          joom_variant_id: matched ? String(matched.id || "") : null,
          joom_currency: matched ? String(matched.currency || "") : null,
          joom_price: matched && matched.price != null ? String(matched.price) : null,
          joom_enabled: matched ? !!matched.enabled : null,
          error: sku && !matched ? "variant_sku_not_found" : undefined,
        }, sku && !matched ? 404 : 200);
      } catch (e: any) {
        return jsonResp({ ok: false, error: "joom_product_not_found", detail: String(e?.message || e) }, 404);
      }
    }

    if (action === "update-price" && req.method === "POST") {
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
      const body = await req.json();
      const productId = body.productId;
      if (!productId) return jsonResp({ ok: false, error: "productId 필요" }, 400);
      const isHexId = /^[a-f0-9]{24}$/.test(productId);
      const param = isHexId ? `id=${encodeURIComponent(productId)}` : `sku=${encodeURIComponent(productId)}`;
      await joomFetch(`/products/remove?${param}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return jsonResp({ ok: true, deleted: productId });
    }

    return jsonResp({ ok: false, error: `unknown action: ${action} (${req.method})` }, 404);
  } catch (e: any) {
    console.error("[joom-bridge] error", e);
    return jsonResp({ ok: false, error: String(e?.message || e), stack: e?.stack }, 500);
  }
}

// @ts-ignore
Deno.serve(handleRequest);
