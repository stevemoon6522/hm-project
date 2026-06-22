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
assertIncludes(html, 'platformMasterSyncValidation(platform, group)', 'preview validation');
assertIncludes(html, 'platformApplyMasterSync(platform, group)', 'preview executor');
assertIncludes(html, 'platformApplyShopeeMasterSync', 'Shopee executor');
assertIncludes(html, 'platformApplyJoomMasterSync', 'Joom executor');
assertIncludes(html, 'platformApplyQoo10MasterSync', 'Qoo10 executor');
assertIncludes(html, 'update_shop_tier_variation', 'Shopee option image update');
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

assertIncludes(shopeeBridge, 'image_id_list required', 'Shopee image-only update guard');
assertIncludes(shopeeBridge, "finalPayload.image?.image_id_list?.length", 'Shopee degraded payload image guard');
assertIncludes(qoo10Bridge, 'ItemsContents.EditGoodsImage', 'Qoo10 EditGoodsImage bridge');
assertIncludes(qoo10Bridge, 'ItemsContents.EditGoodsMultiImage', 'Qoo10 EditGoodsMultiImage bridge');
assertIncludes(joomBridge, 'operation: "update-master-fields"', 'Joom update-master-fields bridge');
assertIncludes(joomBridge, 'variant_image_audit', 'Joom variant image audit');
assertIncludes(joomBridge, 'updatePayload.variants = matchedVariants', 'Joom safe variant image update');

console.log('v2 platform master sync checks passed');
