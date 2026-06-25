#!/usr/bin/env node
/**
 * Repair products.main_image for a grouped master product without touching
 * per-option images.
 *
 * Usage:
 *   node scripts/repair-master-representative-images.mjs --sku=O1-ATE-4GOLD-PHO-A
 *   node scripts/repair-master-representative-images.mjs --sku=O1-ATE-4GOLD-PHO-A --main-image-url=https://... --apply
 *
 * Optional StarOneMall crawl:
 *   STARONE_CRON_SECRET=... node scripts/repair-master-representative-images.mjs --sku=... --apply
 *
 * Required env:
 *   SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_KEY
 *
 * Optional env:
 *   SUPABASE_URL            defaults to the Shopee Dashboard V2 Supabase project
 *   STARONE_CRON_SECRET     calls starone-crawl with x-cron-secret
 *   CRON_SECRET             fallback cron secret name
 *   STARONE_CRAWL_TOKEN     signed-in operator access token for starone-crawl
 *   SUPABASE_ACCESS_TOKEN   fallback signed-in operator access token
 */

const DEFAULT_SUPABASE_URL = 'https://mgqlwgnmwegzsjelbrih.supabase.co';

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--') && !arg.includes('=')));
const options = Object.fromEntries(
  args
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => {
      const eq = arg.indexOf('=');
      return [arg.slice(2, eq), arg.slice(eq + 1)];
    }),
);

const SUPABASE_URL = stripTrailingSlash(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL);
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const SKU = String(options.sku || '').trim();
const APPLY = flags.has('--apply');
const NO_CRAWL = flags.has('--no-crawl');
const BACKFILL_OPTION_IMAGE = flags.has('--backfill-option-image');
const DIRECT_MAIN_IMAGE_URL = String(options['main-image-url'] || '').trim();

if (!SKU) die('ERROR: --sku is required.');
if (!SERVICE_KEY) die('ERROR: SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_KEY is required.');

const dbHeaders = {
  Authorization: `Bearer ${SERVICE_KEY}`,
  apikey: SERVICE_KEY,
};
const writeHeaders = {
  ...dbHeaders,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function die(message) {
  console.error(message);
  process.exit(1);
}

function shortUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '(empty)';
  if (url.length <= 86) return url;
  return `${url.slice(0, 52)}...${url.slice(-30)}`;
}

function unique(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function restUrl(table, params) {
  const qs = params instanceof URLSearchParams ? params.toString() : new URLSearchParams(params).toString();
  return `${SUPABASE_URL}/rest/v1/${table}${qs ? `?${qs}` : ''}`;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  if (!response.ok) {
    const body = typeof json === 'string' ? json : JSON.stringify(json);
    throw new Error(`${init.method || 'GET'} ${url} failed ${response.status}: ${body}`);
  }
  return json;
}

async function fetchProductBySku(sku) {
  const params = new URLSearchParams({
    select: PRODUCT_SELECT,
    sku: `eq.${sku}`,
    limit: '2',
  });
  const rows = await fetchJson(restUrl('products', params), { headers: dbHeaders });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (rows.length > 1) {
    console.warn(`WARN: SKU ${sku} returned ${rows.length} rows; using the first row.`);
  }
  return rows[0];
}

async function fetchGroupRows(target) {
  const groupId = String(target?.product_group_id || '').trim();
  if (!groupId) return [target];
  const params = new URLSearchParams({
    select: PRODUCT_SELECT,
    product_group_id: `eq.${groupId}`,
    order: 'variation_tier_index.asc.nullslast,option_name.asc,sku.asc',
  });
  const rows = await fetchJson(restUrl('products', params), { headers: dbHeaders });
  return Array.isArray(rows) && rows.length ? rows : [target];
}

function crawlAuthHeaders() {
  const cronSecret = process.env.STARONE_CRON_SECRET || process.env.CRON_SECRET || '';
  if (cronSecret) {
    return {
      Authorization: `Bearer ${cronSecret}`,
      apikey: SERVICE_KEY,
      'Content-Type': 'application/json',
      'x-cron-secret': cronSecret,
    };
  }
  const operatorToken = process.env.STARONE_CRAWL_TOKEN || process.env.SUPABASE_ACCESS_TOKEN || '';
  if (operatorToken) {
    return {
      Authorization: `Bearer ${operatorToken}`,
      apikey: SERVICE_KEY,
      'Content-Type': 'application/json',
    };
  }
  return null;
}

async function crawlStaronemall(url) {
  const headers = crawlAuthHeaders();
  if (!headers || NO_CRAWL || !url) return null;
  const body = JSON.stringify({ urls: [url], write_to_source_records: false });
  const json = await fetchJson(`${SUPABASE_URL}/functions/v1/starone-crawl`, {
    method: 'POST',
    headers,
    body,
  });
  const result = Array.isArray(json?.results) ? json.results.find((item) => item?.ok) : null;
  if (!result) {
    throw new Error(`starone-crawl returned no ok result: ${JSON.stringify(json?.summary || json)}`);
  }
  return result.observed_values || {};
}

async function patchProduct(id, payload) {
  return fetchJson(restUrl('products', new URLSearchParams({ id: `eq.${id}` })), {
    method: 'PATCH',
    headers: writeHeaders,
    body: JSON.stringify(payload),
  });
}

function buildPlans(rows, mainImageUrl, detailImages) {
  const now = new Date().toISOString();
  return rows.map((row) => {
    const oldMain = String(row.main_image || '').trim();
    const oldOption = String(row.shopee_option_image_url || '').trim();
    const payload = {
      main_image: mainImageUrl || null,
      updated_at: now,
    };
    const shouldBackfillOption = BACKFILL_OPTION_IMAGE && !oldOption && oldMain && oldMain !== mainImageUrl;
    if (shouldBackfillOption) payload.shopee_option_image_url = oldMain;
    if (detailImages.length && parseJsonArray(row.extra_images).length === 0) {
      payload.extra_images = detailImages;
    }
    return { row, payload, shouldBackfillOption };
  });
}

function printGroupSummary(rows) {
  console.log(`Rows: ${rows.length}`);
  console.log(`Product group: ${rows[0]?.product_group_id || '(none)'}`);
  console.log(`Distinct products.main_image: ${unique(rows.map((row) => row.main_image)).length}`);
  unique(rows.map((row) => row.main_image)).forEach((url, index) => {
    console.log(`  main[${index + 1}] ${shortUrl(url)}`);
  });
  console.log(`Distinct products.shopee_option_image_url: ${unique(rows.map((row) => row.shopee_option_image_url)).length}`);
  unique(rows.map((row) => row.shopee_option_image_url)).forEach((url, index) => {
    console.log(`  option[${index + 1}] ${shortUrl(url)}`);
  });
}

const PRODUCT_SELECT = [
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
].join(',');

async function main() {
  console.log(`mode=${APPLY ? 'APPLY' : 'dry-run'} sku=${SKU} supabase=${SUPABASE_URL}`);
  const target = await fetchProductBySku(SKU);
  if (!target) die(`ERROR: SKU not found: ${SKU}`);
  const rows = await fetchGroupRows(target);
  printGroupSummary(rows);

  const staronemallUrl = String(target.staronemall_url || rows.find((row) => row.staronemall_url)?.staronemall_url || '').trim();
  let observed = null;
  if (!DIRECT_MAIN_IMAGE_URL && staronemallUrl && !NO_CRAWL) {
    const canCrawl = Boolean(crawlAuthHeaders());
    console.log(`StarOneMall URL: ${staronemallUrl}`);
    console.log(`StarOneMall crawl: ${canCrawl ? 'enabled' : 'skipped (no STARONE_CRON_SECRET/STARONE_CRAWL_TOKEN)'}`);
    if (canCrawl) observed = await crawlStaronemall(staronemallUrl);
  }

  const crawlMain = Array.isArray(observed?.main_image_urls) ? String(observed.main_image_urls[0] || '').trim() : '';
  const mainImageUrl = DIRECT_MAIN_IMAGE_URL || crawlMain;
  const detailImages = Array.isArray(observed?.detail_image_urls) ? observed.detail_image_urls.map(String).filter(Boolean) : [];

  if (!mainImageUrl) {
    console.log('\nNo representative image URL was resolved.');
    console.log('Run again with --main-image-url=https://... or set STARONE_CRON_SECRET/STARONE_CRAWL_TOKEN.');
    process.exit(APPLY ? 1 : 0);
  }

  console.log(`\nRepresentative image source: ${DIRECT_MAIN_IMAGE_URL ? '--main-image-url' : 'starone-crawl'}`);
  console.log(`Representative image: ${shortUrl(mainImageUrl)}`);
  if (detailImages.length) console.log(`Detail images from crawl: ${detailImages.length}`);

  const plans = buildPlans(rows, mainImageUrl, detailImages);
  console.log(`\n${APPLY ? 'Applying' : 'Planned'} row updates:`);
  for (const plan of plans) {
    const row = plan.row;
    const action = [
      `${row.sku}`,
      row.option_name ? `(${row.option_name})` : '',
      `main: ${shortUrl(row.main_image)} -> ${shortUrl(mainImageUrl)}`,
      plan.shouldBackfillOption ? `option backfill: ${shortUrl(row.main_image)}` : 'option: preserved',
      plan.payload.extra_images ? `extra_images: +${plan.payload.extra_images.length}` : '',
    ].filter(Boolean).join(' ');
    console.log(`  ${APPLY ? '~' : 'DRY'} ${action}`);
  }

  if (!APPLY) {
    console.log('\nDry-run only. Add --apply to write these updates.');
    return;
  }

  for (const plan of plans) {
    await patchProduct(plan.row.id, plan.payload);
  }
  console.log(`\nDone. updated=${plans.length}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
