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
const atomicSaveMigration = readFileSync(
  join(root, 'supabase', 'migrations', '202606220002_update_master_product_group_rpc.sql'),
  'utf8',
);
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
const representativeSetter = sliceBetween(
  editCode,
  'function plMasterEditSetRepresentativeImage',
  'async function plMasterEditCrawlStaronemallImages',
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
  'id="pl-master-edit-components-extract"',
  'id="pl-master-edit-components-status"',
  'data-master-components-only="pl-master-components-only"',
  'id="pl-master-edit-days"',
  'id="pl-master-edit-attrs"',
  'id="pl-master-edit-staronemall-image-status"',
  'id="pl-master-edit-staronemall-recrawl"',
  'id="pl-master-edit-representative-image-file"',
  'id="pl-master-edit-representative-image-url"',
  'id="pl-master-edit-detail-image-state"',
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
  'function plMasterEditExtractComponentsFromImages',
  'image_urls: componentImageUrls',
  'image_data_urls: imageDataUrls',
  'plMasterEditReadOptionPatches(rows)',
  'variation_option_names',
  'rawOptionName',
  'Option name must be English',
  'data-field="shopee_option_image_url"',
  'shopee_option_image_url:',
  'main_image: representativeImageUrl || null',
  'plMasterEditRepresentativeImage(rows)',
  '대표 이미지 미리보기',
  'id="pl-master-edit-detail-images"',
  'plMasterEditRenderDetailImageManager(detailUrls)',
  'data-remove-detail-image',
  'id="pl-master-edit-detail-image-url"',
  'id="pl-master-edit-detail-image-file"',
  'function plMasterEditBindDetailImageControls',
  '상세 이미지',
  'async function plMasterEditCrawlStaronemallImages',
  'body: JSON.stringify({ urls: [url], write_to_source_records: false })',
  'result.observed_values',
  'async function plMasterEditRecrawlStaronemallImages',
  'plMasterEditCrawlStaronemallImages(url, { force, replace: force })',
  'plMasterEditCrawlStaronemallImages(url, { force: true, replace: true })',
  'plMasterEditSetDetailImageState(record.detail_image_urls, url, {',
  'plMasterEditSetRepresentativeImage(record.main_image_urls[0])',
  'const detailImages = plMasterEditDetailImageUrls(renderedRows)',
  'extra_images: detailImages',
  'data-master-option-image-file',
  'async function plMasterEditUploadOptionImage',
  "sdUploadProductImageFile(file, uploadRow, { kind: 'option' })",
  'async function plMasterEditUploadRepresentativeImage',
  "sdUploadProductImageFile(file, uploadRow, { kind: 'representative' })",
  'async function plMasterEditUploadDetailImage',
  "sdUploadProductImageFile(file, uploadRow, { kind: 'detail' })",
  '마스터 옵션 이미지 추가',
  'shopee_days_to_ship',
  'shopee_extra_attributes',
  "db.rpc('update_master_product_group'",
  'p_product_ids: rows.map((p) => p.id)',
  'p_group_patch: patch',
  'p_option_patches: optionPatches',
  'const productKind = productKindOfRow(rows[0]);',
  'const categoryDefaults = productKindDefaults(productKind);',
  'product_kind: productKind',
  'shopee_category_id: rows[0]?.shopee_category_id || categoryDefaults.shopee_category_id',
  'shopee_brand_id: rows[0]?.shopee_brand_id ?? 0',
  "shopee_brand_name: rows[0]?.shopee_brand_name || 'No Brand'",
]) {
  assert(editCode.includes(token), `master edit draft save/open flow missing token: ${token}`);
}

for (const token of [
  "document.getElementById('pl-master-edit-staronemall-url')?.addEventListener('input'",
  "document.getElementById('pl-master-edit-staronemall-url')?.addEventListener('change'",
  "document.getElementById('pl-master-edit-staronemall-recrawl')?.addEventListener('click'",
  "document.getElementById('pl-master-edit-representative-image-file')?.addEventListener('change'",
  'async function sdUploadProductImageFile',
  "const SD_PRODUCT_IMAGE_BUCKET = 'product-images'",
]) {
  assert(html.includes(token), `master edit StarOneMall URL binding missing token: ${token}`);
}

for (const removedToken of [
  "document.getElementById('pl-master-edit-category')",
  "document.getElementById('pl-master-edit-brand-id')",
  "document.getElementById('pl-master-edit-brand-name')",
  "document.getElementById('pl-master-edit-description')",
  'shopee_description:',
  'mrUploadMasterImageFile(file',
  'for (const item of optionPatches)',
  '.update(item.patch)',
]) {
  assert(!editCode.includes(removedToken), `master edit save/open flow still reads removed field: ${removedToken}`);
}

assert(
  !representativeSetter.includes('[data-field="main_image"]'),
  'representative image changes must not write into option image inputs',
);
assert(
  representativeSetter.includes('plMasterEditRepresentativeInput()'),
  'representative image changes must use the independent representative-image state',
);
assert(
  editCode.includes('row?.shopee_option_image_url || row?.main_image || row?._main_image'),
  'master edit option image display must fall back to persisted main_image for older StarOneMall-created rows',
);
assert(
  editCode.includes('const hasDraftDetailImages = plMasterEditDetailImageUrls(rows).length > 0')
    && editCode.includes('!(options.auto && hasDraftDetailImages)'),
  'master edit auto StarOneMall crawl must not merge new detail images over an existing draft detail image list',
);
assert(
  atomicSaveMigration.includes('create or replace function public.update_master_product_group')
    && atomicSaveMigration.includes('duplicate_sku_existing_product')
    && atomicSaveMigration.includes('grant execute on function public.update_master_product_group(uuid[], jsonb, jsonb) to authenticated'),
  'master edit atomic save RPC migration must validate SKU conflicts and grant authenticated execute',
);

console.log('v2 master edit draft modal checks passed');
