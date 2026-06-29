import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const SUPABASE_URL = html.match(/const SUPABASE_URL = '([^']+)'/)?.[1];
const SUPABASE_ANON = html.match(/const SUPABASE_ANON = '([^']+)'/)?.[1];
if (!SUPABASE_URL || !SUPABASE_ANON) throw new Error('Could not read Supabase env from v2/index.html');
const INTERNAL = process.env.PLATFORM_BRIDGE_INTERNAL_TOKEN || '';
if (!INTERNAL) throw new Error('PLATFORM_BRIDGE_INTERNAL_TOKEN is required');

const headers = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  'Content-Type': 'application/json',
};
const bridgeHeaders = { ...headers, 'x-platform-bridge-token': INTERNAL };

async function fetchJson(url, init = {}) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw_text: text }; }
  if (!resp.ok || json?.ok === false) {
    throw new Error(`${url} HTTP ${resp.status}: ${json?.error || json?.message || text.slice(0, 200)}`);
  }
  return json;
}

async function timed(label, fn) {
  const start = performance.now();
  const value = await fn();
  return { label, ms: performance.now() - start, value };
}

function stat(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    min_ms: Math.round(sorted[0]),
    avg_ms: Math.round(avg),
    max_ms: Math.round(sorted[sorted.length - 1]),
  };
}

function qs(params) {
  return new URLSearchParams(params).toString();
}

async function pickProduct() {
  const target = JSON.parse(readFileSync(join(root, 'scripts', 'platform-test-target.json'), 'utf8'));
  const fallback = {
    id: target.product_id,
    sku: target.sku,
    product_name: target.title,
    option_name: 'CD Digipack',
    lifecycle_state: 'ready_stock',
    cost_krw: 16000,
    weight_g: 150,
    inventory: 3,
    main_image: 'https://staronemall2.wisacdn.com/_data/product/c24/m9980/5f89fa5684d4141047298b2acfe4aac6.png',
    extra_images: ['https://staronemall2.wisacdn.com/_data/attach/c24/m19/dae3838cec72eb5fa6ebcb933edc951a.jpg'],
    description: 'API registration smoke-test product for starphotocard.',
    joom_category_id: 'music_albums',
    shopee_brand_name: 'JENNIE',
    product_group_id: target.product_id,
    staronemall_url: '',
    _source: 'scripts/platform-test-target.json fallback',
  };
  const select = 'id,sku,product_name,option_name,lifecycle_state,cost_krw,weight_g,inventory,main_image,extra_images,description,joom_category_id,shopee_brand_name,product_group_id,staronemall_url';
  const queries = [
    `select=${select}&id=eq.${encodeURIComponent(target.product_id)}&limit=1`,
    `select=${select}&sku=eq.${encodeURIComponent(target.sku)}&limit=1`,
  ];
  for (const query of queries) {
    const rows = await fetchJson(`${SUPABASE_URL}/rest/v1/products?${query}`, { headers });
    if (Array.isArray(rows) && rows.length) return { ...fallback, ...rows[0], _source: 'supabase products' };
  }
  return fallback;
}

function buildGroup(product) {
  return {
    source_record_id: product.product_group_id || product.id,
    rows: [{
      ...product,
      status: 'ready',
      _sku: product.sku,
      _opt0: product.option_name || 'ONE SIZE',
      _cost_krw: Number(product.cost_krw || 0),
      _weight_g: Number(product.weight_g || 0),
      _main_image: product.main_image || '',
      _extra_images: Array.isArray(product.extra_images) ? product.extra_images : [],
      _joomCategory: product.joom_category_id || 'music_albums',
      _joomBrand: product.shopee_brand_name || '',
      observed: {
        title: product.product_name || '',
        main_image_urls: product.main_image ? [product.main_image] : [],
        detail_image_urls: Array.isArray(product.extra_images) ? product.extra_images : [],
      },
    }],
  };
}

function hasImageCoverage(group) {
  const row = group.rows[0] || {};
  return !!(row._main_image || row.main_image) && Array.isArray(row._extra_images) && row._extra_images.length > 0;
}

async function ensureSourceImages(group) {
  // Mirrors the modal's fast path for a master that already has representative/detail images.
  // If images are missing and a StarOneMall URL exists, use the same live starone-crawl endpoint.
  if (hasImageCoverage(group)) return { skipped: true, reason: 'stored master images already present' };
  const row = group.rows[0] || {};
  const sourceUrl = row.staronemall_url || '';
  if (!sourceUrl) return { skipped: true, reason: 'no source URL' };
  return fetchJson(`${SUPABASE_URL}/functions/v1/starone-crawl`, {
    method: 'POST',
    headers: bridgeHeaders,
    body: JSON.stringify({ urls: [sourceUrl], write_to_source_records: false }),
  });
}

async function loadBrandOptions() {
  return fetchJson(`${SUPABASE_URL}/functions/v1/joom-bridge/brand-options?limit=500`, { headers: bridgeHeaders });
}

async function loadJoomCountry() {
  const query = qs({ select: '*', country_code: 'eq.JM', limit: '1' });
  const rows = await fetchJson(`${SUPABASE_URL}/rest/v1/country_settings?${query}`, { headers });
  return Array.isArray(rows) ? rows[0] : rows;
}

function buildDryRunPayload(product) {
  const sku = String(product.sku || '').trim();
  const mainImage = String(product.main_image || '').trim();
  const detailImages = Array.isArray(product.extra_images) ? product.extra_images.filter(Boolean).slice(0, 3) : [];
  return {
    row: {
      sku,
      cost: Number(product.cost_krw || 16000),
      weight: Number(product.weight_g || 150),
    },
    source_product_id: product.id,
    scrapedAssets: {
      mainImage,
      name: product.product_name || sku,
      detailImages,
      extraImages: [],
    },
    variantsConfig: [{
      name: product.option_name || 'ONE SIZE',
      sku,
      inventory: Math.max(1, Number(product.inventory || 1)),
      enabled: true,
      weight: Number(product.weight_g || 150),
      image: mainImage,
      product_id: product.id,
    }],
    categoryId: product.joom_category_id || 'music_albums',
    enabled: true,
    namePrefix: '',
    artist: product.shopee_brand_name || '',
    album: '',
    contents: product.description || 'API registration smoke-test product for starphotocard.',
    brand: product.shopee_brand_name || 'JENNIE',
  };
}

async function oldModalOpen(group) {
  const a = await ensureSourceImages(group);
  const b = await loadBrandOptions();
  const c = await loadJoomCountry();
  return { source: a, brand_count: b.brands?.length || 0, country: c?.country_code || 'JM' };
}

async function newModalOpen(group) {
  const [a, b, c] = await Promise.all([
    ensureSourceImages(group),
    loadBrandOptions(),
    loadJoomCountry(),
  ]);
  return { source: a, brand_count: b.brands?.length || 0, country: c?.country_code || 'JM' };
}

async function dryRun(product) {
  return fetchJson(`${SUPABASE_URL}/functions/v1/joom-bridge/dryrun`, {
    method: 'POST',
    headers: bridgeHeaders,
    body: JSON.stringify(buildDryRunPayload(product)),
  });
}

function uniqueLiveSku(product) {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 14);
  const base = String(product.sku || 'SDV2-JOOM').toUpperCase().replace(/[^A-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 42) || 'SDV2-JOOM';
  return `${base}-JOOM${stamp}`.slice(0, 64);
}

async function publishLive(product, mode = 'fast') {
  const sku = uniqueLiveSku(product);
  const body = buildDryRunPayload({ ...product, sku });
  body.fast = mode !== 'verified';
  body.verify = mode === 'verified';
  const result = await fetchJson(`${SUPABASE_URL}/functions/v1/joom-bridge/publish`, {
    method: 'POST',
    headers: bridgeHeaders,
    body: JSON.stringify(body),
  });
  return { sku, result };
}

async function deleteLive(productId, sku) {
  return fetchJson(`${SUPABASE_URL}/functions/v1/joom-bridge/delete`, {
    method: 'POST',
    headers: bridgeHeaders,
    body: JSON.stringify({ productId, dry_run: false, confirm: 'DELETE_JOOM_PRODUCT', product_ids: [] }),
  }).catch((error) => ({ ok: false, error: error.message || String(error), sku }));
}

async function lookupById(productId) {
  return fetchJson(`${SUPABASE_URL}/functions/v1/joom-bridge/lookup-sku?id=${encodeURIComponent(productId)}`, {
    headers: bridgeHeaders,
  });
}

async function main() {
  const product = await pickProduct();
  const group = buildGroup(product);
  const iterations = Number(process.argv.find(arg => arg.startsWith('--runs='))?.split('=')[1] || 5);
  const liveArg = process.argv.find(arg => arg === '--live-cycle' || arg.startsWith('--live-cycle='));
  const liveCycle = !!liveArg;
  const liveCycleMode = liveArg?.includes('=') ? liveArg.split('=')[1] : 'fast';

  const oldTimes = [];
  const newTimes = [];
  const dryTimes = [];
  let lastOld;
  let lastNew;
  let lastDry;
  let liveResult = null;

  // Warm up DNS/TLS once, then measure alternating old/new to reduce network-order bias.
  await Promise.all([loadBrandOptions(), loadJoomCountry()]);

  for (let i = 0; i < iterations; i += 1) {
    const oldRun = await timed('old_sequential_modal_open', () => oldModalOpen(group));
    oldTimes.push(oldRun.ms);
    lastOld = oldRun.value;

    const newRun = await timed('new_parallel_modal_open', () => newModalOpen(group));
    newTimes.push(newRun.ms);
    lastNew = newRun.value;
  }

  // One actual dry-run against Joom bridge with the same master product payload, repeated lightly.
  for (let i = 0; i < Math.min(3, iterations); i += 1) {
    const dry = await timed('joom_bridge_dryrun', () => dryRun(product));
    dryTimes.push(dry.ms);
    lastDry = dry.value;
  }

  const oldStats = stat(oldTimes);
  const newStats = stat(newTimes);
  const savedAvg = oldStats.avg_ms - newStats.avg_ms;
  const savedPct = oldStats.avg_ms ? Math.round((savedAvg / oldStats.avg_ms) * 1000) / 10 : 0;

  if (liveCycle) {
    const publish = await timed(`live_${liveCycleMode}_register`, () => publishLive(product, liveCycleMode));
    const productId = publish.value?.result?.joom_product_id;
    const remove = productId
      ? await timed('live_delete', () => deleteLive(productId, publish.value.sku))
      : { ms: 0, value: { skipped: true, reason: 'publish returned no product id' } };
    const lookup = productId
      ? await timed('post_delete_lookup', () => lookupById(productId))
      : { ms: 0, value: { skipped: true, reason: 'publish returned no product id' } };
    liveResult = {
      sku: publish.value?.sku || null,
      joom_product_id: productId || null,
      live_register_ms: Math.round(publish.ms),
      live_delete_ms: Math.round(remove.ms),
      post_delete_lookup_ms: Math.round(lookup.ms),
      live_total_ms: Math.round(publish.ms + remove.ms + lookup.ms),
      register_ok: publish.value?.result?.ok === true,
      delete_ok: remove.value?.ok === true,
      cleanup_state: lookup.value?.listing_status || lookup.value?.state || null,
      mode: liveCycleMode,
      mapping_persist_mode: publish.value?.result?.mapping_persist_mode || null,
      mapping_hydration_skipped: publish.value?.result?.mapping_hydration_skipped ?? null,
      register_timing: publish.value?.result?.timing || null,
      delete_result: remove.value,
      lookup_result: lookup.value,
    };
  }

  console.log(JSON.stringify({
    ok: true,
    product: {
      id: product.id,
      sku: product.sku,
      product_name: product.product_name,
      source: product._source || 'unknown',
      has_main_image: !!product.main_image,
      extra_image_count: Array.isArray(product.extra_images) ? product.extra_images.length : 0,
      joom_category_id: product.joom_category_id || 'music_albums',
      brand: product.shopee_brand_name || null,
    },
    runs: iterations,
    old_sequential_modal_open_ms: oldStats,
    new_parallel_modal_open_ms: newStats,
    avg_saved_ms: savedAvg,
    avg_saved_pct: savedPct,
    joom_bridge_dryrun_ms: stat(dryTimes),
    live_publish_performed: liveCycle,
    live_cycle: liveResult,
    live_cycle_mode: liveCycle ? liveCycleMode : null,
    live_publish_note: liveCycle ? `Created one live Joom listing in ${liveCycleMode} mode, deleted it, then verified post-delete state.` : 'Measured live modal dependencies and Joom dry-run only; no marketplace listing was created.',
    sample_results: {
      old: lastOld,
      new: lastNew,
      dryrun_ok: lastDry?.ok === true,
      dryrun_variant_count: lastDry?.payload?.variants?.length || lastDry?.variants?.length || null,
      dryrun_timing: lastDry?.timing || null,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
