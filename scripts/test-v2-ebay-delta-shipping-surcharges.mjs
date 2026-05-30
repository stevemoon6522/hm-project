#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const htmlPath = join(root, 'v2', 'index.html');
const edgePath = join(root, 'supabase', 'functions', 'ebay-bridge', 'index.ts');
const edgeMirrorPath = join(root, 'edge-functions', 'ebay-bridge', 'index.ts');

assert.equal(existsSync(htmlPath), true, 'v2/index.html must exist');
assert.equal(existsSync(edgePath), true, 'supabase ebay-bridge must exist');
assert.equal(existsSync(edgeMirrorPath), true, 'edge-functions ebay-bridge mirror must exist');

const html = readFileSync(htmlPath, 'utf8');
const edge = readFileSync(edgePath, 'utf8');
const edgeMirror = readFileSync(edgeMirrorPath, 'utf8');

assert.match(html, /const EBAY_SHIPPING_RATE_TABLE_KRW\s*=\s*\{[\s\S]*?DE\s*:\s*\{[\s\S]*?100\s*:\s*\{\s*baselineKrw\s*:\s*7200\s*,\s*standardKrw\s*:\s*7450\s*,\s*deltaKrw\s*:\s*250[\s\S]*?PT\s*:\s*\{[\s\S]*?1000\s*:\s*\{\s*baselineKrw\s*:\s*20700\s*,\s*standardKrw\s*:\s*22900\s*,\s*deltaKrw\s*:\s*2200/s, 'V2 must expose country/weight KRW rates including delta_krw for surcharge countries');
assert.match(html, /function _v2EbayGetShippingSurchargeUsd\s*\(\s*countryCode\s*,\s*weightG\s*,\s*exchangeRate/s, 'V2 must expose per-country USD surcharge helper');
assert.match(html, /Math\.ceil\(\s*\(\s*deltaKrw\s*\/\s*exchangeRate\s*\)\s*\*\s*100\s*\)\s*\/\s*100/s, 'surcharge helper must round country delta up to cents');
assert.match(html, /function _v2EbayBuildShippingSurchargeRows\s*\(\s*weightG\s*,\s*exchangeRate/s, 'V2 must build listing-specific surcharge rows from weight and exchange rate');
assert.match(html, /shippingSurchargesUsd\s*:\s*ebayPricing\.shippingSurchargesUsd/s, 'publish payload must send country delta surcharge rows');
assert.match(html, /shippingSurchargePolicy\s*:\s*['"]delta_vs_us_baseline['"]/s, 'publish payload must identify delta-vs-US surcharge policy');
assert.match(html, /나머지 국가는 미국 대비 차액만 extra shipping/s, 'operator prompt must state non-US buyers pay only the delta');
assert.match(html, /DE\s*\$\$\{[^}]*_v2EbayGetShippingSurchargeUsd\(\s*['"]DE['"]\s*,\s*weightG\s*,\s*exCountry\.exchangeRate\s*\)/s, 'publish prompt must preview a concrete higher-rate country surcharge');

for (const source of [edge, edgeMirror]) {
  assert.match(source, /shippingSurchargesUsd\s*=\s*\[\]/s, 'ebay-bridge must accept shippingSurchargesUsd in publish body');
  assert.match(source, /validateShippingSurcharges\s*\(\s*shippingSurchargesUsd\s*\)/s, 'ebay-bridge must validate country surcharge rows');
  assert.match(source, /shipping_surcharge_policy\s*:\s*shippingSurchargePolicy/s, 'ebay-bridge response must echo surcharge policy for auditability');
  assert.match(source, /shipping_surcharges_usd\s*:\s*safeShippingSurcharges/s, 'ebay-bridge response must echo validated surcharge rows for auditability');
}

console.log('v2 eBay country delta shipping surcharge tests passed');
