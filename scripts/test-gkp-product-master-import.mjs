import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');

function sliceBetween(source, start, end) {
  const s = source.indexOf(start);
  assert(s >= 0, `missing start token: ${start}`);
  const e = source.indexOf(end, s);
  assert(e > s, `missing end token after ${start}: ${end}`);
  return source.slice(s, e);
}

const gkpPureHelpers = sliceBetween(
  html,
  'function _gkpBuildRows(filteredItems)',
  'function _gkpSkuSummary(row)'
);

const context = {
  _gkpExpanded: new Set(['1001']),
};

vm.runInNewContext(
  `${gkpPureHelpers}
  this.api = {
    _gkpBuildRows,
    _gkpRowsForSelection,
    _gkpResolveOptionName,
    _gkpReadWeightKg,
    _gkpWeightKgToGrams,
  };`,
  context
);

const api = context.api;

const rows = api._gkpBuildRows([
  {
    type: 'model_header',
    global_item_id: 1001,
    item_name: 'Album',
    item_sku: '',
    weight_kg: 0.12,
    tier_variation: [
      { name: 'Version', option_list: [{ option: 'A ver' }, { option: 'B ver' }] },
    ],
    models: [
      {
        global_model_id: 9001,
        global_model_sku: 'SKU-A',
        price_info: { original_price: 12345 },
        tier_index: [0],
        weight: '0.08',
      },
      {
        global_model_id: 9002,
        global_model_sku: 'SKU-B',
        price_info: { original_price: 23456 },
        tier_index: [1],
      },
    ],
  },
]);

const headerRow = rows[0];
assert.equal(headerRow.rowType, 'model_header');
assert.deepEqual(headerRow.tier_variation, [
  { name: 'Version', option_list: [{ option: 'A ver' }, { option: 'B ver' }] },
]);
assert.equal(headerRow.weight_kg, 0.12);

const pickedModels = api._gkpRowsForSelection(headerRow);
assert.equal(pickedModels.length, 2);
assert.deepEqual(
  pickedModels.map(row => ({
    sku: row.sku,
    option_name: row.option_name,
    global_model_id: row.global_model_id,
    cost_krw: row.cost_krw,
    weight_g: row.weight_g,
  })),
  [
    { sku: 'SKU-A', option_name: 'A ver', global_model_id: 9001, cost_krw: 12345, weight_g: 80 },
    { sku: 'SKU-B', option_name: 'B ver', global_model_id: 9002, cost_krw: 23456, weight_g: 120 },
  ]
);

const singleRows = api._gkpBuildRows([
  {
    type: 'item',
    global_item_id: 2002,
    item_name: 'Single Album',
    item_sku: 'SINGLE-SKU',
    price: 34567,
    weight_kg: '0.11',
  },
]);
assert.equal(singleRows[0].weight_kg, '0.11');
assert.deepEqual(JSON.parse(JSON.stringify(api._gkpRowsForSelection(singleRows[0]))), [
  {
    sku: 'SINGLE-SKU',
    product_name: 'Single Album',
    shopee_item_id: '2002',
    cost_krw: 34567,
    weight_g: 110,
  },
]);

for (const token of [
  "select('id,sku,shopee_item_id,option_name,global_model_id,cost_krw,weight_g')",
  '_gkpMergeProductsIntoState(refreshedProducts || [])',
  'const GKP_CACHE_SCHEMA_VERSION = 2',
]) {
  assert(html.includes(token), `missing Product Master import token: ${token}`);
}

console.log('gkp product master import regression checks passed');
