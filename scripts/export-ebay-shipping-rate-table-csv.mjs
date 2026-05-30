#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const migrationPath = join(root, 'supabase', 'migrations', '202605300004_ebay_shipping_country_groups.sql');
const outPath = process.argv[2] || join(root, 'tmp', 'ebay-shipping-rate-table-delta-vs-us.csv');
const exchangeRate = Number(process.env.EBAY_EXPORT_USD_KRW || 1400);

const migration = readFileSync(migrationPath, 'utf8');
const rowPattern = /\('([A-Z]{2})',\s*'([^']*)',\s*'([^']*)',\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+),\s*'[^']*',\s*'[^']*'\)/g;
const rows = [];
for (const m of migration.matchAll(rowPattern)) {
  const [, countryCode, countryName, rateGroup, weightBucketG, baselineKrw, standardKrw, deltaKrw] = m;
  if (rateGroup !== 'higher_rate_1kg') continue;
  const delta = Number(deltaKrw);
  if (delta <= 0) continue;
  rows.push({
    countryCode,
    countryName,
    weightBucketG: Number(weightBucketG),
    baselineKrw: Number(baselineKrw),
    standardKrw: Number(standardKrw),
    deltaKrw: delta,
    extraShippingUsd: Math.ceil((delta / exchangeRate) * 100) / 100,
  });
}
rows.sort((a, b) => a.countryCode.localeCompare(b.countryCode) || a.weightBucketG - b.weightBucketG);

const esc = (v) => `"${String(v).replaceAll('"', '""')}"`;
const csv = [
  ['country_code', 'country_name', 'weight_bucket_g', 'baseline_krw', 'standard_krw', 'delta_krw', `extra_shipping_usd_at_${exchangeRate}_krw`],
  ...rows.map((r) => [r.countryCode, r.countryName, r.weightBucketG, r.baselineKrw, r.standardKrw, r.deltaKrw, r.extraShippingUsd.toFixed(2)]),
].map((row) => row.map(esc).join(',')).join('\n') + '\n';

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, csv, 'utf8');
console.log(`${outPath}\nrows=${rows.length}\nexchange_rate=${exchangeRate}`);
