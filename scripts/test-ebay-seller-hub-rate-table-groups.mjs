#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  EBAY_SELLER_HUB_RATE_TABLE_GROUPS,
  buildSellerHubRateTableRows,
} from './ebay-seller-hub-rate-table-groups.mjs';

const rows = buildSellerHubRateTableRows();
const byCost = new Map(rows.map((row) => [row.costUsd, row.countryCodes]));

assert.deepEqual(
  [...byCost.keys()],
  [0, 3.99, 4.99, 7.99, 8.99, 9.99, 11.99, 13.99, 14.99, 17.99, 18.99],
  'approved Seller Hub Cost buckets must stay in order',
);

assert.deepEqual(byCost.get(3.99), ['BG', 'FR', 'DE', 'IT', 'NL', 'ES', 'GB']);
assert.deepEqual(byCost.get(8.99), ['HR', 'DK', 'GR', 'LT', 'PL', 'RO', 'SI', 'SE']);
assert.deepEqual(byCost.get(11.99), ['AT', 'BE', 'CZ', 'EE', 'FI', 'HU', 'IE', 'LV', 'LU', 'NO', 'PT']);
assert.deepEqual(byCost.get(13.99), ['SK', 'CH']);
assert.deepEqual(byCost.get(18.99), ['CY', 'MT']);

const allCodes = rows.flatMap((row) => row.countryCodes);
assert.equal(new Set(allCodes).size, allCodes.length, 'country codes must not be duplicated');
assert.equal(
  EBAY_SELLER_HUB_RATE_TABLE_GROUPS.every((group) => Number.isFinite(group.costUsd)),
  true,
  'every Cost bucket must be numeric',
);

const oldEuropeCosts = new Map([
  ['BG', 0], ['FR', 0], ['DE', 0], ['IT', 0], ['NL', 0], ['ES', 0], ['GB', 0],
  ['HR', 4.99], ['DK', 4.99], ['GR', 4.99], ['LT', 4.99], ['PL', 4.99], ['RO', 4.99], ['SI', 4.99], ['SE', 4.99],
  ['AT', 7.99], ['BE', 7.99], ['CZ', 7.99], ['EE', 7.99], ['FI', 7.99], ['HU', 7.99], ['IE', 7.99], ['LV', 7.99], ['LU', 7.99], ['NO', 7.99], ['PT', 7.99],
  ['SK', 9.99], ['CH', 9.99],
  ['CY', 14.99], ['MT', 14.99],
]);

for (const row of rows) {
  for (const code of row.countryCodes) {
    const oldCost = oldEuropeCosts.get(code);
    if (oldCost === undefined) continue;
    assert(
      row.costUsd - oldCost >= 3.40,
      `${code} must increase by at least $3.40`,
    );
  }
}

console.log('eBay Seller Hub shipping rate table group tests passed');
