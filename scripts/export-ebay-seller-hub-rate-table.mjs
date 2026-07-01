#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildSellerHubRateTableRows,
  formatSellerHubMarkdownTable,
} from './ebay-seller-hub-rate-table-groups.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const outDir = process.argv[2] || join(root, 'tmp');
const csvPath = join(outDir, 'ebay-seller-hub-rate-table-2026-07-01.csv');
const markdownPath = join(outDir, 'ebay-seller-hub-rate-table-2026-07-01.md');
const rows = buildSellerHubRateTableRows();

function csvEscape(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

const headers = ['cost_usd', 'country_codes', 'seller_hub_regions'];
const csv = [
  headers,
  ...rows.map((row) => [
    row.costUsd.toFixed(2),
    row.countryCodes.join(' '),
    row.sellerHubText,
  ]),
].map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';

mkdirSync(dirname(csvPath), { recursive: true });
writeFileSync(csvPath, csv, 'utf8');
writeFileSync(markdownPath, formatSellerHubMarkdownTable(rows), 'utf8');

console.log(JSON.stringify({
  csvPath,
  markdownPath,
  rows: rows.length,
  countries: rows.flatMap((row) => row.countryCodes).length,
}, null, 2));
