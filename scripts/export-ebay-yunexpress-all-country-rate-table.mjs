#!/usr/bin/env node
/** Export YunExpress-derived eBay rate-table rows for every country in the seed. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const migrationPath = join(root, 'supabase', 'migrations', '202605300004_ebay_shipping_country_groups.sql');
const outPath = process.argv[2] || join(root, 'tmp', 'ebay-yunexpress-all-country-rate-table.csv');
const exchangeRate = Number(process.env.EBAY_EXPORT_USD_KRW || 1400);
const mode = process.argv[3] || 'max-1kg-delta';

const migration = readFileSync(migrationPath, 'utf8');
const rowPattern = /\('([A-Z]{2})',\s*'([^']*)',\s*'([^']*)',\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+),\s*'[^']*',\s*'[^']*'\)/g;
const byCountry = new Map();
for (const m of migration.matchAll(rowPattern)) {
  const [, countryCode, countryName, rateGroup, weightBucketG, baselineKrw, standardKrw, deltaKrw] = m;
  if (!byCountry.has(countryCode)) {
    byCountry.set(countryCode, { countryCode, countryName, rateGroup, rows: [] });
  }
  byCountry.get(countryCode).rows.push({
    weightBucketG: Number(weightBucketG),
    baselineKrw: Number(baselineKrw),
    standardKrw: Number(standardKrw),
    deltaKrw: Number(deltaKrw),
  });
}

const rows = [...byCountry.values()].map((country) => {
  country.rows.sort((a, b) => a.weightBucketG - b.weightBucketG);
  const max = country.rows.reduce((best, row) => (row.deltaKrw > best.deltaKrw ? row : best), country.rows[0]);
  const at1000 = country.rows.find((row) => row.weightBucketG === 1000) || country.rows.at(-1);
  const chargeDeltaKrw = mode === '1000g-delta' ? at1000.deltaKrw : max.deltaKrw;
  const extraShippingUsd = Math.ceil((Math.max(0, chargeDeltaKrw) / exchangeRate) * 100) / 100;
  return {
    country_code: country.countryCode,
    country_name_ko: country.countryName,
    rate_group: country.rateGroup,
    ebay_rate_table_cost_usd: extraShippingUsd.toFixed(2),
    max_delta_krw_100_to_1000g: max.deltaKrw,
    max_delta_weight_g: max.weightBucketG,
    delta_1000g_krw: at1000.deltaKrw,
    baseline_1000g_krw: at1000.baselineKrw,
    standard_1000g_krw: at1000.standardKrw,
    all_weight_deltas_krw: country.rows.map((row) => `${row.weightBucketG}g:${row.deltaKrw}`).join(';'),
  };
}).sort((a, b) => a.country_code.localeCompare(b.country_code));

const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
const headers = [
  'country_code',
  'country_name_ko',
  'rate_group',
  'ebay_rate_table_cost_usd',
  'max_delta_krw_100_to_1000g',
  'max_delta_weight_g',
  'delta_1000g_krw',
  'baseline_1000g_krw',
  'standard_1000g_krw',
  'all_weight_deltas_krw',
];
const csv = [headers, ...rows.map((row) => headers.map((h) => row[h]))]
  .map((row) => row.map(esc).join(','))
  .join('\n') + '\n';
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, csv, 'utf8');
console.log(JSON.stringify({ outPath, countries: rows.length, exchangeRate, mode }, null, 2));
