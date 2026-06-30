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

const productList = sliceBetween(
  html,
  'function renderProducts() {',
  'function beginEditCell(cell) {',
);
const platformWorkbench = sliceBetween(
  html,
  'function renderPlatformWorkbench(platform)',
  'function platformGroupsByKeys(keys)',
);
const masterRegister = sliceBetween(
  html,
  '// MASTER REGISTER (view-register, 2-stage bulk URL+weight)',
  '// FEE / EXCHANGE-RATE SETTINGS',
);
const styles = sliceBetween(html, '<style>', '</style>');
const customPrefill = sliceBetween(masterRegister, 'function mrCustomPrefillFromRows(rows)', 'function openCustomMasterCopyRegister(productGroupId)');
const copyFlow = sliceBetween(masterRegister, 'function openCustomMasterCopyRegister(productGroupId)', 'async function mrStageCustomMaster()');

assert.match(productList, /data-copy-master/, 'master product list must expose copy registration buttons');
assert.match(platformWorkbench, /data-copy-master/, 'platform workbench master rows must expose copy registration buttons');
assert.match(html, /querySelectorAll\('\[data-copy-master\]'\)/, 'copy registration buttons must be event-bound');

for (const helper of [
  'function mrCustomResetImageInputs()',
  'function mrCustomClearOptionRows()',
  'function mrCustomPrefillFromRows(rows)',
  'function openCustomMasterCopyRegister(productGroupId)',
]) {
  assert.match(masterRegister, new RegExp(helper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing custom copy helper: ${helper}`);
}

assert.match(copyFlow, /mrCustomResetImageInputs\(\)/, 'copy registration must clear representative, detail, and option file inputs');
assert.match(copyFlow, /customMasterInventoryConfirmed = false/, 'copied custom stock must require fresh confirmation');
assert.match(copyFlow, /sdRegisterWorkbenchActivate\('custom'\)/, 'copy registration must open the custom registration panel');
assert.match(customPrefill, /skuMode: 'auto'/, 'copy registration must mark prefilled SKUs as auto-generated, not manual');
assert.match(customPrefill, /mrCustomNextAvailableSku\(mrCustomSkuForOption/, 'copy registration must prefill unique auto SKUs per option');
assert.doesNotMatch(copyFlow, /main_image\s*:/, 'copy registration must not copy representative image URLs');
assert.doesNotMatch(copyFlow, /extra_images\s*:/, 'copy registration must not copy detail image URLs');
assert.doesNotMatch(copyFlow, /shopee_option_image_url\s*:/, 'copy registration must not copy option image URLs');
assert.match(styles, /\.pl-master-edit,\s*\.pl-master-copy,\s*\.pl-delete-button[\s\S]*min-width: 46px[\s\S]*height: 28px/, 'master list edit/copy/delete buttons must share one size');
assert.match(styles, /\.custom-master-option-row button[\s\S]*height: 36px/, 'custom option row buttons must share one height');

console.log('v2 custom master copy registration checks passed');
