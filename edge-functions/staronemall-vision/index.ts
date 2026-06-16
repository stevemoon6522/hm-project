// staronemall-vision — v1
// Extracts K-pop album component list from a StarOneMall product detail image
// using Claude Vision API (Anthropic Messages API).
//
// POST /extract
//   body: { master_row_id: number, staronemall_url: string, image_url?: string }
//   - If products.components_extracted_en is already set → returns cached result (no re-call).
//   - Otherwise: fetch HTML, find largest wisacdn detail image, call Claude Vision,
//     save result to products, return { ok: true, components_en: string }.
//
// OPTIONS → 204 (CORS preflight, per feedback_supabase_cors_204_no_body)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// @ts-ignore Deno env
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// @ts-ignore Deno env
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// @ts-ignore Deno env
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const CLAUDE_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const CLAUDE_MAX_IMAGE_EDGE = 8000;
const CLAUDE_SAFE_IMAGE_EDGE = 7600;
const CLAUDE_MAX_CROP_TILES = 20;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "3600",
};

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type ImageDimensions = { width: number; height: number };
type ClaudeImageSource = { type: "url"; url: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function errResp(message: string, status = 400): Response {
  return jsonResp({ ok: false, error: message }, status);
}

function isStaronemallBannerImageUrl(url: string): boolean {
  const raw = String(url || "").trim();
  if (!raw) return false;

  let haystack = raw.toLowerCase();
  try {
    const parsed = new URL(raw, "https://www.staronemall.com");
    haystack = decodeURIComponent(`${parsed.hostname}${parsed.pathname}${parsed.search}`).toLowerCase();
  } catch {
    try {
      haystack = decodeURIComponent(raw).toLowerCase();
    } catch {
      haystack = raw.toLowerCase();
    }
  }

  return [
    /(?:^|[\/_.-])banner(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])bnr(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])event(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])notice(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])guide(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])common(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])footer(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])top(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])bottom(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])delivery(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])shipping(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])exchange(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])refund(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])return(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])cs(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])blank(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])spacer(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])transparent(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])pixel(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])empty(?:[\/_.-]|$)/,
  ].some((re) => re.test(haystack));
}

function filterStaronemallDetailImageUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls || []) {
    const value = String(url || "").trim();
    if (!value || seen.has(value) || isStaronemallBannerImageUrl(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Extract all staronemall/wisacdn detail image URLs from HTML. */
function extractDetailImageUrls(html: string): string[] {
  // Matches src/data-src attributes pointing to wisacdn detail image paths.
  // Priority: _data/attach and _data/product are the typical detail-image CDN paths.
  const pattern =
    /(?:src|data-src|href)=["'](https?:\/\/(?:staronemall2?\.wisacdn\.com|[^"']*wisacdn[^"']*)\/(?:_data\/attach|_data\/product)[^"']*\.(?:jpg|jpeg|png|webp))["']/gi;
  const seen = new Set<string>();
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html)) !== null) {
    const u = m[1];
    if (!seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  }
  return filterStaronemallDetailImageUrls(urls);
}

/** Pick the best detail image: prefer non-thumbnail, largest by URL path segment. */
function pickBestDetailImage(urls: string[]): string | null {
  if (urls.length === 0) return null;
  // Filter out thumbnails (paths containing /thumb/ or small numbers like _s, _m)
  const noThumb = urls.filter((u) => !/\/thumb\/|_[smt]\d*\./i.test(u));
  const pool = noThumb.length > 0 ? noThumb : urls;
  // If there are multiple, pick the last one (detail pages usually show main product
  // image first and component detail image further down in the DOM).
  // Return the first one as a reasonable default — operators can re-extract if needed.
  return pool[0];
}

function parseJpegSize(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xFF) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xD8 || marker === 0xD9) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) + bytes[i + 3];
    if (len < 2) return null;
    if (
      (marker >= 0xC0 && marker <= 0xC3) ||
      (marker >= 0xC5 && marker <= 0xC7) ||
      (marker >= 0xC9 && marker <= 0xCB) ||
      (marker >= 0xCD && marker <= 0xCF)
    ) {
      return {
        height: (bytes[i + 5] << 8) + bytes[i + 6],
        width: (bytes[i + 7] << 8) + bytes[i + 8],
      };
    }
    i += 2 + len;
  }
  return null;
}

function parsePngSize(bytes: Uint8Array): ImageDimensions | null {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4E ||
    bytes[3] !== 0x47
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function readUint24LE(bytes: Uint8Array, start: number): number {
  return bytes[start] + (bytes[start + 1] << 8) + (bytes[start + 2] << 16);
}

function parseWebpSize(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30 || readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WEBP") {
    return null;
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunk = readAscii(bytes, offset, 4);
    const size = bytes[offset + 4] + (bytes[offset + 5] << 8) + (bytes[offset + 6] << 16) + (bytes[offset + 7] << 24);
    const data = offset + 8;
    if (chunk === "VP8X" && data + 10 <= bytes.length) {
      return {
        width: readUint24LE(bytes, data + 4) + 1,
        height: readUint24LE(bytes, data + 7) + 1,
      };
    }
    if (chunk === "VP8 " && data + 10 <= bytes.length) {
      return {
        width: ((bytes[data + 7] << 8) | bytes[data + 6]) & 0x3FFF,
        height: ((bytes[data + 9] << 8) | bytes[data + 8]) & 0x3FFF,
      };
    }
    if (chunk === "VP8L" && data + 5 <= bytes.length && bytes[data] === 0x2F) {
      return {
        width: 1 + (((bytes[data + 2] & 0x3F) << 8) | bytes[data + 1]),
        height: 1 + (((bytes[data + 4] & 0x0F) << 10) | (bytes[data + 3] << 2) | ((bytes[data + 2] & 0xC0) >> 6)),
      };
    }
    offset = data + size + (size % 2);
  }
  return null;
}

async function readImageDimensions(imageUrl: string): Promise<ImageDimensions | null> {
  const resp = await fetch(imageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://www.staronemall.com/",
      Range: "bytes=0-65535",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok && resp.status !== 206) return null;
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return parsePngSize(bytes) || parseJpegSize(bytes) || parseWebpSize(bytes);
}

function cloudinaryFetchBaseUrl(imageUrl: string): string | null {
  // @ts-ignore Deno env
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME") || "";
  if (!cloudName) return null;
  return `https://res.cloudinary.com/${cloudName}/image/fetch`;
}

function buildCloudinaryFetchUrl(imageUrl: string, transforms: string): string | null {
  const base = cloudinaryFetchBaseUrl(imageUrl);
  if (!base) return null;
  return `${base}/${transforms}/f_jpg,q_90/${encodeURIComponent(imageUrl)}`;
}

function buildClaudeSafeImageUrls(imageUrl: string, dims: ImageDimensions | null): { urls: string[]; mode: string } {
  if (!dims) {
    const limited = buildCloudinaryFetchUrl(imageUrl, `c_limit,w_${CLAUDE_SAFE_IMAGE_EDGE},h_${CLAUDE_SAFE_IMAGE_EDGE}`);
    return limited ? { urls: [limited], mode: "cloudinary_limit_unknown" } : { urls: [imageUrl], mode: "original_unknown" };
  }

  if (dims.width <= CLAUDE_MAX_IMAGE_EDGE && dims.height <= CLAUDE_MAX_IMAGE_EDGE) {
    return { urls: [imageUrl], mode: "original" };
  }

  const xTiles = Math.ceil(dims.width / CLAUDE_SAFE_IMAGE_EDGE);
  const yTiles = Math.ceil(dims.height / CLAUDE_SAFE_IMAGE_EDGE);
  const tileCount = xTiles * yTiles;
  const urls: string[] = [];
  if (tileCount <= CLAUDE_MAX_CROP_TILES) {
    for (let yIndex = 0; yIndex < yTiles; yIndex += 1) {
      const y = yIndex * CLAUDE_SAFE_IMAGE_EDGE;
      const h = Math.min(CLAUDE_SAFE_IMAGE_EDGE, dims.height - y);
      for (let xIndex = 0; xIndex < xTiles; xIndex += 1) {
        const x = xIndex * CLAUDE_SAFE_IMAGE_EDGE;
        const w = Math.min(CLAUDE_SAFE_IMAGE_EDGE, dims.width - x);
        const tileUrl = buildCloudinaryFetchUrl(imageUrl, `c_crop,w_${w},h_${h},x_${x},y_${y}`);
        if (tileUrl) urls.push(tileUrl);
      }
    }
    if (urls.length) return { urls, mode: "cloudinary_crop_tiles" };
  }

  const limited = buildCloudinaryFetchUrl(imageUrl, `c_limit,w_${CLAUDE_SAFE_IMAGE_EDGE},h_${CLAUDE_SAFE_IMAGE_EDGE}`);
  if (limited) return { urls: [limited], mode: "cloudinary_limit" };

  throw new Error(
    `image dimensions ${dims.width}x${dims.height} exceed Claude Vision ${CLAUDE_MAX_IMAGE_EDGE}px limit and Cloudinary is not configured`
  );
}

async function prepareClaudeVisionImages(imageUrl: string): Promise<{
  sources: ClaudeImageSource[];
  original_dimensions: ImageDimensions | null;
  image_transform_mode: string;
}> {
  let dims: ImageDimensions | null = null;
  try {
    dims = await readImageDimensions(imageUrl);
  } catch (e) {
    console.warn("[staronemall-vision] image dimension read failed:", imageUrl, e);
  }
  const prepared = buildClaudeSafeImageUrls(imageUrl, dims);
  return {
    sources: prepared.urls.map((url) => ({ type: "url", url })),
    original_dimensions: dims,
    image_transform_mode: prepared.mode,
  };
}

/** Call Claude Vision API with prepared image URLs and return raw text response. */
async function callClaudeVision(imageSources: ClaudeImageSource[]): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set in Supabase secrets. Add it via: supabase secrets set ANTHROPIC_API_KEY=sk-ant-..."
    );
  }

  const prompt =
    "This is a K-pop album product detail image showing the included components.\n\n" +
    "Extract the complete list of components exactly as printed in the image. " +
    "Output in English only, one item per line, each prefixed with a hyphen (-).\n\n" +
    "Rules:\n" +
    "- Transcribe text exactly as visible in the image.\n" +
    "- If text is in Korean, translate to natural English: " +
    "  포토카드→Photo Card, 뷰마스터→View Master, 디스크→Disc, 엽서→Postcard, " +
    "  리릭카드→Lyric Card, 봉투→Envelope, 스티커→Sticker, 북릿→Booklet, " +
    "  트레이→Tray, 포스터→Poster, 엽서카드→Postcard, 아웃박스→Outbox.\n" +
    "- Include quantities and variant counts when visible (e.g. '5 types', '2 pcs').\n" +
    "- Do not add items not shown in the image.\n" +
    "- Output format: one hyphen-prefixed line per component, nothing else.";

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: [
          ...imageSources.map((source) => ({
            type: "image",
            source,
          })),
          {
            type: "text",
            text: prompt,
          },
        ],
      },
    ],
  };

  const resp = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => resp.statusText);
    throw new Error(`Claude Vision API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const text: string =
    data?.content?.[0]?.text || data?.content?.[0]?.value || "";
  if (!text) {
    throw new Error(
      "Claude Vision returned empty content: " + JSON.stringify(data)
    );
  }
  return text.trim();
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

// @ts-ignore Deno.serve
Deno.serve(async (req: Request) => {
  // CORS preflight — must return null body with 204 (Supabase Deno constraint)
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== "POST") {
    return errResp("Method not allowed. Use POST /extract.", 405);
  }

  // Parse URL to determine action
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/extract")) {
    return errResp(
      `Unknown path: ${path}. Use POST /staronemall-vision/extract.`,
      404
    );
  }

  // Parse body
  let body: { master_row_id?: unknown; staronemall_url?: unknown; image_url?: unknown };
  try {
    body = await req.json();
  } catch {
    return errResp("Invalid JSON body.");
  }

  const masterId = Number(body.master_row_id);
  const staronemallUrl = String(body.staronemall_url || "").trim();
  const requestedImageUrl = String(body.image_url || "").trim() || null;

  // master_row_id = 0 means "extract only, do not persist to DB" (used before the row is saved)
  const persistToDb = masterId > 0;

  if (isNaN(masterId)) {
    return errResp("master_row_id must be a number (use 0 to skip DB persist).");
  }
  if (!staronemallUrl || !staronemallUrl.includes("staronemall.com")) {
    return errResp(
      "staronemall_url is required and must be a staronemall.com URL."
    );
  }
  if (requestedImageUrl && !/^https?:\/\//i.test(requestedImageUrl)) {
    return errResp("image_url must be an absolute http(s) URL when provided.");
  }

  // --- 1. Check cache (only if persisting to a real row) ---
  if (persistToDb && !requestedImageUrl) {
    const { data: row, error: fetchErr } = await db
      .from("products")
      .select("components_extracted_en, components_extracted_at")
      .eq("id", masterId)
      .single();

    if (fetchErr) {
      return errResp(
        `DB fetch failed for product id=${masterId}: ${fetchErr.message}`,
        500
      );
    }

    if (row?.components_extracted_en) {
      // Cache hit — return without re-calling Vision API
      return jsonResp({
        ok: true,
        cached: true,
        components_en: row.components_extracted_en,
        extracted_at: row.components_extracted_at,
      });
    }
  }

  let candidates: string[] = [];
  if (!requestedImageUrl) {
    // --- 2. Fetch StarOneMall HTML ---
    let html: string;
    try {
      const pageResp = await fetch(staronemallUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,*/*;q=0.9",
        },
      });
      if (!pageResp.ok) {
        throw new Error(`HTTP ${pageResp.status} fetching ${staronemallUrl}`);
      }
      html = await pageResp.text();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return errResp(`staronemall page fetch failed: ${msg}`, 502);
    }

    candidates = extractDetailImageUrls(html);
  }

  // --- 3. Extract image URL ---
  const imageUrl = requestedImageUrl ?? pickBestDetailImage(candidates);

  if (!imageUrl) {
    return errResp(
      "No wisacdn detail image found in staronemall page HTML. " +
        `Tried ${candidates.length} candidates. ` +
        "URL: " + staronemallUrl,
      422
    );
  }

  // --- 4. Call Claude Vision ---
  let componentsEn: string;
  let visionImages: {
    sources: ClaudeImageSource[];
    original_dimensions: ImageDimensions | null;
    image_transform_mode: string;
  };
  try {
    visionImages = await prepareClaudeVisionImages(imageUrl);
    componentsEn = await callClaudeVision(visionImages.sources);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return errResp(`Claude Vision extraction failed for image ${imageUrl}: ${msg}`, 502);
  }

  if (!componentsEn) {
    return errResp("Claude Vision returned empty result.", 502);
  }

  // --- 5. Persist to DB (skipped when master_row_id = 0) ---
  if (persistToDb) {
    const { error: updateErr } = await db
      .from("products")
      .update({
        components_extracted_en: componentsEn,
        components_extracted_at: new Date().toISOString(),
        components_approved: 0,
      })
      .eq("id", masterId);

    if (updateErr) {
      return errResp(
        `DB update failed for product id=${masterId}: ${updateErr.message}`,
        500
      );
    }
  }

  return jsonResp({
    ok: true,
    cached: false,
    persisted: persistToDb,
    components_en: componentsEn,
    image_url_used: imageUrl,
    image_transform_mode: visionImages.image_transform_mode,
    image_source_count: visionImages.sources.length,
    image_original_dimensions: visionImages.original_dimensions,
  });
});
