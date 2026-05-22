import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const mapMatch = html.match(/const READY_STOCK_REGION_DTS = Object\.freeze\((\{[\s\S]*?\})\);/);
assert(mapMatch, 'READY_STOCK_REGION_DTS map is missing');

const pairs = [...mapMatch[1].matchAll(/([A-Z]{2}):\s*(\d+)/g)].map(([, region, value]) => [region, Number(value)]);
const readyMap = Object.fromEntries(pairs);
const expected = { SG: 2, TW: 1, TH: 2, MY: 2, PH: 2, BR: 3 };

for (const [region, value] of Object.entries(expected)) {
  assert(readyMap[region] === value, `READY_STOCK_REGION_DTS.${region} must be ${value}, got ${readyMap[region]}`);
}

assert(
  html.includes("body: JSON.stringify({ global_item_id: gid, days_to_ship: 1, is_pre_order: false })"),
  'global DTS update must keep days_to_ship=1 for catalog baseline',
);

assert(
  html.includes('days_to_ship: _readyStockDtsForRegion(t.region)'),
  'shop-level DTS update must use region-specific ready stock mapping',
);

assert(
  !html.includes('body: JSON.stringify({ region: t.region, item_id: t.item_id, days_to_ship: 1, is_pre_order: false })'),
  'shop-level DTS update must not hardcode days_to_ship=1',
);

console.log('ready stock bulk DTS static checks passed');
