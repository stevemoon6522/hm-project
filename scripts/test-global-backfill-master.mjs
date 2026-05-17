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

const helpers = [
  sliceBetween(html, 'function _normalizeSku(s)', 'function _normalizeName(s)'),
  sliceBetween(html, 'function _gkpReadWeightKg(source, fallback = null)', 'function _gkpModelProductName(parentName, model)'),
  sliceBetween(html, 'function _gkpResolveOptionName(tierVariation, tierIndex)', 'function _gkpRowsForSelection(row)'),
  sliceBetween(html, 'function _normalizeGlobalId(value)', 'async function _fetchGlobalItemMeta(globalItemId, headers)'),
  sliceBetween(html, 'function _resolveModelMetaForRow(row, meta)', 'async function _bulkBackfillGlobalMeta()'),
].join('\n');

const context = {};
vm.runInNewContext(`${helpers}; this.api={_normalizeGlobalId,_resolveModelMetaForRow,_gkpResolveOptionName,_gkpReadWeightKg,_gkpWeightKgToGrams};`, context);
const { api } = context;

assert.equal(api._normalizeGlobalId('12345'), '12345');
assert.equal(api._normalizeGlobalId('abc'), '');
assert.equal(api._normalizeGlobalId('0'), '');

const meta = {
  models: [
    { global_model_id: 10, global_model_sku: 'SKU-A', tier_index: [0], weight: '0.08', model_name: 'A' },
    { global_model_id: 11, global_model_sku: 'SKU-B', tier_index: [1], model_name: 'B' },
  ],
  tierVariation: [{ name: 'Version', option_list: [{ option: 'A ver' }, { option: 'B ver' }] }],
  item: { weight: '0.12' },
};

const rowByModelId = { globalModelId: '10', sku: 'X' };
const rowBySku = { globalModelId: '', sku: 'SKU-B' };
assert.equal(api._resolveModelMetaForRow(rowByModelId, meta).global_model_id, 10);
assert.equal(api._resolveModelMetaForRow(rowBySku, meta).global_model_id, 11);

const model = api._resolveModelMetaForRow(rowByModelId, meta);
const option = api._gkpResolveOptionName(meta.tierVariation, model.tier_index) || model.model_name;
const modelWeightG = api._gkpWeightKgToGrams(api._gkpReadWeightKg(model));
const itemWeightG = api._gkpWeightKgToGrams(api._gkpReadWeightKg(meta.item));
assert.equal(option, 'A ver');
assert.equal(modelWeightG, 80);
assert.equal(itemWeightG, 120);

const emptyWeightRow = { option: '', weight: 0 };
if (!emptyWeightRow.option && option) emptyWeightRow.option = option;
if (!(Number(emptyWeightRow.weight) > 0) && (modelWeightG || itemWeightG)) emptyWeightRow.weight = (modelWeightG || itemWeightG);
assert.equal(emptyWeightRow.option, 'A ver');
assert.equal(emptyWeightRow.weight, 80);

const manualWeightRow = { option: '', weight: 500 };
if (!(Number(manualWeightRow.weight) > 0) && (modelWeightG || itemWeightG)) manualWeightRow.weight = (modelWeightG || itemWeightG);
assert.equal(manualWeightRow.weight, 500);

for (const token of [
  'id="global-backfill-master"',
  'backfillBtn.addEventListener(\'click\', _bulkBackfillGlobalMeta);',
  'updateProduct(row.id, row)',
  'global_model_list?region=SG',
  'global_item_info?region=SG',
]) {
  assert(html.includes(token), `missing token: ${token}`);
}

console.log('global backfill master regression checks passed');
