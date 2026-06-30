import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');

function sliceBetween(source, start, end) {
  const s = source.indexOf(start);
  assert.notEqual(s, -1, `missing start token: ${start}`);
  const e = source.indexOf(end, s);
  assert.ok(e > s, `missing end token after ${start}`);
  return source.slice(s, e);
}

const registerView = sliceBetween(html, '<div id="view-register"', '</div><!-- /view-register -->');
const customPanel = sliceBetween(registerView, 'data-register-workbench-panel="custom"', 'data-register-workbench-panel="url"');
const masterRegister = sliceBetween(
  html,
  '// MASTER REGISTER (view-register, 2-stage bulk URL+weight)',
  '// FEE / EXCHANGE-RATE SETTINGS',
);
const customHandler = sliceBetween(masterRegister, 'async function mrStageCustomMaster()', 'function mrStatusLabel');

assert.match(customPanel, /<input type="hidden" id="custom-master-inventory" value="50"/, 'custom inventory must be stored in one hidden canonical control');
assert.match(customPanel, /id="custom-master-inventory-open"/, 'custom panel must expose an inventory modal open button');
assert.match(customPanel, /id="custom-master-inventory-summary"/, 'custom panel must show the current marketplace initial stock summary');
assert.match(html, /id="custom-master-inventory-modal"/, 'custom inventory modal must exist');
assert.match(html, /id="custom-master-inventory-modal-rows"/, 'custom inventory modal must render per-product or per-option stock rows');
assert.match(html, /data-custom-inventory-save-create="1"/, 'custom inventory modal must support save-and-create continuation');
assert.match(masterRegister, /marketplace initial registration stock only, not WMS stock/, 'custom inventory code must document the WMS separation');
assert.match(masterRegister, /let customMasterInventoryConfirmed = false/, 'custom inventory confirmation state must be explicit');
assert.match(masterRegister, /let MR_CUSTOM_CREATING = false/, 'custom creation must have an in-flight guard');

for (const helper of [
  'function mrCustomReadInventoryState()',
  'function mrCustomWriteInventoryState(state = {})',
  'function mrCustomUpdateInventorySummary()',
  'function mrCustomRenderInventoryModalRows()',
  'function mrCustomApplyInventoryModal()',
  'function mrCustomOpenInventoryModal(options = {})',
  'function mrCustomCloseInventoryModal()',
  'function mrCustomInventoryNeedsConfirmation()',
  'function mrCustomMarkInventoryDirty()',
]) {
  assert.match(masterRegister, new RegExp(helper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing custom inventory helper: ${helper}`);
}

assert.match(customHandler, /if \(mrCustomInventoryNeedsConfirmation\(\)\)/, 'custom create must require inventory confirmation before uploads');
assert.match(customHandler, /mrCustomOpenInventoryModal\(\{ continueAfterSave: true \}\)/, 'custom create should resume after inventory modal save');
assert.doesNotMatch(customHandler, /if \(!\(inventory > 0\)\)/, 'custom stock must allow zero because it is only marketplace initial registration stock');
assert.match(masterRegister, /modal\.classList\.add\('show'\)/, 'opening the custom inventory modal must make the shared modal overlay visible');
assert.match(masterRegister, /modal\.classList\.remove\('show'\)/, 'closing the custom inventory modal must hide the shared modal overlay');
assert.match(masterRegister, /\$\('custom-master-inventory-open'\)\?\.addEventListener\('click', \(\) => mrCustomOpenInventoryModal\(\)\)/, 'inventory modal open button must be wired');
assert.match(masterRegister, /\$\('custom-master-inventory-save-create'\)\?\.addEventListener\('click'/, 'inventory modal save-and-create button must be wired');

console.log('v2 custom master inventory modal checks passed');
