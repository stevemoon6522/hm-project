import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'v2', 'index.html'), 'utf8');
const shopeeBridge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'shopee-bridge', 'index.ts'), 'utf8');
const qoo10Bridge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'qoo10-bridge', 'index.ts'), 'utf8');
const joomBridge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'joom-bridge', 'index.ts'), 'utf8');

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`${label} missing: ${needle}`);
  }
}

assertIncludes(html, "master_sync: '마스터 변경 적용'", 'action label');
assertIncludes(html, 'data-platform-preview="master_sync"', 'toolbar button');
assertIncludes(html, 'function platformNeedsUpdateGroups', 'needs-update group resolver');
assertIncludes(html, 'function platformNeedsUpdateKeys', 'needs-update key resolver');
assertIncludes(html, 'data-platform-master-sync-needed', 'needs-update toolbar action');
assertIncludes(html, "platformOpenAction(platform, 'master_sync', platformNeedsUpdateKeys(platform))", 'needs-update action handler');
assertIncludes(html, 'platformMasterSyncValidation(platform, group)', 'preview validation');
assertIncludes(html, 'platformApplyMasterSync(platform, group)', 'preview executor');
assertIncludes(html, 'platformApplyShopeeMasterSync', 'Shopee executor');
assertIncludes(html, 'platformApplyJoomMasterSync', 'Joom executor');
assertIncludes(html, 'platformApplyQoo10MasterSync', 'Qoo10 executor');
assertIncludes(html, 'platformApplyEbayMasterSync', 'eBay executor');
assertIncludes(html, 'sync-master-content', 'eBay master content sync route');
assertIncludes(html, 'rshBuildLayeredCoverDataUrl', 'Shopee layered representative image upload');
assertIncludes(html, 'platformShopeeUploadProductImageRefs', 'Shopee product image ref uploader');
assertIncludes(html, 'platformApplyShopeeOptionImageSync', 'Shopee option image sync executor');
assertIncludes(html, 'platformShopeeBuildOptionImageAssignments', 'Shopee option image assignment mapper');
assertIncludes(html, 'verify_shop_option_images_after_update', 'Shopee option image readback verification');
assertIncludes(html, 'platformMasterSyncJoomVariantImages(group)', 'Joom variant image payload');
assertIncludes(html, 'edit-image', 'Qoo10 representative image update');
assertIncludes(html, 'edit-multi-image', 'Qoo10 detail image update');
assertIncludes(html, 'update-master-fields', 'Joom master field update');

const globalItemIdStart = html.indexOf('function platformMasterSyncShopeeGlobalItemId');
const globalItemIdEnd = html.indexOf('function platformMasterSyncFieldLabels', globalItemIdStart);
if (globalItemIdStart < 0 || globalItemIdEnd <= globalItemIdStart) {
  throw new Error('Shopee global_item_id resolver block missing');
}
const globalItemIdBlock = html.slice(globalItemIdStart, globalItemIdEnd);
if (globalItemIdBlock.includes('row.shopee_item_id')) {
  throw new Error('Shopee master sync must not use shop item id as global_item_id fallback');
}

const shopeeApplyStart = html.indexOf('async function platformApplyShopeeMasterSync');
const shopeeApplyEnd = html.indexOf('async function platformApplyJoomMasterSync', shopeeApplyStart);
if (shopeeApplyStart < 0 || shopeeApplyEnd <= shopeeApplyStart) {
  throw new Error('Shopee master sync executor block missing');
}
const shopeeApplyBlock = html.slice(shopeeApplyStart, shopeeApplyEnd);
if (shopeeApplyBlock.includes('update_shop_item_description')) {
  throw new Error('Shopee master sync must not repair shop-level descriptions; Global Product owns descriptions');
}
if (!shopeeApplyBlock.includes("callBridgeMutation('update_global_item'")) {
  throw new Error('Shopee master sync must call update_global_item');
}
if (!shopeeApplyBlock.includes('platformApplyShopeeOptionImageSync')) {
  throw new Error('Shopee master sync must call shop-level option image sync because Global Product update has no option-image field');
}

const shopeeOptionImageSyncStart = html.indexOf('async function platformApplyShopeeOptionImageSync');
const shopeeOptionImageSyncEnd = html.indexOf('async function platformApplyShopeeMasterSync', shopeeOptionImageSyncStart);
if (shopeeOptionImageSyncStart < 0 || shopeeOptionImageSyncEnd <= shopeeOptionImageSyncStart) {
  throw new Error('Shopee option image sync block missing');
}
const shopeeOptionImageSyncBlock = html.slice(shopeeOptionImageSyncStart, shopeeOptionImageSyncEnd);
if (!shopeeOptionImageSyncBlock.includes("callBridgeMutation('update_shop_tier_variation'")) {
  throw new Error('Shopee option image sync must use update_shop_tier_variation');
}
if (!shopeeOptionImageSyncBlock.includes('platformShopeeBuildTierImageUpdatePayload')) {
  throw new Error('Shopee option image sync must preserve current tier payload IDs while injecting image IDs');
}

const shopeeUploadStart = html.indexOf('async function platformShopeeUploadImageRef');
const shopeeUploadEnd = html.indexOf('async function platformShopeeUploadProductImageRefs', shopeeUploadStart);
if (shopeeUploadStart < 0 || shopeeUploadEnd <= shopeeUploadStart) {
  throw new Error('Shopee master sync image ref uploader missing');
}
const shopeeUploadBlock = html.slice(shopeeUploadStart, shopeeUploadEnd);
if (!shopeeUploadBlock.includes('rshBuildLayeredCoverDataUrl')) {
  throw new Error('Shopee representative image upload must build the layered cover before upload_image');
}

assertIncludes(shopeeBridge, 'image_id_list required', 'Shopee image-only update guard');
assertIncludes(shopeeBridge, "finalPayload.image?.image_id_list?.length", 'Shopee degraded payload image guard');
assertIncludes(qoo10Bridge, 'ItemsContents.EditGoodsImage', 'Qoo10 EditGoodsImage bridge');
assertIncludes(qoo10Bridge, 'ItemsContents.EditGoodsMultiImage', 'Qoo10 EditGoodsMultiImage bridge');
assertIncludes(joomBridge, 'operation: "update-master-fields"', 'Joom update-master-fields bridge');
assertIncludes(joomBridge, 'variant_image_audit', 'Joom variant image audit');
assertIncludes(joomBridge, 'updatePayload.variants = matchedVariants', 'Joom safe variant image update');

console.log('v2 platform master sync checks passed');
