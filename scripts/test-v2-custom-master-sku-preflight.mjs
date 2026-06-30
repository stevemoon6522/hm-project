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

const masterRegister = sliceBetween(
  html,
  '// MASTER REGISTER (view-register, 2-stage bulk URL+weight)',
  '// FEE / EXCHANGE-RATE SETTINGS',
);
const customHandler = sliceBetween(masterRegister, 'async function mrStageCustomMaster()', 'function mrStatusLabel');
const customOptionRenderer = sliceBetween(masterRegister, 'function mrRenderCustomOptionRow(prefill = {})', 'function mrCustomEnsureOptionRow()');

for (const helper of [
  'function mrCustomExistingSkuSet()',
  'function mrCustomNextAvailableSku(baseSku, reservedSkus = new Set())',
  'function mrCustomResolveSkuPreflight(title, options, hasOptions)',
  'function mrCustomClearSkuPreflightErrors()',
  'function mrCustomRenderSkuPreflightErrors(errors = [])',
  'function mrCustomApplyAutoSkuForRow(row)',
  'function mrCustomApplyResolvedSkus(options = [])',
]) {
  assert.match(masterRegister, new RegExp(helper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing custom SKU preflight helper: ${helper}`);
}

assert.match(customOptionRenderer, /customOptionSkuMode/, 'custom option SKU inputs must track auto/manual mode');
assert.match(customOptionRenderer, /autocomplete: 'off'/, 'custom option SKU inputs must avoid browser autofill copying the same SKU into every option');
assert.match(customOptionRenderer, /data-custom-option-sku-error/, 'custom option rows must expose an inline SKU error target');
assert.match(customOptionRenderer, /data-custom-option-auto-sku/, 'custom option rows must expose an Auto SKU recovery button');
assert.match(masterRegister, /MR_EXISTING_SKUS/, 'custom SKU preflight must use the existing SKU cache');
assert.match(masterRegister, /const skuMode = opt\.skuMode === 'manual' \? 'manual' : 'auto'/, 'SKU preflight must distinguish copied/auto SKUs from operator-entered manual SKUs');
assert.match(masterRegister, /const hasManualSku = Boolean\(manualSku && skuMode === 'manual'\)/, 'only true manual SKUs should block on duplicate preflight');
assert.match(masterRegister, /sku = mrCustomNextAvailableSku\(generatedSku, reservedSkus\)/, 'auto/copy SKUs must be suffixed instead of blocking creation');
assert.match(customHandler, /await mrLoadExistingSkus\(\)/, 'custom create must refresh existing SKU cache before preflight');
assert.match(customHandler, /const skuPreflight = mrCustomResolveSkuPreflight\(title, normalizedOptions, hasOptions\)/, 'custom create must resolve SKU preflight before uploads');
assert.match(customHandler, /mrCustomRenderSkuPreflightErrors\(skuPreflight\.duplicateSkus\)/, 'manual duplicate SKU errors must be rendered inline');
assert.match(customHandler, /mrCustomApplyResolvedSkus\(normalizedOptions\)/, 'resolved auto SKUs must be written back to the copied option rows before continuing');

const preflightIndex = customHandler.indexOf('mrCustomResolveSkuPreflight(title, normalizedOptions, hasOptions)');
const inventoryIndex = customHandler.indexOf('mrCustomInventoryNeedsConfirmation()');
const uploadIndex = customHandler.indexOf('mrCustomUploadImageFile(coverFile');
assert.ok(preflightIndex >= 0 && inventoryIndex > preflightIndex, 'SKU preflight must run before inventory confirmation');
assert.ok(preflightIndex >= 0 && uploadIndex > preflightIndex, 'SKU preflight must run before any image upload');
assert.match(masterRegister, /if \(MR_EXISTING_SKUS\.has\(sku\)\) throw new Error/, 'direct promotion must retain the final duplicate SKU guard');

console.log('v2 custom master SKU preflight checks passed');
