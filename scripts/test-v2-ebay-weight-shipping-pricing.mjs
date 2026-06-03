#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const htmlPath = join(root, 'v2', 'index.html');
const migrationPath = join(root, 'supabase', 'migrations', '202605300004_ebay_shipping_country_groups.sql');

assert.equal(existsSync(htmlPath), true, 'v2/index.html must exist');
assert.equal(existsSync(migrationPath), true, 'eBay shipping rate migration must exist');

const html = readFileSync(htmlPath, 'utf8');
const migration = readFileSync(migrationPath, 'utf8');

assert.match(html, /function _v2EbayGetShippingRateKrw\s*\(/, 'V2 must expose an eBay shipping-rate lookup helper');
assert.match(html, /const EBAY_US_DIRECT_SHIPPING_RATES_KRW\s*=\s*\{[\s\S]*?100\s*:\s*7200[\s\S]*?500\s*:\s*14400[\s\S]*?1000\s*:\s*20700[\s\S]*?\}/, 'US direct rate card must be available for eBay price calc');
const ebayCalcBlock = html.slice(
  html.indexOf('function _v2EbayCalcUsdListing'),
  html.indexOf('// ── end eBay helpers')
);
assert.match(ebayCalcBlock, /_v2EbayGetShippingRateKrw\(\s*['"]US['"]\s*,\s*weightG\s*\)/, 'eBay listing formula must include US baseline shipping from product weight');
assert.doesNotMatch(ebayCalcBlock, /const shipping\s*=\s*0\s*;/, 'eBay listing formula must not use zero shipping');
assert.match(html, /weightG\s*<=\s*0[\s\S]{0,260}eBay 등록에는 마스터 상품 무게/, 'eBay publish must block rows without master weight');
assert.match(html, /id="mr-ebay-modal-overlay"/, 'V2 must render an eBay publish confirmation modal');
assert.match(html, /function mrOpenEbayModal\s*\(/, 'eBay publish button must open the confirmation modal');
assert.doesNotMatch(html, /prompt\s*\(/, 'eBay publish flow must not use browser prompt');
assert.match(html, /미국 기준 배송비[\s\S]{0,220}draft\.ebayPricing\.usShippingUsd\.toFixed\(2\)/, 'eBay publish modal must show US shipping embedded in the price');
assert.match(html, /weightBucketG\s*:\s*draft\.ebayPricing\.weightBucketG/, 'eBay publish payload must send the selected shipping weight bucket for auditability');
assert.match(html, /usShippingKrw\s*:\s*draft\.ebayPricing\.usShippingKrw/, 'eBay publish payload must send US shipping KRW for auditability');
assert.match(html, /domestic shipping\s*=\s*free[\s\S]{0,120}국가별 extra\s*=\s*미국 대비 차액/i, 'Fee UI copy must explain free US domestic + country delta extra policy');

for (const [weight, rate] of [[100, 7200], [500, 14400], [1000, 20700]]) {
  assert.match(migration, new RegExp(`\\('US', '미국', 'baseline_1kg', ${weight}, ${rate}, ${rate}, 0, 0`), `migration must seed US ${weight}g baseline ${rate} KRW`);
}

console.log('v2 eBay weight-based US shipping pricing tests passed');
