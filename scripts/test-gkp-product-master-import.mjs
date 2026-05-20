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
  'function _gkpNormalize(s)',
  'function _gkpRenderResults()'
);

const context = {
  _gkpExpanded: new Set(['1001']),
  _gkpEnrichedFiltered: [],
  _gkpEnrichedCache: { items: [] },
  esc: value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;'),
};

vm.runInNewContext(
  `${gkpPureHelpers}
  this.api = {
    _gkpBuildRows,
    _gkpRowsForSelection,
    _gkpResolveOptionName,
    _gkpReadWeightKg,
    _gkpWeightKgToGrams,
    _gkpFilter,
    _gkpSkuSummary,
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
assert.equal(api._gkpSkuSummary(headerRow), '옵션 SKU 2개');
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

const modelSkuFallbackRows = api._gkpBuildRows([
  {
    type: 'model_header',
    global_item_id: 1002,
    item_name: 'Dance Album',
    item_sku: 'PARENT-SKU',
    weight_kg: 0.1,
    tier_variation: [],
    models: [
      {
        global_model_id: 9010,
        model_sku: 'CHOOM-OPTION-SKU',
        global_model_name: 'CHOOM ver',
        price_info: { original_price: 11111 },
      },
    ],
  },
]);
assert.equal(api._gkpRowsForSelection(modelSkuFallbackRows[0])[0].sku, 'CHOOM-OPTION-SKU');
assert.equal(api._gkpSkuSummary(modelSkuFallbackRows[0]), '옵션 SKU 1개');

const parentOnlyHeader = {
  rowType: 'model_header',
  item_name: 'Parent only',
  item_sku: 'PARENT-ONLY-SKU',
  models: [],
};
assert.match(api._gkpSkuSummary(parentOnlyHeader), /옵션 SKU 확인 필요/);
assert.deepEqual(api._gkpRowsForSelection(parentOnlyHeader), []);

const filteredByModelSku = api._gkpFilter([
  {
    type: 'model_header',
    global_item_id: 1003,
    item_name: 'No keyword here',
    item_sku: '',
    models: [{ model_sku: 'CHOOM-MODEL-SKU' }],
  },
], 'choom');
assert.equal(filteredByModelSku.length, 1);

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
