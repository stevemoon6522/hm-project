import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2/index.html'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sliceBetween(source, start, end) {
  const s = source.indexOf(start);
  assert(s >= 0, `missing start token: ${start}`);
  const e = source.indexOf(end, s);
  assert(e > s, `missing end token after ${start}: ${end}`);
  return source.slice(s, e);
}

const registerView = sliceBetween(html, '<div id="view-register"', '</div><!-- /view-register -->');

const expectedOrder = [
  'basic-information',
  'specification',
  'sales-information',
  'shipping',
  'others-publish',
];
let lastIndex = -1;
for (const section of expectedOrder) {
  const token = `data-register-section="${section}"`;
  const index = registerView.indexOf(token);
  assert(index > lastIndex, `section order is wrong or missing: ${section}`);
  lastIndex = index;
}

for (const id of [
  'w-staronemall-url',
  'w-staronemall-refresh',
  'w-staronemall-status',
  'w-staronemall-preview',
  'w-image-ids',
  'w-item-name',
  'w-category-id',
  'w-description',
  'w-brand-name',
  'w-brand-id',
  'w-condition',
  'w-retail-price',
  'w-purchase-cost',
  'w-member-count',
  'w-bundle-albums',
  'w-bundle-cards',
  'w-bundle-set-price',
  'w-original-price',
  'w-stock',
  'w-weight',
  'w-pkg-length',
  'w-pkg-width',
  'w-pkg-height',
  'w-days-to-ship',
]) {
  const matches = registerView.match(new RegExp(`id="${id}"`, 'g')) || [];
  assert(matches.length === 1, `${id} must appear exactly once inside #view-register`);
}

for (const token of [
  'id="w-flow-panel"',
  'id="w-flow-status-label"',
  'id="w-flow-badge-draft"',
  'id="w-flow-badge-validated"',
  'id="w-flow-badge-publish-ready"',
  'id="w-publish-blockers"',
  'id="w-save-master-btn"',
  'id="w-publish-shopee-btn"',
  'Master Data 저장',
  'Shopee 발행 미리보기',
]) {
  assert(registerView.includes(token), `register flow UI missing token: ${token}`);
}

for (const token of [
  'registerFlow',
  "state: 'draft'",
  'validatedAt',
  'savedAt',
  'savedProductIds',
  'registerPublishBlockers',
  'saveRegisterMasterData',
  'register_master_save',
  "actor: 'v2-register'",
  "payload.lifecycle_state = 'pre_order'",
  "payload_hash: payloadHash",
]) {
  assert(html.includes(token), `master-data-first flow missing token: ${token}`);
}

assert(html.includes('const TOTAL_STEPS = 5'), 'wizard must manage all five Seller Centre sections');

const saveHandler = sliceBetween(html, 'window.handleWizSaveMaster', 'window.handleWizLiveSubmit');
assert(saveHandler.includes('validateAllWizSteps(false)'), 'default save must validate master sections first');
assert(saveHandler.includes('saveRegisterMasterData(payloads)'), 'default save must persist master data');
assert(!saveHandler.includes('showWizModal'), 'default save must not open Shopee publish modal');
assert(!saveHandler.includes('/register_cbsc'), 'default save must not call legacy direct register path');
assert(!saveHandler.includes('callBridgeMutation'), 'default save must not call Shopee bridge mutations');

const registerRows = sliceBetween(html, 'function registerMasterRowsFromPayloads(payloads) {', 'function registerProductPayload');
assert(registerRows.includes('const representativeImageUrl = registerMasterRepresentativeImageUrl()'), 'master save rows must preserve the applied representative image URL');
assert(registerRows.includes('const detailImageUrls = registerMasterDetailImageUrls()'), 'master save rows must preserve StarOneMall detail images');
assert(registerRows.includes('...(representativeImageUrl ? { main_image: representativeImageUrl } : {})'), 'master save rows must write products.main_image when an applied URL exists');
assert(registerRows.includes('...(detailImageUrls.length ? { extra_images: detailImageUrls } : {})'), 'master save rows must write products.extra_images when detail images exist');
assert(registerRows.includes('...(imageIds[0] ? { shopee_image_id: imageIds[0] } : {})'), 'master save rows must retain the applied Shopee cover image_id');

const registerPayload = sliceBetween(html, 'function registerProductPayload(row, mode = \'insert\', includeLifecycle = true) {', 'async function registerUpdateProductWithFallback');
assert(registerPayload.includes("Object.prototype.hasOwnProperty.call(row, 'main_image')"), 'products insert/update payload must include representative image URL only when provided');
assert(registerPayload.includes("Object.prototype.hasOwnProperty.call(row, 'extra_images')"), 'products insert/update payload must include detail images only when provided');
assert(registerPayload.includes("Object.prototype.hasOwnProperty.call(row, 'shopee_image_id')"), 'products insert/update payload must include Shopee cover image_id only when provided');

const publishHandler = sliceBetween(html, 'window.handleWizLiveSubmit', 'let _lastWizPayloads = null;');
assert(publishHandler.includes('state.registerFlow.savedAt'), 'Shopee publish must require completed master save');
assert(publishHandler.includes('state.registerFlow.dirty'), 'Shopee publish must block dirty unsaved edits');
assert(publishHandler.includes('showWizModal(p, true)'), 'Shopee publish must be an explicit secondary modal action');

const mrImageListBlock = sliceBetween(html, 'const globalImageRegion = publishRegions.includes', 'const pathAEnabled = probeImageOk && !group.twoAxis;');
assert(mrImageListBlock.includes("const globalImageRegion = publishRegions.includes('SG') ? 'SG' : publishRegions[0]"), 'master register must pick SG image ids for the global product when available');
assert(mrImageListBlock.includes('const globalImageIdList = buildImageIdList(globalImageRegion).slice(0, REGISTER_MAX_IMAGE_IDS)'), 'master register must build a top-level Product Image list for add_global_item');
const mrTargetVariationBlock = sliceBetween(html, 'const buildTargetVariationModels = (rgn) => {', '// 5. Title / description from observed');
assert(mrTargetVariationBlock.includes('buildImageIdList(rgn).slice(0, REGISTER_MAX_IMAGE_IDS)'), 'master register publish targets must cap per-region Product Image ids at 9');
assert(mrTargetVariationBlock.includes('rshComputeRegionPrice(Number(vOpt.cost_krw || 0)'), 'master register must compute target-region option prices before publish');
assert(mrTargetVariationBlock.includes('variation:      { tier_variation: tierVariation, model: targetModels }'), 'master register must attach target-region variation models to each publish target');

const mrCbscBody = sliceBetween(html, 'const cbscBody = {', "console.log('[mrPromoteAll] register_cbsc payload:'");
assert(mrCbscBody.includes('image_id:          globalImageIdList[0]'), 'master register must send the representative image id to register_cbsc');
assert(mrCbscBody.includes('image_id_list:     globalImageIdList.length ? globalImageIdList : undefined'), 'master register must send detail image ids to global Product Image');

const modalHtml = sliceBetween(html, '<div class="modal-overlay" id="register-modal"', '<script type="module">');
assert(modalHtml.includes('id="modal-submit"'), '#register-modal must remain present');
assert(html.includes('/register_cbsc'), 'legacy #register-modal compatibility path must remain untouched');

console.log('v2 register master-data-first static checks passed');
