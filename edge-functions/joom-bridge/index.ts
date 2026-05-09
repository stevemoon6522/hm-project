// Joom Bridge — v11
// Changes from v10:
//   - Fix: safeSku fallback no longer appends "-DEFAULT" for single-variant DEFAULT products
//   - Add /update-price handler
//   - Fix: include product SKU and categoryId in /products/create payload

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

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
// Portrait image splitting
// Tall images (height > width * 1.5) are split into square tiles.
// Requires CLOUDINARY_* env vars to host the split tiles.
// ---------------------------------------------------------------------------

async function processDetailImage(imageUrl: string): Promise<string[]> {
  // @ts-ignore
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME") || "";
  if (!cloudName) return [imageUrl]; // skip if Cloudinary not configured

  try {
    const resp = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.staronemall.com/" },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return [imageUrl];
    const buf = new Uint8Array(await resp.arrayBuffer());

    // @ts-ignore
    const { Image } = await import("https://deno.land/x/imagescript@1.3.0/mod.ts");
    const img = await Image.decode(buf);

    // Only split if height > 1.5× width (portrait detail image)
    if (img.height <= img.width * 1.5) return [imageUrl];

    const tileSize = img.width;
    const numTiles = Math.min(Math.ceil(img.height / tileSize), 4); // cap at 4 tiles
    const tiles: string[] = [];

    for (let i = 0; i < numTiles; i++) {
      const y = i * tileSize;
      const h = Math.min(tileSize, img.height - y);
      const tile = img.clone().crop(0, y, img.width, h);

      // Pad shorter last tile to square with white background
      let square;
      if (h < tileSize) {
        square = new Image(tileSize, tileSize);
        square.fill(0xFFFFFFFF);
        square.composite(tile, 0, 0);
      } else {
        square = tile;
      }

      const encoded: Uint8Array = await square.encode(2); // JPEG
      const url = await uploadTileToCloudinary(encoded);
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
  const configs = (variantsConfig && variantsConfig.length) ? variantsConfig : [{ name: "DEFAULT", sku: productSku, inventory: 0 }];
  const defaultWeightKg = gramsToKg(row.weight || 0);
  const seenSkus = new Set<string>();

  const variants = configs.map((cfg: any, idx: number) => {
    const vName = (cfg.name || "DEFAULT").trim();
    const vSku = String(cfg.sku || (vName.toUpperCase() === "DEFAULT" ? productSku : "")).trim();
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
    ...(scrapedAssets.extraImages || []),
    ...(scrapedAssets.detailImages || []),
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
          code: i.code, kind: i.kind, note: i.note, regions: i.regions,
        })),
        computed_listing_usd,
      });
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

      const updatedVariants = targets.map((v: any) => ({ ...v, price: String(price), currency: "USD" }));
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
