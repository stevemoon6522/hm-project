import assert from 'node:assert/strict';
import fs from 'node:fs';

const v2 = fs.readFileSync(new URL('../v2/index.html', import.meta.url), 'utf8');
const joomBridge = fs.readFileSync(new URL('../supabase/functions/joom-bridge/index.ts', import.meta.url), 'utf8');
const platformPublish = fs.readFileSync(new URL('../supabase/functions/platform-publish/index.ts', import.meta.url), 'utf8');
const joomAdapter = fs.readFileSync(new URL('../supabase/functions/platform-publish/adapters/joom.ts', import.meta.url), 'utf8');
const ebayBridge = fs.readFileSync(new URL('../supabase/functions/ebay-bridge/index.ts', import.meta.url), 'utf8');

function sgArray(value) { return Array.isArray(value) ? value : []; }
function sgNumberFromAny(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9.\-]/g, '');
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function sgFirstNumberFromPaths(source, paths) {
  for (const path of paths) {
    let cur = source;
    let ok = true;
    for (const part of path.split('.')) {
      if (cur == null) { ok = false; break; }
      cur = cur[part];
    }
    if (!ok) continue;
    const n = sgNumberFromAny(cur);
    if (n != null && n > 0) return n;
  }
  return null;
}
function sgImportedPrice(item, model) {
  const sources = model ? [model, item] : [item];
  const paths = [
    'original_price', 'price', 'price_info.original_price', 'price_info.price',
    'price_info.current_price', 'price_info.normal_price', 'global_price',
    'global_original_price', 'model_price', 'item_price'
  ];
  for (const source of sources) {
    const n = sgFirstNumberFromPaths(source || {}, paths);
    if (n != null) return Math.round(n);
    for (const listKey of ['price_info', 'price_info_list', 'prices']) {
      const arr = sgArray(source?.[listKey]);
      for (const row of arr) {
        const m = sgFirstNumberFromPaths(row || {}, paths);
        if (m != null) return Math.round(m);
      }
    }
  }
  return null;
}
function sgImportedWeightG(item, model) {
  const sources = model ? [model, item] : [item];
  const kgPaths = ['weight', 'package_weight', 'logistics_info.weight', 'dimension.weight'];
  const gPaths = ['weight_g', 'package_weight_g'];
  for (const source of sources) {
    const grams = sgFirstNumberFromPaths(source || {}, gPaths);
    if (grams != null) return Math.round(grams);
    const kg = sgFirstNumberFromPaths(source || {}, kgPaths);
    if (kg != null) return Math.round(kg > 100 ? kg : kg * 1000);
  }
  return null;
}

const cortisFixture = {
  item: { weight: 0.53 },
  model: { weight: '0.53', price_info: { currency: 'KRW', original_price: 19800 } },
};
assert.equal(sgImportedPrice(cortisFixture.item, cortisFixture.model), 19800, 'Shopee model price_info.original_price should become cost_krw');
assert.equal(sgImportedWeightG(cortisFixture.item, cortisFixture.model), 530, 'Shopee kg weight should become weight_g grams');

assert.match(v2, /function coverageCheckPlatformHealth/, 'v2 platform health function exists');
assert.match(v2, /coverageBridgeUrl\(platform\) \+ '\/' \+ action/, 'platform health should call the actual bridge health endpoint');
assert.doesNotMatch(v2, /if \(platform === 'joom' \|\| platform === 'ebay'\) return \{ platform, ok: true/, 'Joom/eBay health must not be hard-coded healthy');
assert.match(v2, /const selectedIds = state\.productListSelectedIds \|\| new Set\(\)/, 'product-list platform SKU sync must inspect selected product IDs');
assert.match(v2, /return skuRows\.filter\(\(p\) => selectedIds\.has\(String\(p\.id\)\)\)/, 'platform SKU sync must sync every selected product row, not just one option SKU');

assert.match(joomBridge, /lookup_error_detail/, 'Joom lookup should expose upstream lookup detail instead of upstream_joom_lookup_failed only');
assert.match(joomBridge, /joom_product_lookup_failed/, 'Joom parent SKU lookup failures should be mapped to not-found/validation detail');
assert.match(joomBridge, /url\.searchParams\.get\("id"\)/, 'Joom lookup-sku must accept stored joom_product_id as an id fallback');
assert.match(joomBridge, /lookupJoomProductBySkuOrId/, 'Joom lookup must retry by stored product id when parent SKU lookup misses');
assert.match(platformPublish, /joom_product_id/, 'platform-publish must select products.joom_product_id for Joom sync fallback');
assert.match(joomAdapter, /id: s\(ctx\.masterProduct\.joom_product_id\)/, 'Joom platform adapter must send stored joom_product_id to lookup-sku');
assert.doesNotMatch(joomBridge, /return jsonResp\(\{ ok: false, error: "upstream_joom_lookup_failed" \}, 502\);/, 'Joom lookup must not collapse every failure to upstream_joom_lookup_failed');

assert.match(ebayBridge, /healthz" && req\.method === "GET"[\s\S]*return await handleHealthz\(\)/, 'eBay healthz route should call health handler');
assert.doesNotMatch(ebayBridge, /if \(action === "healthz" && req\.method === "GET"\) \{\s*const internalDenied = requireInternalBridge/, 'eBay healthz should not require internal bridge token for dashboard health checks');

console.log('platform sync fix tests passed');
