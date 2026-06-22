import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const bridge = readFileSync(join(root, 'supabase', 'functions', 'shopee-bridge', 'index.ts'), 'utf8');

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

const restoreCode = sliceBetween(
  html,
  'function openShopeeEnglishRestorePanel()',
  'function platformGroupKeysFromProductIds',
);

const restoreApplyCode = sliceBetween(
  html,
  'function shopeeEnglishRestorePayload',
  'async function plMasterEditApplyNameSync',
);

for (const token of [
  'data-shopee-english-restore',
  'TW/TH/BR 영어 복원',
  'function openShopeeEnglishRestorePanel()',
  'function shopeeEnglishRestorePanelHtml()',
  'async function applyShopeeEnglishRestoreFromPanel()',
  'data-shopee-english-restore-apply',
]) {
  assert(html.includes(token), `Shopee English restore UI missing token: ${token}`);
}

assert(
  html.includes("const SHOPEE_ENGLISH_RESTORE_REGIONS = Object.freeze(['TW', 'TH', 'BR'])"),
  'English restore regions must be limited to TW, TH, BR',
);

for (const token of [
  "platformActionGroups('shopee')",
  'groups.map(platformGroupKey)',
  'state.shopeeNameSync = null',
]) {
  assert(restoreCode.includes(token), `Shopee English restore panel missing token: ${token}`);
}

for (const token of [
  "shopeeEnglishRestoreFetch('global_item_info'",
  'shopeeEnglishRestoreGlobalItemName(globalInfo)',
  "shopeeEnglishRestoreFetch('global_model_list'",
  'shopeeEnglishRestoreTiers(shopeeEnglishRestorePayload(globalModelJson))',
  "shopeeEnglishRestoreFetch('published_list'",
  "shopeeEnglishRestoreFetch('shop_model_list'",
  "callBridgeMutation('update_shop_item_name'",
  "callBridgeMutation('update_shop_tier_variation'",
  'verify_option_names_after_update',
  'tier_variation_name_and_option: true',
]) {
  assert(restoreApplyCode.includes(token), `Shopee English restore workflow missing token: ${token}`);
}

for (const token of [
  "'update_shop_tier_variation'",
  "if (action === 'update_shop_tier_variation')",
  "/api/v2/product/update_tier_variation",
  'standardise_tier_variation[] or tier_variation[] required',
  'sent_tier_count',
  'v2.product.update_tier_variation.json',
]) {
  assert(bridge.includes(token), `Shopee bridge tier variation action missing token: ${token}`);
}

console.log('v2 Shopee English restore checks passed');
