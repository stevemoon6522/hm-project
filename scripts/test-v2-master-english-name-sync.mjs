import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');

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

const modalHtml = sliceBetween(
  html,
  '<div class="modal-overlay" id="pl-master-edit-modal"',
  '<div id="toast">',
);

const syncCode = sliceBetween(
  html,
  'const SHOPEE_NAME_SYNC_REGIONS',
  'function plMasterEditReadJson',
);

const platformCode = sliceBetween(
  html,
  'function renderPlatformWorkbench(platform)',
  'function platformGroupKeysFromProductIds(productIds)',
);

for (const token of [
  'class="pl-master-edit-card pl-master-edit-name-sync-card"',
  'id="pl-master-edit-name-sync-global"',
  'id="pl-master-edit-tw-short-name" type="text" maxlength="60"',
  'id="pl-master-edit-name-sync-preview"',
  'id="pl-master-edit-name-sync-apply"',
  'id="pl-master-edit-name-sync-results"',
]) {
  assert(!modalHtml.includes(token), `master edit modal should not contain Shopee English name sync UI: ${token}`);
}

for (const token of [
  'data-shopee-name-sync',
  'openShopeeNameSyncPanel()',
  'function shopeeNameSyncPanelHtml()',
  'data-shopee-name-sync-preview',
  'data-shopee-name-sync-apply',
  'applyShopeeNameSyncFromPanel()',
  'plMasterEditBuildNameSyncPlan(rows, {',
  'applyShopeeNameSyncPlan(plan, {',
]) {
  assert(platformCode.includes(token), `Shopee tab missing English name sync UI/handler: ${token}`);
}

for (const token of [
  "const SHOPEE_NAME_SYNC_REGIONS = Object.freeze(['SG', 'TW', 'TH', 'MY', 'PH', 'BR'])",
  'const SHOPEE_NAME_REGION_LIMITS = Object.freeze({ TW: 60 })',
  'plMasterEditNameTargetForRegion(region, globalName, twShortName)',
  "region === 'TW' && globalChars > limit && !twShortName",
  "callBridgeMutation('set_global_sync_fields'",
  'name_and_description: true',
  'media_information: false',
  'tier_variation_name_and_option: true',
  'price: false',
  'days_to_ship: false',
  "callBridgeMutation('update_global_item'",
  'global_item_name: plan.globalName',
  "callBridgeMutation('update_shop_item_name'",
  'item_name: target.targetName',
  'plMasterEditNamesMatch(after.itemName, target.targetName)',
  'last_pushed_name: target.targetName',
  'const regionResults = plan.targets.map',
  "message: verified ? 'Changed'",
  'plMasterEditNameSyncResultsHtml(regionResults)',
  'async function applyShopeeNameSyncPlan(plan, hooks = {})',
  'Done: ${okCount}/${regionResults.length} regions',
]) {
  assert(syncCode.includes(token), `Shopee English name sync flow missing token: ${token}`);
}

assert(!syncCode.includes('SHOPEE_BANNED_SHOP_IDS'), 'Shopee English name sync must not use the legacy BR banned-shop guard');
assert(!syncCode.includes('<thead><tr><th>Target</th><th>Action</th><th>Status</th><th>Message</th></tr></thead>'), 'Shopee English name sync results must not render the full operation log table');

console.log('v2 Shopee English name sync checks passed');
