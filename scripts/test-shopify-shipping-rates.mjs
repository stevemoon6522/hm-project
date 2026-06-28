import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const apiRefRoot = 'C:\\dev\\api-refs\\marketplaces\\shopify';

function readApiRef(file) {
  const path = join(apiRefRoot, file);
  assert.equal(existsSync(path), true, `Shopify local API ref missing: ${path}`);
  return readFileSync(path, 'utf8');
}

const createRef = readApiRef('carrier-service-create.graphql.html');
const restRef = readApiRef('carrier-service.rest.html');

assert.match(createRef, /carrierServiceCreate/i, 'local Shopify docs must cover carrierServiceCreate');
assert.match(createRef, /callbackUrl/i, 'carrierServiceCreate docs must include callbackUrl');
assert.match(createRef, /supportsServiceDiscovery/i, 'carrierServiceCreate docs must include supportsServiceDiscovery');
assert.match(restRef, /&quot;rate&quot;|\"rate\"/i, 'CarrierService REST docs must show rate callback payload');
assert.match(restRef, /&quot;grams&quot;|\"grams\"/i, 'CarrierService REST docs must show item grams');
assert.match(restRef, /&quot;rates&quot;|\"rates\"/i, 'CarrierService REST docs must show rates response');
assert.match(restRef, /total_price/i, 'CarrierService REST docs must show total_price response field');

const callbackPath = join(root, 'api', 'shopify-shipping-rates.js');
assert.equal(existsSync(callbackPath), true, 'Shopify shipping rate callback API must exist');

const callbackModule = await import(pathToFileURL(callbackPath).href);
assert.equal(typeof callbackModule.buildShopifyShippingRates, 'function', 'callback API must export buildShopifyShippingRates');
assert.equal(typeof callbackModule.shopifyShippingWeightBucketG, 'function', 'callback API must export shopifyShippingWeightBucketG');
assert.equal(typeof callbackModule.shopifyShippingCentsFromKrw, 'function', 'callback API must export shopifyShippingCentsFromKrw');

assert.equal(callbackModule.shopifyShippingWeightBucketG(1), 100, 'Shopify shipping weights round up to the 100g floor');
assert.equal(callbackModule.shopifyShippingWeightBucketG(201), 300, 'Shopify shipping weights round up to the next 100g bucket');
assert.equal(callbackModule.shopifyShippingWeightBucketG(1001), 0, 'Shopify shipping must not undercharge unsupported >1kg orders');
assert.equal(callbackModule.shopifyShippingCentsFromKrw(7200, 1460), 494, 'Shopify shipping KRW rates convert to USD subunit cents with ceiling');

const requestedRows = [];
const response = await callbackModule.buildShopifyShippingRates({
  rate: {
    destination: { country: 'US' },
    currency: 'USD',
    items: [
      { sku: 'A', quantity: 2, grams: 125, requires_shipping: true },
      { sku: 'B', quantity: 1, grams: 300, requires_shipping: true },
      { sku: 'C', quantity: 1, grams: 999, requires_shipping: false },
    ],
  },
}, {
  krwPerUsd: 1460,
  resolveRate: async ({ countryCode, weightBucketG }) => {
    requestedRows.push({ countryCode, weightBucketG });
    return { country_code: countryCode, country_name: 'United States', weight_g: weightBucketG, standard_krw: 10500 };
  },
});

assert.deepEqual(requestedRows, [{ countryCode: 'US', weightBucketG: 600 }], 'callback must sum grams * quantity and resolve the rounded bucket');
assert.deepEqual(Object.keys(response), ['rates'], 'Shopify callback response must only expose rates at top level');
assert.equal(response.rates.length, 1, 'callback must return one standard rate when a table row exists');
assert.equal(response.rates[0].service_name, 'starphotocard Standard');
assert.equal(response.rates[0].service_code, 'SPC_STANDARD');
assert.equal(response.rates[0].currency, 'USD');
assert.equal(response.rates[0].total_price, '720', '10,500 KRW at 1,460 KRW/USD must become 720 cents');
assert.match(response.rates[0].description, /600g/);

const unsupported = await callbackModule.buildShopifyShippingRates({
  rate: {
    destination: { country: 'US' },
    currency: 'USD',
    items: [{ sku: 'HEAVY', quantity: 1, grams: 1500, requires_shipping: true }],
  },
}, {
  krwPerUsd: 1460,
  resolveRate: async () => ({ standard_krw: 20700 }),
});
assert.deepEqual(unsupported, { rates: [] }, 'unsupported >1kg orders must return an empty rates array instead of undercharging');

const shopifyBridge = readFileSync(join(root, 'supabase', 'functions', 'shopify-bridge', 'index.ts'), 'utf8');
const edgeShopifyBridge = readFileSync(join(root, 'edge-functions', 'shopify-bridge', 'index.ts'), 'utf8');

for (const [label, source] of [['Supabase', shopifyBridge], ['edge mirror', edgeShopifyBridge]]) {
  assert.match(source, /write_shipping/, `${label} Shopify bridge must request or verify write_shipping for CarrierService`);
  assert.match(source, /carrierServiceCreate/, `${label} Shopify bridge must implement carrierServiceCreate registration`);
  assert.match(source, /SHOPIFY_CARRIER_CALLBACK_URL/, `${label} Shopify bridge must use a configured carrier callback URL`);
  assert.match(source, /shopify_write_shipping_scope_missing/, `${label} Shopify bridge must block CarrierService registration until OAuth has write_shipping`);
}

console.log('Shopify shipping rate callback checks passed');
