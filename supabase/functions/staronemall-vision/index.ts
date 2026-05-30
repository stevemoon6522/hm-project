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
import { filterStaronemallDetailImageUrls } from "../_shared/staronemall-images.ts";

// @ts-ignore Deno env
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// @ts-ignore Deno env
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// @ts-ignore Deno env
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const CLAUDE_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "3600",
};

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

/** Call Claude Vision API with the image URL and return raw text response. */
async function callClaudeVision(imageUrl: string): Promise<string> {
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
          {
            type: "image",
            source: {
              type: "url",
              url: imageUrl,
            },
          },
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
  try {
    componentsEn = await callClaudeVision(imageUrl);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return errResp(`Claude Vision extraction failed: ${msg}`, 502);
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
  });
});
