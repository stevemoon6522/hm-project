import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert(start >= 0, `missing function ${name}`);
  const paramsEnd = source.indexOf(')', start);
  const open = source.indexOf('{', paramsEnd);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

const grouping = read('supabase', 'functions', 'platform-publish', '_shared', 'grouping.ts');
const shopeeAdapter = read('supabase', 'functions', 'platform-publish', 'adapters', 'shopee.ts');
const ebayAdapter = read('supabase', 'functions', 'platform-publish', 'adapters', 'ebay.ts');
const shopeeBridge = read('supabase', 'functions', 'shopee-bridge', 'index.ts');
const ebayBridge = read('supabase', 'functions', 'ebay-bridge', 'index.ts');
const staroneCrawl = read('supabase', 'functions', 'starone-crawl', 'index.ts');

const publishableGroupRows = extractFunction(grouping, 'publishableGroupRows');
assert.match(grouping, /function rowIsSetOption/, 'grouping must explicitly preserve SET option rows');
assert.match(
  publishableGroupRows,
  /rowHasPublishableStock\(row,\s*master\)\s*\|\|\s*rowIsSetOption\(row\)/,
  'ready-stock grouped publish must keep the zero-stock SET option while filtering other zero-stock rows',
);

assert.match(shopeeAdapter, /imagescript@1\.3\.0/, 'Shopee platform-publish must compose the shop layer server-side');
assert.match(shopeeAdapter, /shop-overlay-layer\.png/, 'Shopee platform-publish must use the V2 shop overlay layer asset');
assert.match(shopeeAdapter, /platform-publish-shop-layer-v1/, 'Shopee image uploads must audit the layered-cover version');
assert.doesNotMatch(
  shopeeAdapter,
  /layer_version:\s*'platform-publish-main-image-v1'/,
  'Shopee platform-publish must not upload the raw main image as the representative cover',
);

const buildGlobalModels = extractFunction(shopeeBridge, 'buildGlobalModels');
assert.match(
  buildGlobalModels,
  /m\?\.seller_stock\?\.\[0\]\?\.stock\s*\?\?/,
  'Shopee bridge must read model seller_stock before fallback stock',
);
assert.match(
  buildGlobalModels,
  /const stock = Number\(m\?\.seller_stock\?\.\[0\]\?\.stock\s*\?\?\s*m\?\.stock\s*\?\?\s*fallbackStock/,
  'Shopee bridge must not let fallback parent stock override per-model seller_stock',
);

const ebayPriceUsd = extractFunction(ebayAdapter, 'ebayPriceUsd');
assert((ebayPriceUsd.match(/const feeRate/g) || []).length <= 1, 'eBay adapter must not duplicate feeRate declaration');
assert.match(ebayAdapter, /EBAY_US_DIRECT_SHIPPING_RATES_KRW/, 'eBay adapter must carry the US direct shipping rate card');
assert.match(ebayAdapter, /ebayGetUsShippingRateKrw\(weightG\)/, 'eBay adapter price must include weight-based US shipping');
assert.match(ebayAdapter, /shippingSurchargePolicy:\s*'delta_vs_us_baseline'/, 'eBay variation payload must preserve shipping surcharge audit policy');
assert.match(ebayAdapter, /weightBucketG|usShippingKrw|shippingSurchargesUsd/, 'eBay payload must expose shipping pricing audit fields');

const publishVariationCore = extractFunction(ebayBridge, 'handlePublishVariationCore');
assert.doesNotMatch(publishVariationCore, /quantity\s*<=\s*0\)\s*throw/, 'eBay variation bridge must allow quantity 0 for out-of-stock variants');
assert.match(
  ebayBridge,
  /set that variation's quantity to 0/i,
  'eBay bridge must retain a local-doc citation for quantity-0 out-of-stock variations',
);

assert.match(staroneCrawl, /koreanRatio/, 'StarOneMall crawler must inspect Korean text ratio before accepting UTF-8');
assert.match(staroneCrawl, /mojibakeRatio/, 'StarOneMall crawler must inspect mojibake patterns before accepting UTF-8');
assert.match(staroneCrawl, /TextDecoder\("euc-kr"\)/, 'StarOneMall crawler must retry EUC-KR decoding');

console.log('TXT 7th Year platform publish regression checks passed');
