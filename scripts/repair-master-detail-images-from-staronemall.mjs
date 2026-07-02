#!/usr/bin/env node
/**
 * Dry-run StarOneMall detail-image backfill for a grouped master product.
 *
 * Default target:
 *   [READY STOCK] V - Layover
 *
 * Usage:
 *   node scripts/repair-master-detail-images-from-staronemall.mjs
 *   node scripts/repair-master-detail-images-from-staronemall.mjs --group-id=baf12505-e115-440f-97a4-61c4288121c0
 *   node scripts/repair-master-detail-images-from-staronemall.mjs --group-id=... --apply --confirm=...
 *
 * Optional env for StarOneMall crawl:
 *   STARONE_CRAWL_TOKEN or SUPABASE_ACCESS_TOKEN  signed-in operator access token
 *   STARONE_CRON_SECRET or CRON_SECRET            cron secret accepted by starone-crawl
 *
 * Optional env for REST writes:
 *   SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_KEY
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_GROUP_ID = 'baf12505-e115-440f-97a4-61c4288121c0';
const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const SUPABASE_URL = html.match(/const SUPABASE_URL = '([^']+)'/)?.[1]?.replace(/\/+$/, '');
const SUPABASE_ANON = html.match(/const SUPABASE_ANON = '([^']+)'/)?.[1];
if (!SUPABASE_URL || !SUPABASE_ANON) throw new Error('Could not read Supabase URL/anon key from v2/index.html');

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--') && !arg.includes('=')));
const options = Object.fromEntries(args
  .filter((arg) => arg.startsWith('--') && arg.includes('='))
  .map((arg) => {
    const eq = arg.indexOf('=');
    return [arg.slice(2, eq), arg.slice(eq + 1)];
  }));

const groupId = String(options['group-id'] || DEFAULT_GROUP_ID).trim();
const apply = flags.has('--apply');
const confirm = String(options.confirm || '').trim();
const noCrawl = flags.has('--no-crawl');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

if (!groupId) die('ERROR: --group-id is required.');
if (apply && confirm !== groupId) {
  die(`ERROR: DB writes require both --apply and --confirm=${groupId}.`);
}

const anonHeaders = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  'Content-Type': 'application/json',
};
const serviceHeaders = serviceKey
  ? { ...anonHeaders, apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
  : null;

function die(message) {
  console.error(message);
  process.exit(1);
}

function sqlQuote(value) {
  return `'${String(value || '').replaceAll("'", "''")}'`;
}

function parseDbJson(out) {
  const trimmed = String(out || '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : (parsed.rows || []);
  } catch {
    const starts = [trimmed.indexOf('['), trimmed.indexOf('{')].filter((index) => index >= 0);
    if (!starts.length) throw new Error(`supabase db query did not return JSON: ${trimmed.slice(0, 200)}`);
    const parsed = JSON.parse(trimmed.slice(Math.min(...starts)));
    return Array.isArray(parsed) ? parsed : (parsed.rows || []);
  }
}

function resolveSupabaseCli() {
  if (process.env.SUPABASE_CLI) return process.env.SUPABASE_CLI;
  try {
    const out = execFileSync('where.exe', ['supabase'], { encoding: 'utf8' });
    const lines = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => /\.cmd$/i.test(line)) || lines[0] || '';
  } catch {
    return 'supabase';
  }
}

function dbQuery(sql) {
  const cli = resolveSupabaseCli();
  const args = ['db', 'query', '--linked', '--output', 'json'];
  const winCmd = /\s/.test(cli) ? `""${cli}" ${args.join(' ')}"` : `${cli} ${args.join(' ')}`;
  const command = process.platform === 'win32' && /\.cmd$/i.test(cli)
    ? ['cmd.exe', ['/d', '/s', '/c', winCmd]]
    : [cli, args];
  const out = execFileSync(command[0], command[1], {
    encoding: 'utf8',
    input: sql,
    maxBuffer: 20 * 1024 * 1024,
  });
  return parseDbJson(out);
}

function parseImageList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      return trimmed
        .replace(/^\{|\}$/g, '')
        .split(',')
        .map((item) => item.replace(/^"|"$/g, '').trim())
        .filter(Boolean);
    }
  }
  return [];
}

function normalizeImageList(values, baseUrl = '') {
  const seen = new Set();
  const out = [];
  parseImageList(values).forEach((value) => {
    let normalized = String(value || '').trim();
    if (!normalized) return;
    if (normalized.startsWith('//')) normalized = `https:${normalized}`;
    if (/^https?:\/\//i.test(normalized)) {
      // already absolute
    } else if (baseUrl) {
      try {
        normalized = new URL(normalized, baseUrl).toString();
      } catch {
        return;
      }
    } else {
      return;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  });
  return out;
}

function isStaronemallBannerImageUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  let haystack = raw.toLowerCase();
  try {
    const parsed = new URL(raw, 'https://www.staronemall.com');
    haystack = decodeURIComponent(`${parsed.hostname}${parsed.pathname}${parsed.search}`).toLowerCase();
  } catch {
    try { haystack = decodeURIComponent(raw).toLowerCase(); } catch { haystack = raw.toLowerCase(); }
  }
  return [
    /(?:^|[\/_.-])banner(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])bnr(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])event(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])notice(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])guide(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])order(?:[\/_.-]|$)/,
    /(?:^|[\/_.-])process(?:[\/_.-]|$)/,
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
    /a1533f8be6b07bff4669533902948b19/,
  ].some((re) => re.test(haystack));
}

function isLikelyDetailImageUrl(url) {
  const u = String(url || '').toLowerCase();
  if (!u || !/\.(jpe?g|png|webp)(?:\?|$)/i.test(u)) return false;
  if (!(u.includes('wisacdn.com') || u.includes('staronemall.com'))) return false;
  return (
    u.includes('/attach/')
    || u.includes('/editor/')
    || u.includes('/detail')
    || u.includes('/contents/')
    || u.includes('/goods/')
  );
}

function extractImageUrlsFromHtml(html, baseUrl) {
  const urls = [];
  const attrPattern = /\b(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrPattern)) urls.push(match[1]);
  const absolutePattern = /https?:\/\/[^"'<>\\\s]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'<>\\\s]*)?/gi;
  for (const match of html.matchAll(absolutePattern)) urls.push(match[0]);
  return normalizeImageList(urls, baseUrl);
}

async function fetchDirectStaronemallImages(sourceUrl) {
  if (!sourceUrl) return { ok: false, skipped_reason: 'source URL is empty' };
  try {
    const resp = await fetch(sourceUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
        Referer: 'https://www.staronemall.com',
      },
    });
    if (!resp.ok) return { ok: false, error: `direct_fetch_http_${resp.status}` };
    const html = await resp.text();
    const images = extractImageUrlsFromHtml(html, sourceUrl);
    const detailImages = images.filter((url) => isLikelyDetailImageUrl(url) && !isStaronemallBannerImageUrl(url));
    return {
      ok: detailImages.length > 0,
      crawl_source: 'direct_staronemall_fetch',
      detail_image_count: detailImages.length,
      observed_values: { detail_image_urls: detailImages },
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), crawl_source: 'direct_staronemall_fetch' };
  }
}

function restUrl(table, params) {
  const qs = params instanceof URLSearchParams ? params.toString() : new URLSearchParams(params).toString();
  return `${SUPABASE_URL}/rest/v1/${table}${qs ? `?${qs}` : ''}`;
}

async function fetchJson(url, init = {}) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw_text: text }; }
  if (!resp.ok) {
    throw new Error(`${init.method || 'GET'} ${url} failed ${resp.status}: ${json?.message || json?.error || text.slice(0, 300)}`);
  }
  return json;
}

async function fetchRowsViaRest() {
  const params = new URLSearchParams({
    select: [
      'id',
      'sku',
      'product_name',
      'option_name',
      'product_group_id',
      'staronemall_url',
      'main_image',
      'extra_images',
      'shopee_option_image_url',
      'variation_tier_index',
      'updated_at',
    ].join(','),
    or: `(product_group_id.eq.${groupId},id.eq.${groupId})`,
    order: 'variation_tier_index.asc.nullslast,option_name.asc.nullslast,sku.asc',
  });
  const headers = serviceHeaders || anonHeaders;
  const rows = await fetchJson(restUrl('products', params), { headers });
  if (!Array.isArray(rows)) throw new Error('REST products query returned a non-array body');
  return rows;
}

function fetchRowsViaCli() {
  return dbQuery(`
    select
      id,
      sku,
      product_name,
      option_name,
      product_group_id,
      staronemall_url,
      main_image,
      extra_images,
      shopee_option_image_url,
      variation_tier_index,
      updated_at
    from public.products
    where product_group_id = ${sqlQuote(groupId)}::uuid
       or id = ${sqlQuote(groupId)}::uuid
    order by variation_tier_index nulls last, option_name nulls last, sku;
  `);
}

async function fetchGroupRows() {
  try {
    const rows = await fetchRowsViaRest();
    if (!rows.length) {
      const cliRows = fetchRowsViaCli();
      if (cliRows.length) return { rows: cliRows, source: 'supabase-cli-fallback (REST returned 0 rows)' };
    }
    return { rows, source: serviceHeaders ? 'rest-service-role' : 'rest-anon' };
  } catch (restError) {
    const rows = fetchRowsViaCli();
    return { rows, source: `supabase-cli-fallback (${restError.message.slice(0, 140)})` };
  }
}

function crawlAuthHeaders() {
  const cronSecret = process.env.STARONE_CRON_SECRET || process.env.CRON_SECRET || '';
  if (cronSecret) {
    return {
      ...anonHeaders,
      Authorization: `Bearer ${cronSecret}`,
      'x-cron-secret': cronSecret,
    };
  }
  const operatorToken = process.env.STARONE_CRAWL_TOKEN || process.env.SUPABASE_ACCESS_TOKEN || '';
  if (operatorToken) {
    return {
      ...anonHeaders,
      Authorization: `Bearer ${operatorToken}`,
    };
  }
  return null;
}

async function crawlStaronemall(sourceUrl) {
  if (!sourceUrl) return { ok: false, skipped_reason: 'source URL is empty' };
  if (noCrawl) return { ok: false, skipped_reason: '--no-crawl was set' };
  const headers = crawlAuthHeaders();
  if (!headers) {
    return { ok: false, skipped_reason: 'STARONE_CRAWL_TOKEN or STARONE_CRON_SECRET not set' };
  }
  try {
    const body = JSON.stringify({ urls: [sourceUrl], write_to_source_records: false });
    const json = await fetchJson(`${SUPABASE_URL}/functions/v1/starone-crawl`, { method: 'POST', headers, body });
    const hit = Array.isArray(json?.results) ? json.results.find((item) => item?.ok) || json.results[0] : null;
    const observed = hit?.observed_values || {};
    const mainImages = normalizeImageList(observed.main_image_urls || [], sourceUrl);
    const detailImages = normalizeImageList(observed.detail_image_urls || [], sourceUrl);
    return {
      ok: Boolean(hit?.ok && (mainImages.length || detailImages.length)),
      detail_image_count: detailImages.length,
      main_image_count: mainImages.length,
      observed_values: { ...observed, main_image_urls: mainImages, detail_image_urls: detailImages },
      raw_ok: hit?.ok ?? null,
      raw_error: hit?.error || null,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function patchRowsViaRest(rows, detailImages) {
  if (!serviceHeaders) throw new Error('REST apply requires SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_KEY');
  const updated = [];
  for (const row of rows) {
    const url = restUrl('products', new URLSearchParams({ id: `eq.${row.id}` }));
    const body = JSON.stringify({ extra_images: detailImages, updated_at: new Date().toISOString() });
    const patched = await fetchJson(url, {
      method: 'PATCH',
      headers: { ...serviceHeaders, Prefer: 'return=representation' },
      body,
    });
    updated.push(...(Array.isArray(patched) ? patched : []));
  }
  return updated;
}

function patchRowsViaCli(rows, detailImages) {
  const ids = rows.map((row) => `${sqlQuote(row.id)}::uuid`).join(',');
  const images = detailImages.map(sqlQuote).join(',');
  if (!ids || !images) return [];
  return dbQuery(`
    update public.products
       set extra_images = array[${images}]::text[],
           updated_at = now()
     where id = any(array[${ids}]::uuid[])
     returning id, sku, array_length(extra_images, 1) as extra_image_count;
  `);
}

async function applyBackfill(rows, detailImages) {
  try {
    return { source: serviceHeaders ? 'rest-service-role' : 'supabase-cli', rows: await patchRowsViaRest(rows, detailImages) };
  } catch (restError) {
    return { source: `supabase-cli-fallback (${restError.message.slice(0, 140)})`, rows: patchRowsViaCli(rows, detailImages) };
  }
}

function summarizeRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    sku: row.sku,
    option_name: row.option_name,
    current_extra_image_count: normalizeImageList(row.extra_images || []).length,
    has_option_image: Boolean(String(row.shopee_option_image_url || '').trim()),
  }));
}

async function main() {
  const { rows, source } = await fetchGroupRows();
  const firstRow = rows[0] || {};
  const sourceUrl = String(firstRow.staronemall_url || rows.find((row) => row.staronemall_url)?.staronemall_url || '').trim();
  let crawl = await crawlStaronemall(sourceUrl);
  let detailImages = normalizeImageList(crawl.observed_values?.detail_image_urls || [], sourceUrl);
  if (!detailImages.length && (crawl.skipped_reason || crawl.error || crawl.ok === false)) {
    const direct = await fetchDirectStaronemallImages(sourceUrl);
    const directDetails = normalizeImageList(direct.observed_values?.detail_image_urls || [], sourceUrl);
    if (directDetails.length) {
      crawl = {
        ...crawl,
        fallback_reason: crawl.skipped_reason || crawl.error || 'no detail images from authenticated crawl',
        direct_staronemall_fetch: direct,
        ok: true,
        crawl_source: direct.crawl_source,
        observed_values: {
          ...(crawl.observed_values || {}),
          detail_image_urls: directDetails,
        },
      };
      detailImages = directDetails;
    } else {
      crawl = { ...crawl, direct_staronemall_fetch: direct };
    }
  }
  const missingRows = rows.filter((row) => normalizeImageList(row.extra_images || []).length === 0);

  const summary = {
    ok: true,
    dry_run: !apply,
    group_id: groupId,
    product_name: firstRow.product_name || '',
    source_url: sourceUrl,
    row_source: source,
    row_count: rows.length,
    rows: summarizeRows(rows),
    crawl: {
      ok: crawl.ok,
      skipped_reason: crawl.skipped_reason || undefined,
      error: crawl.error || undefined,
      raw_error: crawl.raw_error || undefined,
      fallback_reason: crawl.fallback_reason || undefined,
      crawl_source: crawl.crawl_source || undefined,
      direct_staronemall_fetch: crawl.direct_staronemall_fetch ? {
        ok: crawl.direct_staronemall_fetch.ok,
        error: crawl.direct_staronemall_fetch.error || undefined,
        skipped_reason: crawl.direct_staronemall_fetch.skipped_reason || undefined,
        detail_image_count: crawl.direct_staronemall_fetch.detail_image_count || 0,
      } : undefined,
      main_image_count: crawl.main_image_count || 0,
      detail_image_count: detailImages.length,
    },
    would_update_count: missingRows.length,
    would_update_skus: missingRows.map((row) => row.sku),
    apply_requested: apply,
    applied: false,
    updated_rows: [],
  };

  if (apply) {
    if (!detailImages.length) {
      summary.ok = false;
      summary.apply_blocked_reason = 'No crawled detail images were available to apply.';
      console.log(JSON.stringify(summary, null, 2));
      process.exit(1);
    }
    const applied = await applyBackfill(missingRows, detailImages);
    summary.applied = true;
    summary.apply_source = applied.source;
    summary.updated_rows = applied.rows;
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exit(1);
});
