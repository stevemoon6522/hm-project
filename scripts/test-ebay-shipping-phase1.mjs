#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const migrationPath = join(root, 'supabase', 'migrations', '202605300004_ebay_shipping_country_groups.sql');
const htmlPath = join(root, 'v2', 'index.html');

assert.equal(existsSync(migrationPath), true, 'eBay shipping country-group migration must exist');

const migration = readFileSync(migrationPath, 'utf8');
const html = readFileSync(htmlPath, 'utf8');

const baselineCodes = ['US', 'GB', 'FR', 'ES', 'SE', 'BG', 'SG', 'AU', 'NZ', 'JP', 'HK', 'MO'];
const standardBaselineCodes = baselineCodes.filter((code) => code !== 'US');
const baselineWeights = [100,200,300,400,500,600,700,800,900,1000];

assert.match(migration, /create table if not exists public\.ebay_shipping_country_groups/i, 'migration creates ebay_shipping_country_groups');
assert.match(migration, /create table if not exists public\.ebay_shipping_country_rates/i, 'migration creates ebay_shipping_country_rates');
assert.match(migration, /baseline_1kg/i, 'migration seeds baseline_1kg group');
assert.match(migration, /higher_rate_1kg/i, 'migration seeds higher_rate_1kg group');
assert.match(migration, /excluded_pending_rate_table/i, 'migration seeds excluded_pending_rate_table group');
assert.match(migration, /source_sheet/i, 'rate rows preserve source sheet');

for (const code of baselineCodes) {
  assert.match(migration, new RegExp(`'${code}'`), `migration includes ${code} in eBay shipping groups/rates`);
}

for (const weight of baselineWeights) {
  assert.match(migration, new RegExp(`\\b${weight}\\b`), `migration includes ${weight}g bucket`);
}

for (const code of standardBaselineCodes) {
  const groupRegex = new RegExp(`'${code}'[\\s\\S]{0,140}'baseline_1kg'|'baseline_1kg'[\\s\\S]{0,140}'${code}'`, 'i');
  assert.match(migration, groupRegex, `${code} must be classified as baseline_1kg`);
}

assert.match(migration, /delta_krw\s+numeric\s+not null/i, 'rate table stores delta_krw for later surcharge phase');
assert.match(migration, /surcharge_usd\s+numeric\s+not null\s+default 0/i, 'rate table stores surcharge_usd for eBay rate-table phase');

assert.match(html, /EBAY_SHIPPING_BASELINE_1KG_COUNTRIES/, 'V2 exposes baseline 1kg country list');
assert.match(html, /EBAY_SHIPPING_HIGHER_RATE_1KG_COUNTRIES/, 'V2 exposes higher-rate country list');
assert.match(html, /renderEbayShippingPhase1Summary/, 'V2 renders eBay shipping phase-1 summary');
assert.match(html, /1kg 이하 기준 배송 가능 국가/, 'V2 labels baseline countries for operators');
assert.match(html, /higher-rate 제외\/보류 국가/, 'V2 labels excluded higher-rate countries');
assert.match(html, /Domestic shipping = free/, 'V2 includes Seller Hub domestic free policy wording');
assert.match(html, /국가별 extra = 미국 대비 차액/, 'V2 includes country delta surcharge policy wording');

console.log('eBay shipping phase-1 tests passed');
