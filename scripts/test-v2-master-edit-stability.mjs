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

const rshSelect = sliceBetween(
  html,
  'const RSH_PRODUCT_SELECT =',
  ';',
);

for (const field of [
  'created_at',
  'updated_at',
  'position',
  'weight_measured_at',
  'shopee_item_id',
  'global_model_id',
  'shopee_global_model_sku',
]) {
  assert(
    rshSelect.includes(field),
    `master edit refresh select must preserve product-list field: ${field}`,
  );
}

const scrollHelpers = sliceBetween(
  html,
  'function plMasterEditModalBody',
  'function plMasterEditRefreshOptionImagePreview',
);

for (const token of [
  "document.querySelector('#pl-master-edit-modal .modal-body')",
  'function plMasterEditCaptureModalPosition(anchorRow = null)',
  'function plMasterEditFindOptionRowByPosition(position = {})',
  'function plMasterEditRestoreModalPosition(position = {})',
  'function plMasterEditPreserveModalScroll(callback, anchorRow = null)',
  'anchorOffset',
  'rowKey',
  'requestAnimationFrame',
]) {
  assert(scrollHelpers.includes(token), `master edit modal scroll helper missing token: ${token}`);
}

const optionImageRefresh = sliceBetween(
  html,
  'function plMasterEditRefreshOptionImagePreview',
  'async function plMasterEditUploadOptionImage',
);

assert(
  optionImageRefresh.includes('plMasterEditPreserveModalScroll(() => plMasterEditRenderImageSummary(renderedRows), tr)'),
  'option image preview refresh must preserve the modal body scroll while rerendering the image summary anchored to the option row',
);

const optionImageBinding = sliceBetween(
  html,
  'function plMasterEditBindOptionImageControls',
  'async function openProductMasterEditModal',
);

assert(
  optionImageBinding.includes('const restorePosition = plMasterEditCaptureModalPosition(tr)')
    && optionImageBinding.includes('plMasterEditUploadOptionImage(tr, file, fileInput, restorePosition)'),
  'option image upload must capture the modal position before the async file picker/upload rerenders previews',
);

const openModal = sliceBetween(
  html,
  'async function openProductMasterEditModal',
  'function plMasterEditReadOptionPatches',
);

assert(
  openModal.includes('nameInput.focus({ preventScroll: true })'),
  'master edit modal initial focus must not scroll the modal/page upward',
);

console.log('v2 master edit stability checks passed');
