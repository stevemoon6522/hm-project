// @ts-nocheck
// starone-crawl — StarOneMall product crawler in Deno.
//
// Step 1b (plan v2.2 §C.1): port of iau crawler_staronemall.py to a Supabase
// Edge Function running in the Seoul region. Why: StarOneMall geo-blocks
// non-Korean IPs. Railway / Vercel can't reach the site at all; only a
// KR-region serverless runtime (or proxy) can fetch HTML reliably.
//
// Input  (POST /starone-crawl):
//   {
//     urls: [string, ...],         // one or many product detail URLs
//     crawl_run_id?: uuid,         // groups multiple URLs from one operator
//                                  // click into the same source_records.crawl_run_id
//     write_to_source_records?: bool   // default true (writes one row per url
//                                      // for the operator preview path).
//     discover?: {                 // optional category discovery mode
//       keyword?: string,           // optional StarOneMall keyword search
//       url?: string,               // defaults to StarOneMall ALBUM list
//       pages?: number,             // default 1, max 5
//       limit?: number              // default 20, max 100
//     }
//   }
//
// Output: { ok, crawl_run_id, results: [
//   {
//     url, ok, source_record_id?, observed_values, raw_payload, error?, deduped?
//   }, ...
// ] }
//
// Auth: requires a real Supabase user session (Step 0 auth gate). Operators
// triggering bulk preview must be signed in.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { DOMParser, Element } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";
import { requireAuthenticatedUser } from "../_shared/auth.ts";
import { filterStaronemallDetailImageUrls } from "../_shared/staronemall-images.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const STARONE_CRON_SECRET =
  Deno.env.get("STARONE_CRON_SECRET") || Deno.env.get("CRON_SECRET") || "";

const PARSER_VERSION = "staronemall@2026-05-20.4";
const STARONEMALL_BASE = "https://www.staronemall.com";
const DEFAULT_DISCOVERY_URL = `${STARONEMALL_BASE}/shop/big_section.php?cno1=26`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-client-info, x-cron-secret",
  "Access-Control-Max-Age": "3600",
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function jsonResp(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function cronAuthorized(req: Request): boolean {
  if (!STARONE_CRON_SECRET) return false;
  const headerSecret = req.headers.get("x-cron-secret") || "";
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  return headerSecret === STARONE_CRON_SECRET || bearer === STARONE_CRON_SECRET;
}

function audit(event, payload = {}) {
  console.log(JSON.stringify({
    service: "starone-crawl", event, ts: new Date().toISOString(), ...payload,
  }));
}

// ---------------------------------------------------------------------------
// HTML fetch
// ---------------------------------------------------------------------------
async function fetchHtml(url: string): Promise<{ ok: boolean; html?: string; error?: string }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          Referer: "https://www.staronemall.com",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) {
        if (attempt < 3) {
          await new Promise((res) => setTimeout(res, 1000 * attempt));
          continue;
        }
        return { ok: false, error: `http_${r.status}` };
      }
      // staronemall may return EUC-KR or UTF-8. Try UTF-8 first; if Korean
      // looks garbled, retry with explicit decode.
      const buf = await r.arrayBuffer();
      let text = new TextDecoder("utf-8").decode(buf);
      const textLen = Math.max(text.length, 1);
      const replacementRatio = (text.match(/\uFFFD/g) || []).length / textLen;
      const koreanRatio = (text.match(/[가-힣]/g) || []).length / textLen;
      const mojibakeRatio = (text.match(/(?:Ã|Â|ì|í|î|ï|ë|ê|ð|챙|혔|쨍|쩌|占)/g) || []).length / textLen;
      const declaresKoreanLegacy = /charset\s*=\s*["']?(?:euc-kr|ks_c_5601-1987|cp949)/i.test(text);
      if (replacementRatio > 0.005 || mojibakeRatio > 0.002 || declaresKoreanLegacy || (textLen > 1000 && koreanRatio < 0.01 && /staronemall|big_section|shop\/detail/i.test(text))) {
        try {
          const eucText = new TextDecoder("euc-kr").decode(buf);
          const eucLen = Math.max(eucText.length, 1);
          const eucKoreanRatio = (eucText.match(/[가-힣]/g) || []).length / eucLen;
          const eucReplacementRatio = (eucText.match(/\uFFFD/g) || []).length / eucLen;
          if (eucKoreanRatio >= koreanRatio || eucReplacementRatio < replacementRatio) {
            text = eucText;
          }
        } catch {
          // stay with utf-8
        }
      }
      return { ok: true, html: text };
    } catch (e) {
      if (attempt >= 3) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      await new Promise((res) => setTimeout(res, 1000 * attempt));
    }
  }
  return { ok: false, error: "fetch_exhausted_retries" };
}

// ---------------------------------------------------------------------------
// Extraction helpers (mirror crawler_staronemall.py)
// ---------------------------------------------------------------------------

function normalizeImageUrl(url: string): string {
  const u = (url || "").trim();
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("http")) return u;
  if (u.startsWith("/")) return STARONEMALL_BASE + u;
  return u;
}

function normalizeUrl(raw: string, base = STARONEMALL_BASE): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    return new URL(value, base).href;
  } catch {
    return "";
  }
}

function getImgSrc(img: Element): string {
  for (const attr of ["data-src", "data-original", "data-lazy-src", "src"]) {
    const v = (img.getAttribute(attr) || "").trim();
    if (v) return normalizeImageUrl(v);
  }
  return "";
}

function isJpg(url: string): boolean {
  try {
    const p = new URL(url).pathname.toLowerCase();
    return p.endsWith(".jpg") || p.endsWith(".jpeg");
  } catch {
    return false;
  }
}

function isRasterImageUrl(url: string): boolean {
  try {
    const p = new URL(url).pathname.toLowerCase();
    return /\.(jpe?g|png|webp)(\?|$)/i.test(p);
  } catch {
    return /\.(jpe?g|png|webp)(\?|$)/i.test(url);
  }
}

function isLikelyDetailImageUrl(url: string): boolean {
  const u = (url || "").toLowerCase();
  if (!u || !isRasterImageUrl(u)) return false;
  if (!(u.includes("wisacdn.com") || u.includes("staronemall.com"))) return false;
  return (
    u.includes("/attach/") ||
    u.includes("/editor/") ||
    u.includes("/detail") ||
    u.includes("/contents/") ||
    u.includes("/goods/")
  );
}

function dedupArr<T>(arr: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of arr) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function extractTitle(doc): string {
  // First h3/h2/h1 with text length > 5 (skip "검색결과", "관련상품")
  for (const tag of ["h3", "h2", "h1"]) {
    const els = doc.querySelectorAll(tag);
    for (const h of els) {
      const text = (h.textContent || "").trim();
      if (
        text &&
        text.length > 5 &&
        !text.includes("검색결과") &&
        !text.includes("관련상품")
      ) {
        return text;
      }
    }
  }
  const og = doc.querySelector('meta[property="og:title"]');
  if (og) {
    let content = (og.getAttribute("content") || "").trim();
    if (content) {
      // strip "[ALBUM] " style prefix
      content = content.replace(/^\[[^\]]+\]\s*/, "");
      return content;
    }
  }
  return "";
}

function extractArtist(title: string): string {
  if (!title) return "";
  // Korean in parens: "IVE (아이브) ..."  → "아이브"
  const koreanInParens = title.match(/\(([가-힣ㄱ-ㅎㅏ-ㅣ]+)\)/);
  if (koreanInParens) return koreanInParens[1].trim();
  // "Artist - Title" pattern
  const dashMatch = title.match(/^([^\-\[]+?)\s*[\-\[]/);
  if (dashMatch) {
    const candidate = dashMatch[1].trim();
    if (candidate.length > 1 && candidate.length < 30) return candidate;
  }
  return "";
}

function parsePriceNumber(text: string): number {
  if (!text) return 0;
  // Find the largest number with thousands separators
  const m = text.match(/[\d,]{3,}/g) || [];
  let best = 0;
  for (const tok of m) {
    const n = Number(tok.replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 100 && n <= 10_000_000 && n > best) {
      best = n;
    }
  }
  return best;
}

function isUnderStrikethrough(elNode): boolean {
  // Walk up parents looking for <s>, <del>, <strike> — those wrap the
  // strikethrough "Retail price" that we must NOT use as cost.
  let cur = elNode?.parentElement;
  while (cur) {
    const tag = String(cur.tagName || "").toUpperCase();
    if (tag === "S" || tag === "DEL" || tag === "STRIKE") return true;
    const cls = String(cur.getAttribute?.("class") || "").toLowerCase();
    if (cls && /\b(retail|original|strike|line[-_]?through)\b/.test(cls)) return true;
    if (cur.tagName === "BODY" || cur.tagName === "HTML") break;
    cur = cur.parentElement;
  }
  return false;
}

function extractPrice(doc, html: string): number {
  // StarOneMall renders the members-only / VAT-excluded price via JS and
  // never bakes it into the visible HTML; only the retail (strikethrough)
  // price shows up as text. The actual cost-to-pay (wholesale × 1.1) is
  // however present in hidden form inputs that the cart page consumes:
  //
  //   <input type="hidden" name="total_prc"     value="14256">
  //   <input type="hidden" name="pay_prc"       value="14256">
  //   <input type="hidden" name="new_total_prc" value="14256">
  //
  // These values are ALREADY 12,960 × 1.1 — no additional multiplier
  // required (operator screenshot msg #499).
  //
  // Primary path: read total_prc / pay_prc / new_total_prc directly.
  // Fallbacks (legacy and other pages): retain the <strong>-based + ×1.1
  // logic from msg #485 so older layouts still work.
  const WHOLESALE_MULTIPLIER = 1.1;

  for (const name of ["total_prc", "pay_prc", "new_total_prc"]) {
    const m = html.match(
      new RegExp(`<input[^>]*name=["']${name}["'][^>]*value=["']([0-9,]+)["']`, "i"),
    );
    if (m) {
      const v = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(v) && v > 0) return Math.round(v);
    }
  }

  const priceDiv = doc.querySelector("div.price");
  if (priceDiv) {
    const strongs = Array.from(priceDiv.querySelectorAll("strong"))
      .filter((s) => !isUnderStrikethrough(s));
    for (const s of strongs) {
      const parentText = (s.parentElement?.textContent || "").toUpperCase();
      if (parentText.includes("VAT")) {
        const v = parsePriceNumber(s.textContent || "");
        if (v >= 100) return Math.round(v * WHOLESALE_MULTIPLIER);
      }
    }
    for (const s of strongs) {
      const v = parsePriceNumber(s.textContent || "");
      if (v >= 100) return Math.round(v * WHOLESALE_MULTIPLIER);
    }
    for (const cls of ["sell", "consumer"]) {
      const el = priceDiv.querySelector(`.${cls}`);
      if (el && !isUnderStrikethrough(el)) {
        const v = parsePriceNumber(el.textContent || "");
        if (v >= 100) return Math.round(v * WHOLESALE_MULTIPLIER);
      }
    }
  }
  const text = doc.body?.textContent || "";
  const membersOnly = text.match(/Members?\s*Only\s*Price[^\d]{0,30}([\d,]{3,})\s*원/i);
  if (membersOnly) {
    const v = Number(membersOnly[1].replace(/,/g, ""));
    if (Number.isFinite(v) && v >= 100) return Math.round(v * WHOLESALE_MULTIPLIER);
  }
  const vatExcluded = text.match(/([\d,]{3,})\s*원[^A-Za-z]{0,8}\(?\s*VAT/i);
  if (vatExcluded) {
    const v = Number(vatExcluded[1].replace(/,/g, ""));
    if (Number.isFinite(v) && v >= 100) return Math.round(v * WHOLESALE_MULTIPLIER);
  }
  return 0;
}

function extractReleaseDate(doc): string {
  const text = doc.body?.textContent || "";
  const en = text.match(/Release\s*Date[^\d]*(\d{4}[-./]\d{1,2}[-./]\d{1,2})/i);
  if (en) return normalizeDate(en[1]);
  const ko = text.match(/발매일[^\d]*(\d{4}[-./]\d{1,2}[-./]\d{1,2})/);
  if (ko) return normalizeDate(ko[1]);
  return "";
}

function normalizeDate(raw: string): string {
  // YYYY[-./]MM[-./]DD → YYYY-MM-DD
  const m = raw.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (!m) return raw;
  const yyyy = m[1];
  const mm = String(m[2]).padStart(2, "0");
  const dd = String(m[3]).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function extractDescription(doc): string {
  for (const keyword of ["상품정보", "Product information", "Product introduction"]) {
    const walker = doc.createTreeWalker
      ? null
      : null;
    // deno-dom doesn't have createTreeWalker; do a manual scan
    const allElements = doc.querySelectorAll("*");
    for (const el of allElements) {
      const t = (el.textContent || "").trim();
      if (!t) continue;
      // Only check headings / leaf-ish elements
      if (!t.includes(keyword)) continue;
      // Find the closest div/section ancestor (could be self)
      let container = el;
      while (container && !["DIV", "SECTION"].includes(container.tagName)) {
        container = container.parentElement;
      }
      if (!container) continue;
      // Pull text chunks from p/div/li
      const chunks: string[] = [];
      for (const tag of ["p", "div", "li"]) {
        const subs = container.querySelectorAll(tag);
        for (const sub of subs) {
          const txt = (sub.textContent || "").trim();
          if (txt && txt.length > 1) chunks.push(txt);
          if (chunks.length >= 50) break;
        }
        if (chunks.length >= 50) break;
      }
      if (chunks.length > 0) {
        return chunks.slice(0, 50).join("<br>").slice(0, 5000);
      }
    }
  }
  return "";
}

function extractMainImages(doc, maxN = 5): string[] {
  const urls: string[] = [];
  const mainImg = doc.querySelector('img[id="mainImg"]');
  if (mainImg) {
    const src = (mainImg.getAttribute("src") || "").trim();
    if (src) urls.push(normalizeImageUrl(src));
    for (let i = 1; i <= 10; i++) {
      const up = (mainImg.getAttribute(`upfile${i}`) || "").trim();
      if (up) urls.push(normalizeImageUrl(up));
    }
  }
  if (urls.length === 0) {
    const imgs = doc.querySelectorAll("img");
    for (const img of imgs) {
      const src = getImgSrc(img);
      if (src && src.includes("wisacdn.com") && src.includes("/product/")) {
        urls.push(src);
        if (urls.length >= maxN * 2) break;
      }
    }
  }
  if (urls.length === 0) {
    const og = doc.querySelector('meta[property="og:image"]');
    if (og) {
      const c = (og.getAttribute("content") || "").trim();
      if (c) urls.push(c);
    }
  }
  return dedupArr(urls).slice(0, maxN);
}

function extractDetailImages(doc, maxN = Number.POSITIVE_INFINITY): string[] {
  const urls: string[] = [];
  // class="img_obj_*"
  const imgObjList = doc.querySelectorAll('img[class^="img_obj_"]');
  for (const img of imgObjList) {
    const src = getImgSrc(img);
    if (src && isRasterImageUrl(src)) urls.push(src);
  }
  const detailContainers = [
    "#detail",
    "#contents",
    "#product_detail",
    ".goods_detail",
    ".detail",
    ".detail_cont",
    ".detail-img",
    ".prd-detail",
    ".view",
    ".description",
    ".item_detail",
  ];
  for (const selector of detailContainers) {
    const containers = doc.querySelectorAll(selector);
    for (const container of containers) {
      const imgs = container.querySelectorAll("img");
      for (const img of imgs) {
        const src = getImgSrc(img);
        if (src && isLikelyDetailImageUrl(src)) urls.push(src);
      }
    }
  }
  if (urls.length === 0) {
    const imgs = doc.querySelectorAll("img");
    for (const img of imgs) {
      const src = getImgSrc(img);
      if (src && isLikelyDetailImageUrl(src)) {
        urls.push(src);
      }
    }
  }
  const filtered = filterStaronemallDetailImageUrls(dedupArr(urls));
  if (!Number.isFinite(maxN) || maxN <= 0) return filtered;
  return filtered.slice(0, Math.floor(maxN));
}

function extractPno(url: string): string | null {
  try {
    const u = new URL(url);
    const pno = u.searchParams.get("pno");
    return pno || null;
  } catch {
    return null;
  }
}

function detailUrlFromHref(href: string, baseUrl: string): string {
  const normalized = normalizeUrl(href, baseUrl);
  if (!normalized) return "";
  try {
    const u = new URL(normalized);
    if (!/staronemall\.com$/i.test(u.hostname)) return "";
    if (!/\/shop\/detail\.php$/i.test(u.pathname)) return "";
    if (!u.searchParams.get("pno")) return "";
    return u.href;
  } catch {
    return "";
  }
}

function nearbyTextContainer(anchor: Element): Element {
  let cur: Element | null = anchor;
  for (let i = 0; i < 5 && cur?.parentElement; i++) {
    const text = String(cur.parentElement.textContent || "");
    if (/Retail price|Members Only Price|Sold out/i.test(text)) {
      return cur.parentElement;
    }
    cur = cur.parentElement;
  }
  return anchor.parentElement || anchor;
}

function nearbyImageUrl(anchor: Element, baseUrl: string): string {
  let cur: Element | null = anchor;
  for (let i = 0; i < 6 && cur; i++) {
    const imgs = cur.querySelectorAll("img");
    for (const img of imgs) {
      const src = getImgSrc(img);
      if (src) return normalizeUrl(src, baseUrl);
    }
    cur = cur.parentElement;
  }
  return "";
}

function cleanDiscoveryTitle(text: string): string {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/^Details$/i, "")
    .replace(/^Add to Cart$/i, "")
    .trim();
}

function extractRetailPrice(text: string): number {
  const match = String(text || "").match(/Retail\s*price\s*([\d,]+)/i);
  if (!match) return 0;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : 0;
}

function extractDiscoveryItems(html: string, pageUrl: string, limit: number) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return [];
  const byPno = new Map();
  const anchors = doc.querySelectorAll("a");
  for (const a of anchors) {
    const url = detailUrlFromHref(a.getAttribute("href") || "", pageUrl);
    if (!url) continue;
    const pno = extractPno(url);
    if (!pno) continue;
    const title = cleanDiscoveryTitle(a.textContent || "");
    const existing = byPno.get(pno) || {
      url,
      pno,
      title: "",
      thumbnail_url: "",
      retail_price_krw: 0,
      sold_out: false,
    };
    if (title && title.length > 3 && !/^(Details|Add to Cart)$/i.test(title)) {
      existing.title = existing.title || title;
    }
    const container = nearbyTextContainer(a);
    const containerText = String(container.textContent || "");
    existing.thumbnail_url = existing.thumbnail_url || nearbyImageUrl(a, pageUrl);
    existing.retail_price_krw = existing.retail_price_krw || extractRetailPrice(containerText);
    existing.sold_out = existing.sold_out || /Sold out/i.test(containerText);
    byPno.set(pno, existing);
    if (byPno.size >= limit) break;
  }
  return Array.from(byPno.values()).filter((item) => item.title || item.url).slice(0, limit);
}

function discoveryPageUrl(baseUrl: string, page: number): string {
  const u = new URL(baseUrl || DEFAULT_DISCOVERY_URL, STARONEMALL_BASE);
  if (page > 1) {
    u.searchParams.set("page", String(page));
    if (!u.searchParams.has("withsoldout")) u.searchParams.set("withsoldout", "Y");
  }
  return u.href;
}

function discoveryBaseUrl(discover): string {
  const keyword = String(discover?.keyword || "").trim();
  if (keyword) {
    const u = new URL(`${STARONEMALL_BASE}/shop/search_result.php`);
    u.searchParams.set("search_str", keyword);
    u.searchParams.set("withsoldout", "Y");
    return u.href;
  }
  return normalizeUrl(discover?.url || DEFAULT_DISCOVERY_URL, STARONEMALL_BASE);
}

async function discoverStaronemallProducts(
  discover,
  supabase,
  actor: string,
  crawl_run_id: string,
  options = { writeToSourceRecords: true },
) {
  const writeToSourceRecords = options?.writeToSourceRecords !== false;
  const baseUrl = discoveryBaseUrl(discover);
  if (!baseUrl || !/staronemall\.com/i.test(baseUrl)) {
    return { ok: false, error: "invalid_discovery_url", status: 400 };
  }
  const pages = Math.max(1, Math.min(Number(discover?.pages || 1), 5));
  const limit = Math.max(1, Math.min(Number(discover?.limit || 20), 100));
  const candidates = [];
  for (let page = 1; page <= pages && candidates.length < limit; page++) {
    const pageUrl = discoveryPageUrl(baseUrl, page);
    const fetched = await fetchHtml(pageUrl);
    if (!fetched.ok) {
      candidates.push({ page_url: pageUrl, ok: false, error: fetched.error || "fetch_failed" });
      continue;
    }
    const items = extractDiscoveryItems(fetched.html || "", pageUrl, limit - candidates.length);
    candidates.push(...items.map((item) => ({ ...item, ok: true, page_url: pageUrl })));
  }

  const results = [];
  for (const item of candidates) {
    if (!item.ok) {
      results.push(item);
      continue;
    }
    const pno = item.pno || extractPno(item.url);
    if (!pno) {
      results.push({ ...item, ok: false, error: "missing_pno" });
      continue;
    }

    const raw_payload = {
      discovery_url: baseUrl,
      page_url: item.page_url,
      url: item.url,
      pno,
      title: item.title,
      thumbnail_url: item.thumbnail_url,
      retail_price_krw: item.retail_price_krw,
      sold_out: item.sold_out,
    };
    const observed_values = {
      title: item.title,
      pno,
      main_image_urls: item.thumbnail_url ? [item.thumbnail_url] : [],
      retail_price_krw: item.retail_price_krw || 0,
      discovery_url: baseUrl,
      discovery_page_url: item.page_url,
      sold_out: Boolean(item.sold_out),
    };
    if (!writeToSourceRecords) {
      results.push({
        ...item,
        pno,
        observed_values,
        raw_payload,
        deduped: false,
        preview_only: true,
      });
      continue;
    }

    const existingProduct = await supabase
      .from("products")
      .select("id, sku, lifecycle_state")
      .eq("staronemall_url", item.url)
      .maybeSingle();
    const existingSource = await supabase
      .from("source_records")
      .select("id, status, fetched_at")
      .eq("source_type", "staronemall")
      .eq("source_external_id", pno)
      .eq("parser_version", PARSER_VERSION)
      .maybeSingle();

    if (existingProduct.data || existingSource.data) {
      results.push({
        ...item,
        source_record_id: existingSource.data?.id || null,
        source_record_status: existingSource.data?.status || null,
        product_id: existingProduct.data?.id || null,
        deduped: true,
      });
      continue;
    }

    const raw_payload_hash = await sha256Hex(JSON.stringify(raw_payload));
    const { data, error } = await supabase
      .from("source_records")
      .insert({
        source_type: "staronemall",
        source_external_id: pno,
        source_url: item.url,
        crawl_run_id,
        parser_version: PARSER_VERSION,
        raw_payload,
        raw_payload_hash,
        observed_values,
        confidence: 50,
        tier: 2,
        status: "pending_review",
      })
      .select("id")
      .single();
    if (error) {
      results.push({ ...item, ok: false, error: `insert_failed: ${error.message}` });
      continue;
    }
    const source_record_id = data?.id || null;
    if (source_record_id) {
      await supabase.from("audit_log").insert({
        entity_type: "source_record",
        entity_uuid: source_record_id,
        source_record_id,
        actor,
        action: "create",
        reason: "staronemall_discovery",
        after_json: { source_type: "staronemall", source_external_id: pno, crawl_run_id },
        batch_id: crawl_run_id,
      });
    }
    results.push({ ...item, source_record_id, deduped: false });
  }

  const created = results.filter((r) => r.ok && r.source_record_id && !r.deduped).length;
  const deduped = results.filter((r) => r.ok && r.deduped).length;
  return {
    ok: true,
    crawl_run_id,
    discovery_url: baseUrl,
    results,
    summary: { total: results.length, created, deduped, failed: results.filter((r) => r.ok === false).length },
  };
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Main per-URL crawl
// ---------------------------------------------------------------------------
async function crawlOne(url: string) {
  const fetched = await fetchHtml(url);
  if (!fetched.ok) {
    return {
      url,
      ok: false,
      error: fetched.error || "fetch_failed",
    };
  }
  const html = fetched.html || "";
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch (e) {
    return {
      url,
      ok: false,
      error: `parse_failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!doc) return { url, ok: false, error: "dom_parse_returned_null" };

  const title = extractTitle(doc);
  const artist = extractArtist(title);
  const price_krw = extractPrice(doc, html);
  const release_date = extractReleaseDate(doc);
  const description_html = extractDescription(doc);
  const main_image_urls = extractMainImages(doc, 5);
  const detail_image_urls = extractDetailImages(doc);
  const pno = extractPno(url);

  const observed_values = {
    title,
    artist_name: artist,
    price_krw,
    release_date,
    description_html: description_html.slice(0, 5000),
    main_image_urls,
    detail_image_urls,
    pno,
  };
  // raw_payload is what we'd save for parser_version replay; keep it small.
  const raw_payload = {
    url,
    title,
    artist,
    price_krw,
    release_date,
    main_image_count: main_image_urls.length,
    detail_image_count: detail_image_urls.length,
    description_length: description_html.length,
    pno,
  };
  return {
    url,
    ok: true,
    pno,
    observed_values,
    raw_payload,
  };
}

// ---------------------------------------------------------------------------
// Main Edge Function handler
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return jsonResp(405, { ok: false, error: "method_not_allowed" });
  }

  // Auth gate (Step 0): signed-in operators can crawl manually; the scheduled
  // discovery route can use the shared cron secret without a user session.
  const isCron = cronAuthorized(req);
  let userEmail = "unknown";
  if (isCron) {
    userEmail = "cron:staronemall-discovery";
  } else {
    const authResult = await requireAuthenticatedUser(req);
    if (authResult.response) {
      audit("auth_rejected");
      return authResult.response;
    }
    userEmail = authResult.user.email || "unknown";
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResp(500, { ok: false, error: "starone_crawl_misconfigured" });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return jsonResp(400, {
      ok: false,
      error: "invalid_json",
      message: e instanceof Error ? e.message : String(e),
    });
  }
  const urls: string[] = Array.isArray(body.urls) ? body.urls : [];
  const crawl_run_id =
    typeof body.crawl_run_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      body.crawl_run_id,
    )
      ? body.crawl_run_id
      : crypto.randomUUID();
  const writeToSourceRecords = body.write_to_source_records !== false;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (body.discover) {
    audit("discovery_started", { crawl_run_id, actor: userEmail, discover: body.discover });
    const discovery = await discoverStaronemallProducts(
      body.discover,
      supabase,
      isCron ? userEmail : `user:${userEmail}`,
      crawl_run_id,
      { writeToSourceRecords },
    );
    if (!discovery.ok) return jsonResp(discovery.status || 500, discovery);
    audit("discovery_done", { crawl_run_id, summary: discovery.summary });
    return jsonResp(200, discovery);
  }

  if (urls.length === 0) {
    return jsonResp(400, { ok: false, error: "urls_required" });
  }
  if (urls.length > 50) {
    return jsonResp(400, {
      ok: false,
      error: "too_many_urls",
      message: "Maximum 50 URLs per call",
    });
  }

  audit("crawl_started", { crawl_run_id, url_count: urls.length, actor: userEmail });

  // Sequentially crawl (StarOneMall is forgiving of moderate traffic but
  // bursts can trigger temporary blocks).
  const results = [];
  for (const url of urls) {
    let trimmed = (url || "").trim();
    if (!trimmed) {
      results.push({ url, ok: false, error: "empty_url" });
      continue;
    }
    if (!trimmed.startsWith("http")) trimmed = "https://" + trimmed;
    if (!/staronemall\.com/i.test(trimmed)) {
      results.push({ url: trimmed, ok: false, error: "not_a_staronemall_url" });
      continue;
    }

    const result = await crawlOne(trimmed);
    if (!result.ok) {
      results.push(result);
      continue;
    }

    let source_record_id: string | null = null;
    let deduped = false;

    if (writeToSourceRecords) {
      const raw_payload_hash = await sha256Hex(JSON.stringify(result.raw_payload));
      const insertPayload = {
        source_type: "staronemall",
        source_external_id: result.pno,
        source_url: trimmed,
        crawl_run_id,
        parser_version: PARSER_VERSION,
        raw_payload: result.raw_payload,
        raw_payload_hash,
        observed_values: result.observed_values,
        confidence: 60,
        tier: 2,
        status: "pending_review",
      };
      const { data, error } = await supabase
        .from("source_records")
        .insert(insertPayload)
        .select("id")
        .single();

      if (error) {
        // Dedupe by (source_type, source_external_id, parser_version)
        if (
          /duplicate key|source_records_external_uniq/i.test(error.message || "")
        ) {
          const { data: existing } = await supabase
            .from("source_records")
            .select("id")
            .eq("source_type", "staronemall")
            .eq("source_external_id", result.pno)
            .eq("parser_version", PARSER_VERSION)
            .maybeSingle();
          source_record_id = existing?.id || null;
          deduped = true;
          if (source_record_id) {
            await supabase.from("audit_log").insert({
              entity_type: "source_record",
              entity_uuid: source_record_id,
              source_record_id,
              actor: `user:${userEmail}`,
              action: "sync",
              reason: "dedupe_hit_replay",
              batch_id: crawl_run_id,
            });
          }
        } else {
          results.push({ url: trimmed, ok: false, error: `insert_failed: ${error.message}` });
          continue;
        }
      } else {
        source_record_id = data?.id || null;
        if (source_record_id) {
          await supabase.from("audit_log").insert({
            entity_type: "source_record",
            entity_uuid: source_record_id,
            source_record_id,
            actor: `user:${userEmail}`,
            action: "create",
            after_json: {
              source_type: "staronemall",
              source_external_id: result.pno,
              parser_version: PARSER_VERSION,
              crawl_run_id,
            },
            batch_id: crawl_run_id,
          });
        }
      }
    }

    results.push({
      url: trimmed,
      ok: true,
      source_record_id,
      deduped,
      observed_values: result.observed_values,
    });
  }

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  audit("crawl_done", { crawl_run_id, ok: okCount, fail: failCount });

  return jsonResp(200, {
    ok: true,
    crawl_run_id,
    results,
    summary: { total: results.length, ok: okCount, fail: failCount },
  });
});
