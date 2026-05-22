import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(html.includes('id="sp-preorder-dts"'), 'PRE ORDER DTS container is missing');
assert(html.includes('id="sp-sync-preorder-dts"'), 'PRE ORDER DTS sync button is missing');

const mapMatch = html.match(/const PRE_ORDER_REGION_DTS = Object\.freeze\((\{[\s\S]*?\})\);/);
assert(mapMatch, 'PRE_ORDER_REGION_DTS map is missing');

const pairs = [...mapMatch[1].matchAll(/([A-Z]{2}):\s*(\d+)/g)].map(([, region, value]) => [region, Number(value)]);
const preOrderMap = Object.fromEntries(pairs);
const expected = { SG: 10, TW: 10, TH: 10, MY: 10, PH: 10, BR: 10 };
for (const [region, value] of Object.entries(expected)) {
  assert(preOrderMap[region] === value, `PRE_ORDER_REGION_DTS.${region} must be ${value}, got ${preOrderMap[region]}`);
}

for (const token of [
  "shopeeDaysToShip: row.shopee_days_to_ship || null",
  "shopee_days_to_ship: p.shopeeDaysToShip || null",
  '_renderShopeePreOrderDts(row);',
  'async function _shopeeSyncPreOrderDts()',
  'const dtsMap = _readShopeePreOrderDtsMap();',
  'await _persistShopeePreOrderDts(row, dtsMap);',
  'is_pre_order: true',
  'days_to_ship: target.days_to_ship',
  "syncPreOrderDts.addEventListener('click', _shopeeSyncPreOrderDts);",
]) {
  assert(html.includes(token), `PRE ORDER DTS flow missing ${token}`);
}

console.log('pre-order DTS sync UI static checks passed');
