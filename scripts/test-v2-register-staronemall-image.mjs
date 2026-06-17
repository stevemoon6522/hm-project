import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const v1 = readFileSync(join(root, 'index.html'), 'utf8');
const v2 = readFileSync(join(root, 'v2/index.html'), 'utf8');

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

const v1ShopeeRegistration = sliceBetween(
  v1,
  'SHOPEE REGISTRATION',
  'async function _shopeeRegSubmit()',
);

for (const token of [
  "const STARPHOTOCARD_LAYER = './starphotocard-layer.png'",
  'async function applyShopLayer(productImageUrl)',
  '_normalizeShopeeImageUrl(assets.mainImage',
  "SHOPEE_BRIDGE + '/proxy_image?url=' + encodeURIComponent(src)",
]) {
  assert(v1ShopeeRegistration.includes(token), `V1 source behavior missing token: ${token}`);
}

assert(v1.includes('async function _joomScrapeAssets'), 'V1 StarOneMall helper must exist');
assert(v1.includes('scrapeStaronemallFull'), 'V1 must use full StarOneMall scrape helper');
assert(v1.includes("SHOPEE_BRIDGE + '/upload_image'"), 'V1 submit must upload composited image');
assert(v1.includes('image_base64: _shopeeRegCompositeDataUrl'), 'V1 must upload the composited data URL');

const registerView = sliceBetween(v2, '<div id="view-register"', '</div><!-- /view-register -->');
const modalHtml = sliceBetween(v2, '<div class="modal-overlay" id="register-modal"', '<script type="module">');

for (const token of [
  'id="w-staronemall-url"',
  'id="w-staronemall-refresh"',
  'id="w-staronemall-apply-cover"',
  'id="w-staronemall-status"',
  'id="w-staronemall-preview"',
  'id="w-image-ids"',
]) {
  assert(registerView.includes(token), `#view-register missing StarOneMall image token: ${token}`);
}

for (const token of [
  "const STARPHOTOCARD_LAYER = '/starphotocard-layer.png'",
  'const EXTENSION_IDS = [',
  'async function _sendToExtension',
  'async function _joomScrapeAssets',
  'scrapeStaronemallFull',
  'async function applyShopLayer(productImageUrl)',
  'function _normalizeShopeeImageUrl',
  'function isValidStaronemallUrl',
  'let registerStaronemallImageSeq = 0',
  'const REGISTER_MAX_IMAGE_IDS = 9',
  'function updateRegisterRepresentativeImageId',
  'function applyPendingRegisterCoverImage',
  'const SHOP_LAYER_CANVAS_SIZE = 1000',
  'const SHOP_LAYER_IMAGE_SIZE = 850',
  'const SHOP_LAYER_IMAGE_INSET = (SHOP_LAYER_CANVAS_SIZE - SHOP_LAYER_IMAGE_SIZE) / 2',
  "SHOPEE_BRIDGE + '/proxy_image?url=' + encodeURIComponent(src)",
  "SHOPEE_BRIDGE + '/upload_image'",
  'image_base64: dataUrl',
  'field.dispatchEvent(new Event(\'input\', { bubbles: true }))',
  'bindRegisterStaronemallImage();',
]) {
  assert(v2.includes(token), `V2 StarOneMall image flow missing token: ${token}`);
}

const invalidUrlBranch = sliceBetween(v2, 'if (!isValidStaronemallUrl(raw))', 'const normalizedUrl = normalizeStaronemallInput(raw);');
assert(invalidUrlBranch.includes('image_id_list는 변경되지 않았습니다'), 'invalid URL fallback must keep current image IDs');
assert(!invalidUrlBranch.includes('/upload_image'), 'invalid URL branch must not upload');
assert(!invalidUrlBranch.includes('scrapeStaronemallFull'), 'invalid URL branch must not scrape');

const applyShopLayerFn = sliceBetween(v2, 'async function applyShopLayer(productImageUrl)', 'function _normalizeShopeeImageUrl');
const safeBlobLoaderFn = sliceBetween(v2, 'async function _loadImageFromSafeBlobUrl', 'async function applyShopLayer(productImageUrl)');
assert(safeBlobLoaderFn.includes('URL.createObjectURL(blob)'), 'safe image loader must render fetched blobs through object URLs');
assert(safeBlobLoaderFn.includes("SHOPEE_BRIDGE + '/proxy_image?url=' + encodeURIComponent(url)"), 'safe image loader must fall back to shopee-bridge proxy for remote images');
assert(applyShopLayerFn.includes('_loadImageFromSafeBlobUrl(layerUrl)'), 'legacy Shopee layer compositing must load the layer as a blob to avoid tainted canvas');
assert(applyShopLayerFn.includes('_loadImageFromSafeBlobUrl(productImageUrl, AUTH_HEADERS)'), 'legacy Shopee layer compositing must load the product image as a blob to avoid tainted canvas');
assert(!applyShopLayerFn.includes('_loadImage(layerUrl, null)'), 'legacy Shopee layer compositing must not draw a direct cross-origin layer image');
assert(applyShopLayerFn.includes('canvas.width = SHOP_LAYER_CANVAS_SIZE'), 'legacy Shopee layer compositing must render to the 1000px shop layer canvas');
assert(applyShopLayerFn.includes('canvas.height = SHOP_LAYER_CANVAS_SIZE'), 'legacy Shopee layer compositing must keep a square 1000px canvas');
assert(applyShopLayerFn.includes('Math.max(SHOP_LAYER_IMAGE_SIZE / productImg.naturalWidth'), 'representative image must cover-crop into the 850px inner box');
assert(applyShopLayerFn.includes('ctx.rect(SHOP_LAYER_IMAGE_INSET, SHOP_LAYER_IMAGE_INSET, SHOP_LAYER_IMAGE_SIZE, SHOP_LAYER_IMAGE_SIZE)'), 'representative image must be clipped to a centered 850px box');
assert(applyShopLayerFn.includes('ctx.drawImage(layerImg, 0, 0, SHOP_LAYER_CANVAS_SIZE, SHOP_LAYER_CANVAS_SIZE)'), 'shop layer must be composited over the centered 850px representative image');

const masterCompositeFn = sliceBetween(v2, 'async function mrCompositeMainImage(mainImageUrl)', 'async function mrUploadRegionImages');
assert(masterCompositeFn.includes('const targetSize = SHOP_LAYER_CANVAS_SIZE'), 'master-register layer compositing must share the 1000px canvas constant');
assert(masterCompositeFn.includes('const innerSize  = SHOP_LAYER_IMAGE_SIZE'), 'master-register layer compositing must share the 850px inner image constant');
assert(masterCompositeFn.includes('const inset      = SHOP_LAYER_IMAGE_INSET'), 'master-register layer compositing must center the 850px image in the shop layer');

const bindHandler = sliceBetween(v2, 'function bindRegisterStaronemallImage()', 'function validateAllWizSteps');
assert(bindHandler.includes("input.addEventListener('input', schedule)"), 'input listener must stay bound for validation/status');
assert(bindHandler.includes("input.addEventListener('change', () =>"), 'change listener must stay bound for validation/status');
assert(bindHandler.includes("refreshBtn?.addEventListener('click', () =>"), 'explicit upload button must be bound');
const changeHandler = sliceBetween(bindHandler, "input.addEventListener('change', () =>", "refreshBtn?.addEventListener('click'");
assert(!changeHandler.includes('generateRegisterLayeredImageFromStaronemall'), 'change event must not generate/upload');
const inputSchedule = sliceBetween(bindHandler, 'const schedule = () => {', "input.addEventListener('input'");
assert(!inputSchedule.includes('/upload_image'), 'input debounce must not upload');
assert(!inputSchedule.includes('scrapeStaronemallFull'), 'input debounce must not scrape');
assert(inputSchedule.includes('Shopee Media 미적용'), 'input debounce must show non-applied status');
const clickHandler = sliceBetween(bindHandler, "refreshBtn?.addEventListener('click', () =>", "document.getElementById('w-staronemall-apply-cover')");
assert(clickHandler.includes('generateRegisterLayeredImageFromStaronemall'), 'only explicit button should generate/upload');

const updateImageIdFn = sliceBetween(v2, 'function updateRegisterRepresentativeImageId', 'async function uploadRegisterLayeredImage');
assert(updateImageIdFn.includes('const canApplyNow = !firstImageId || firstImageId === previousGenerated'), 'auto-apply must only allow empty or previously generated cover');
assert(updateImageIdFn.includes('pendingStaronemallImage'), 'manual cover collision must stage pending image');
assert(updateImageIdFn.includes('return { applied: false, pending: true }'), 'manual cover collision must not silently overwrite');
assert(updateImageIdFn.includes('Shopee Media 미적용'), 'pending state must show Shopee Media not-applied status');
assert(updateImageIdFn.includes('대표이미지 적용됨'), 'auto/apply state must show representative-image applied status');

const applyCoverFn = sliceBetween(v2, 'function applyPendingRegisterCoverImage', 'function updateRegisterRepresentativeImageId');
assert(applyCoverFn.includes('current[0] = pendingImageId'), 'Apply as cover must explicitly replace first image_id');
assert(applyCoverFn.includes('대표이미지 적용됨'), 'Apply as cover must announce cover application');

const validationFn = sliceBetween(v2, 'function validateWizStep', 'function g(id)');
assert(validationFn.includes('imgIds.length > REGISTER_MAX_IMAGE_IDS'), 'validation must enforce max 9 image IDs');
const addGlobalPayloadFn = sliceBetween(v2, 'function buildAddGlobalItemPayload()', 'function buildAddGlobalModelPayload');
assert(addGlobalPayloadFn.includes('readRegisterImageIds().slice(0, REGISTER_MAX_IMAGE_IDS)'), 'add_global_item payload must cap image_id_list at 9');
const publishPayloadFn = sliceBetween(v2, 'function buildCreatePublishTaskPayloads', 'function buildAllWizPayloads');
assert(publishPayloadFn.includes('image: { image_id_list: imageIdList }'), 'create_publish_task preview item must carry image.image_id_list');

for (const statusText of [
  'Shopee Media 업로드 실행됨',
  'Shopee Media 미적용',
  '대표이미지 적용됨',
  '확장프로그램 미사용',
]) {
  assert(v2.includes(statusText), `missing Korean UX status: ${statusText}`);
}

const saveHandler = sliceBetween(v2, 'window.handleWizSaveMaster', 'window.handleWizLiveSubmit');
assert(!saveHandler.includes('/upload_image'), 'master save must not upload images');
assert(!saveHandler.includes('/register_cbsc'), 'master save must not call legacy register');

assert(!modalHtml.includes('w-staronemall-url'), 'legacy #register-modal must not receive V2 StarOneMall URL field');
assert(modalHtml.includes('id="modal-submit"'), 'legacy #register-modal submit must remain present');

console.log('v2 register StarOneMall image static checks passed');
