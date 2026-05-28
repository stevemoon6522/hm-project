import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_COUNTRY_SETTINGS,
  PRICE_SYNC_REGIONS,
  calculateJoomPrice,
  calculateShopeePrice,
  calculateV1Listing,
  getShippingFee,
  normalizeShopeeOriginalPrice,
} from '../v2/price-engine.js';

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNear(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

assert(
  JSON.stringify(PRICE_SYNC_REGIONS) === JSON.stringify(['SG', 'TW', 'TH', 'MY', 'PH', 'BR']),
  'Shopee operating regions must match V1 order, including BR',
);

assertNear(getShippingFee('SG', 100), 0.8, 0.000001, 'SG shipping fee must match V1');
assertNear(getShippingFee('BR', 100), 11.2, 0.000001, 'BR shipping fee must match V1');
assertNear(getShippingFee('TH', 450), 99, 0.000001, 'TH shipping fee must match V1');

const br = calculateV1Listing({
  costKrw: 10000,
  weightG: 100,
  region: 'BR',
  countrySettings: DEFAULT_COUNTRY_SETTINGS.BR,
});
assertNear(br.listing, 62.90026263145232, 0.000000001, 'BR raw listing must match V1 formula');
assertNear(br.sales, 62.90026263145232, 0.000000001, 'BR sales price must match V1 formula');

const th = calculateShopeePrice({
  costKrw: 25000,
  weightG: 450,
  region: 'TH',
  countrySettings: DEFAULT_COUNTRY_SETTINGS.TH,
});
assertNear(th.originalPrice, 1040, 0.000001, 'TH Shopee price must round to integer');

const brShopee = calculateShopeePrice({
  costKrw: 10350,
  weightG: 80,
  region: 'BR',
  countrySettings: DEFAULT_COUNTRY_SETTINGS.BR,
});
assertNear(brShopee.originalPrice, 61.33, 0.000001, 'BR Shopee price must keep 2 decimals');

const brNorm = normalizeShopeeOriginalPrice('BR', 57.514);
assert(brNorm.ok && brNorm.value === 57.51 && brNorm.decimals === 2, 'BR normalization must use 2 decimals');
const twNorm = normalizeShopeeOriginalPrice('TW', 459.4);
assert(twNorm.ok && twNorm.value === 459 && twNorm.decimals === 0, 'TW normalization must use integer prices');

const joom = calculateJoomPrice({
  costKrw: 10000,
  weightG: 100,
  countrySettings: DEFAULT_COUNTRY_SETTINGS.SG,
});
assertNear(joom.joomPrice, 13.75, 0.000001, 'Joom price must follow V1 SG listing proxy');

const v2 = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
assert(v2.includes("from './price-engine.js'"), 'V2 must import the shared V1 parity price engine');
assert(v2.includes("bridgeUrl: SHOPEE_BRIDGE + '/update_price'"), 'V2 Shopee sync must use shop-level update_price');
assert(!v2.includes("bridgeUrl: SHOPEE_BRIDGE + '/update_global_price'"), 'V2 price sync must not build global update_price payloads');
assert(v2.includes('shop_model_id,status,published_at,last_synced_price'), 'V2 listings fetch must include shop_model_id for variant price updates');
assert(v2.includes("JOOM_BRIDGE + '/lookup-sku?sku='"), 'V2 Joom sync must resolve SKU before update-price');
assert(v2.includes("JOOM_BRIDGE + '/update-price'"), 'V2 Joom sync must call update-price');
assert(v2.includes('id="cat-platform-tabs"'), 'V2 price sync toolbar must expose platform tabs');
for (const platform of ['shopee', 'joom', 'qoo10', 'alibaba', 'ebay']) {
  assert(v2.includes(`data-cat-platform="${platform}"`), `V2 price sync toolbar must include ${platform} platform tab`);
}
assert(v2.includes("chip.className = 'cat-market-chip active'"), 'Shopee markets must render as compact chips instead of loose checkboxes');

console.log('v2 price sync V1 parity checks passed');
