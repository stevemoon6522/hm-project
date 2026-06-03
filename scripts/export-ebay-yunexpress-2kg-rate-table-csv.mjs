#!/usr/bin/env node
/**
 * Export a manual-entry CSV for eBay Seller Hub rate tables using the YunExpress seed.
 *
 * Current repo seed contains source rows through 1000g only. For 1100g~2000g this
 * exporter extrapolates from each country's 900g->1000g increment and marks those
 * rows as EXTRAPOLATED_FROM_1KG_SEED so they are not confused with source-card rows.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const migrationPath = join(root, 'supabase', 'migrations', '202605300004_ebay_shipping_country_groups.sql');
const outPath = process.argv[2] || join(root, 'tmp', 'ebay-yunexpress-2kg-country-weight-rate-table.csv');
const exchangeRate = Number(process.env.EBAY_EXPORT_USD_KRW || 1400);
const maxWeightG = Number(process.env.EBAY_EXPORT_MAX_WEIGHT_G || 2000);
const weightStepG = 100;

const migration = readFileSync(migrationPath, 'utf8');
const rowPattern = /\('([A-Z]{2})',\s*'([^']*)',\s*'([^']*)',\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+),\s*'([^']*)',\s*'([^']*)'\)/g;
const byCountry = new Map();
for (const m of migration.matchAll(rowPattern)) {
  const [, countryCode, countryName, rateGroup, weightBucketG, baselineKrw, standardKrw, deltaKrw, deltaUsd, sourceService, effectiveDate] = m;
  if (!byCountry.has(countryCode)) {
    byCountry.set(countryCode, { countryCode, countryName, rateGroup, sourceService, effectiveDate, rows: new Map() });
  }
  byCountry.get(countryCode).rows.set(Number(weightBucketG), {
    baselineKrw: Number(baselineKrw),
    standardKrw: Number(standardKrw),
    deltaKrw: Number(deltaKrw),
    deltaUsd: Number(deltaUsd),
    sourceType: 'SOURCE_SEED',
  });
}

const ceilUsd = (krw) => Math.ceil((Math.max(0, krw) / exchangeRate) * 100) / 100;
const weights = Array.from({ length: maxWeightG / weightStepG }, (_, i) => (i + 1) * weightStepG);
const outputRows = [];
for (const country of [...byCountry.values()].sort((a, b) => a.countryCode.localeCompare(b.countryCode))) {
  const sourceWeights = [...country.rows.keys()].sort((a, b) => a - b);
  const lastWeight = sourceWeights.at(-1);
  const prevWeight = sourceWeights.at(-2);
  const last = country.rows.get(lastWeight);
  const prev = country.rows.get(prevWeight);
  const baselineStepKrw = Math.max(0, last.baselineKrw - prev.baselineKrw);
  const standardStepKrw = Math.max(0, last.standardKrw - prev.standardKrw);

  for (const weightG of weights) {
    let row = country.rows.get(weightG);
    if (!row) {
      const stepsAfterLast = (weightG - lastWeight) / weightStepG;
      const baselineKrw = last.baselineKrw + baselineStepKrw * stepsAfterLast;
      const standardKrw = last.standardKrw + standardStepKrw * stepsAfterLast;
      const deltaKrw = Math.max(0, standardKrw - baselineKrw);
      row = {
        baselineKrw,
        standardKrw,
        deltaKrw,
        deltaUsd: ceilUsd(deltaKrw),
        sourceType: 'EXTRAPOLATED_FROM_1KG_SEED',
      };
    }
    outputRows.push({
      country_code: country.countryCode,
      country_name_ko: country.countryName,
      rate_group_1kg_seed: country.rateGroup,
      weight_g: weightG,
      baseline_us_direct_krw: row.baselineKrw,
      yunexpress_standard_krw: row.standardKrw,
      extra_delta_krw: row.deltaKrw,
      ebay_extra_shipping_usd: ceilUsd(row.deltaKrw).toFixed(2),
      source_type: row.sourceType,
      source_service: country.sourceService,
      effective_date: country.effectiveDate,
      exchange_rate_usd_krw: exchangeRate,
    });
  }
}

const headers = [
  'country_code',
  'country_name_ko',
  'rate_group_1kg_seed',
  'weight_g',
  'baseline_us_direct_krw',
  'yunexpress_standard_krw',
  'extra_delta_krw',
  'ebay_extra_shipping_usd',
  'source_type',
  'source_service',
  'effective_date',
  'exchange_rate_usd_krw',
];
const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
const csv = [headers, ...outputRows.map((row) => headers.map((h) => row[h]))]
  .map((row) => row.map(esc).join(','))
  .join('\n') + '\n';
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, csv, 'utf8');

// Also write a one-row-per-country summary for Seller Hub by-item manual entry.
const summaryPath = outPath.replace(/\.csv$/i, '-summary-max-2kg.csv');
const summaries = [...byCountry.values()].sort((a, b) => a.countryCode.localeCompare(b.countryCode)).map((country) => {
  const rows = outputRows.filter((row) => row.country_code === country.countryCode);
  const max = rows.reduce((best, row) => Number(row.extra_delta_krw) > Number(best.extra_delta_krw) ? row : best, rows[0]);
  const at2kg = rows.find((row) => Number(row.weight_g) === maxWeightG);
  return {
    country_code: country.countryCode,
    country_name_ko: country.countryName,
    rate_group_1kg_seed: country.rateGroup,
    seller_hub_by_item_cost_usd_max_to_2kg: max.ebay_extra_shipping_usd,
    max_delta_krw_to_2kg: max.extra_delta_krw,
    max_delta_weight_g: max.weight_g,
    cost_usd_at_2kg: at2kg.ebay_extra_shipping_usd,
    delta_krw_at_2kg: at2kg.extra_delta_krw,
    source_note: '100g~1000g SOURCE_SEED; 1100g~2000g EXTRAPOLATED_FROM_1KG_SEED',
    exchange_rate_usd_krw: exchangeRate,
  };
});
const summaryHeaders = Object.keys(summaries[0]);
const summaryCsv = [summaryHeaders, ...summaries.map((row) => summaryHeaders.map((h) => row[h]))]
  .map((row) => row.map(esc).join(','))
  .join('\n') + '\n';
writeFileSync(summaryPath, summaryCsv, 'utf8');

console.log(JSON.stringify({ outPath, summaryPath, countries: byCountry.size, rows: outputRows.length, maxWeightG, exchangeRate }, null, 2));
