import assert from 'node:assert/strict';
import fs from 'node:fs';

const v2 = fs.readFileSync(new URL('../v2/index.html', import.meta.url), 'utf8');

function sliceBetween(source, start, end) {
  const s = source.indexOf(start);
  assert.ok(s >= 0, `missing start token: ${start}`);
  const e = source.indexOf(end, s);
  assert.ok(e > s, `missing end token after ${start}`);
  return source.slice(s, e);
}

const priceSync = sliceBetween(
  v2,
  'renderCatalogView() — main entry point, called on tab click.',
  'initDailyCloseListeners();',
);
const payloadBuilder = sliceBetween(
  priceSync,
  'function catBuildPriceSyncPayloads()',
  'function catBuildDryRunPayloads()',
);
const preflight = sliceBetween(
  priceSync,
  'async function catPreflightShopeePayloads(payloads)',
  'function catApplyShopeeListingCache(payload, nowIso)',
);
const liveSync = sliceBetween(
  priceSync,
  'async function catExecuteShopeeLive()',
  'async function catExecuteJoomSync()',
);

assert.match(payloadBuilder, /listing:\s*listing/, 'Shopee bulk price payloads must carry listing metadata for safe preflight trust decisions');
assert.match(preflight, /PREFLIGHT_PARALLELISM\s*=\s*5/, 'Shopee bulk price preflight must limit parallel Shopee model lookups to 5');
assert.match(preflight, /needsFetch\.slice\(i,\s*i \+ PREFLIGHT_PARALLELISM\)/, 'Shopee preflight must process model lookup chunks');
assert.match(preflight, /Promise\.all\(chunk\.map\(async/, 'Shopee preflight must fetch model indexes concurrently within each chunk');
assert.match(preflight, /PREFLIGHT_TRUST_TTL_MS\s*=\s*6 \* 60 \* 60 \* 1000/, 'Shopee preflight must only trust fresh mapped listings');
assert.match(preflight, /listing\.last_synced_at \|\| listing\.published_at/, 'Shopee preflight must use last sync/published freshness for mapped listing trust');
assert.match(preflight, /status !== 'mapped'/, 'Shopee preflight must only skip API validation for mapped listings');
assert.match(preflight, /mixedKeys/, 'Shopee preflight must fetch when any target for an item is untrusted');
assert.match(preflight, /_trusted:\s*true/, 'Shopee preflight must mark synthetic cache entries for trusted mappings');
assert.match(liveSync, /catBridgePriceOk\(json\)/, 'Shopee live bulk sync must treat bridge failure_list as an update failure');
assert.match(liveSync, /catInsertShopeePriceLog\(p, ok \? 'ok' : 'error'/, 'Shopee live bulk sync must audit both successful and failed update_price calls');

console.log('v2 Shopee bulk price stability checks passed');
