import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sliceBetween(source, start, end) {
  const s = source.indexOf(start);
  assert(s >= 0, `missing start token: ${start}`);
  const e = source.indexOf(end, s);
  assert(e > s, `missing end token after ${start}`);
  return source.slice(s, e);
}

const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const modalHtml = sliceBetween(
  html,
  '<div class="modal-overlay" id="pl-master-edit-modal"',
  '<div id="toast">',
);
const editCode = sliceBetween(
  html,
  'function plMasterEditJsonText',
  'function beginEditCell(cell)',
);

for (const token of [
  'class="pl-master-edit-layout"',
  'class="pl-master-edit-card pl-master-edit-main-card"',
  'class="pl-master-edit-card pl-master-edit-image-card"',
  'class="pl-master-edit-card pl-master-edit-text-card"',
  'class="pl-master-edit-card pl-master-edit-options-card"',
]) {
  assert(modalHtml.includes(token), `master edit modal must use unified BOYNEXTDOOR-style layout: ${token}`);
}

for (const token of [
  'id="pl-master-edit-staronemall-url"',
  'id="pl-master-edit-lifecycle"',
  'id="pl-master-edit-components"',
  'data-master-components-only="pl-master-components-only"',
  'id="pl-master-edit-days"',
  'id="pl-master-edit-attrs"',
  'id="pl-master-edit-image-summary"',
  'id="pl-master-edit-options"',
]) {
  assert(modalHtml.includes(token), `master edit modal missing draft field: ${token}`);
}

for (const removedToken of [
  'id="pl-master-edit-category"',
  'id="pl-master-edit-brand-name"',
  'id="pl-master-edit-brand-id"',
  'id="pl-master-edit-description"',
  'Description 초안',
  '구성품 / Description',
  'Shopee category ID',
  'Shopee brand',
]) {
  assert(!modalHtml.includes(removedToken), `master edit modal still exposes platform-specific field: ${removedToken}`);
}

for (const token of [
  'async function openProductMasterEditModal',
  '.select(RSH_PRODUCT_SELECT)',
  'plMasterEditRenderImageSummary(rows)',
  'plMasterEditRenderOptions(rows)',
  'plMasterEditReadOptionPatches(rows)',
  'variation_option_names',
  'main_image',
  'shopee_days_to_ship',
  'shopee_extra_attributes',
  'shopee_category_id: rows[0]?.shopee_category_id || 101390',
  'shopee_brand_id: rows[0]?.shopee_brand_id ?? 0',
  "shopee_brand_name: rows[0]?.shopee_brand_name || 'No Brand'",
]) {
  assert(editCode.includes(token), `master edit draft save/open flow missing token: ${token}`);
}

for (const removedToken of [
  "document.getElementById('pl-master-edit-category')",
  "document.getElementById('pl-master-edit-brand-id')",
  "document.getElementById('pl-master-edit-brand-name')",
  "document.getElementById('pl-master-edit-description')",
  'shopee_description:',
  'extra_images',
]) {
  assert(!editCode.includes(removedToken), `master edit save/open flow still reads removed field: ${removedToken}`);
}

console.log('v2 master edit draft modal checks passed');
