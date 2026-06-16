import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2/index.html'), 'utf8');
const bridge = readFileSync(join(root, 'supabase/functions/shopee-bridge/index.ts'), 'utf8');
const edgeBridge = readFileSync(join(root, 'edge-functions/shopee-bridge/index.ts'), 'utf8');
const migration = readFileSync(join(root, 'supabase/migrations/202605140001_v2_ready_stock_transition.sql'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const id of [
  'view-pre-order',
  'po-search',
  'po-region-filters',
  'po-body',
  'po-refresh',
  'po-ready-stock-open',
  'wiz-modal-overlay',
  'wiz-modal-confirm-btn',
]) {
  assert(html.includes(`id="${id}"`), `${id} is missing from v2 UI`);
}

assert(!html.includes('id="view-ready-stock"'), 'READY STOCK must stay inside the PRE ORDER tab');
assert(!html.includes("showView('view-ready-stock')"), 'READY STOCK routing must not use a separate view');
assert(!html.includes('onclick="openReadyStockWizard('), 'PRE ORDER row actions must pass product IDs via data attributes');

for (const token of [
  'READY_STOCK_REGION_DTS',
  'READY_STOCK_SYNC_REGIONS',
  'readyStockDtsForRegion',
  'readyOptionNamesForProduct',
  'readyOptionNameEnglishIssues',
  'readyOptionNamePreview',
  'readyAddRowError',
  'buildReadyDtsOnlyPlan',
  'showReadyDtsOnlyModal',
  'applyReadyDtsOnlyTransition',
  'readyFetchActiveShopeeSyncShops',
  'readyVerifyShopItemNames',
  'readyLooksReadyStockName',
  'readyLooksPreOrderName',
  'productNameNeedsReadyStock',
  'productCanRunReadyStockNameDts',
  'set_global_sync_fields',
  'update_global_item',
  'global_item_name',
  'update_shop_item_name',
  'update_shop_item_dts',
  'Option names must be English before READY STOCK sync',
  'Option names also sync through tier_variation_name_and_option',
  "lifecycle_state: 'ready_stock'",
  "title_state: 'READY_STOCK'",
  'last_pushed_name',
]) {
  assert(html.includes(token), `READY STOCK transition missing ${token}`);
}

const mapMatch = html.match(/const READY_STOCK_REGION_DTS = Object\.freeze\((\{[\s\S]*?\})\);/);
assert(mapMatch, 'READY_STOCK_REGION_DTS map is missing');
const readyMap = Object.fromEntries([...mapMatch[1].matchAll(/([A-Z]{2}):\s*(\d+)/g)].map(([, region, value]) => [region, Number(value)]));
const expected = { SG: 2, TW: 1, TH: 2, MY: 2, PH: 2, BR: 3 };
for (const [region, value] of Object.entries(expected)) {
  assert(readyMap[region] === value, `READY_STOCK_REGION_DTS.${region} must be ${value}, got ${readyMap[region]}`);
}
assert(html.includes("const READY_STOCK_SYNC_REGIONS = Object.freeze(['SG', 'TW', 'TH', 'MY', 'PH', 'BR'])"), 'READY STOCK sync regions must include BR');
assert(html.includes('ESTOQUE\\s*PRONTO'), 'READY STOCK verification must accept BR localized ready-stock label');
assert(html.includes('現貨'), 'READY STOCK verification must accept TW localized ready-stock label');

const readyFetchShopsMatch = html.match(/async function readyFetchActiveShopeeSyncShops\(\) \{([\s\S]*?)\n  \}/);
assert(readyFetchShopsMatch, 'readyFetchActiveShopeeSyncShops function is missing');
assert(
  !readyFetchShopsMatch[1].includes('SHOPEE_BANNED_SHOP_IDS'),
  'READY STOCK sync shop discovery must not exclude BR via the legacy banned-shop guard',
);

const openMatch = html.match(/function openReadyStockWizard\(productId\) \{([\s\S]*?)\n  \}/);
assert(openMatch, 'openReadyStockWizard function is missing');
assert(openMatch[1].includes('showReadyDtsOnlyModal(ids)'), 'openReadyStockWizard must open the DTS-only modal directly');
assert(!openMatch[1].includes('renderReadyStockView'), 'openReadyStockWizard must not open the old multi-step wizard');
assert(!openMatch[1].includes('rswWeights'), 'openReadyStockWizard must not reset weight inputs');
assert(!openMatch[1].includes('rswSkus'), 'openReadyStockWizard must not reset SKU inputs');

const productListReadyButtonMatch = html.match(/function updateProductListReadyStockButton\(lifecycleFilter\) \{([\s\S]*?)\n  \}/);
assert(productListReadyButtonMatch, 'product-list READY STOCK button sync function is missing');
assert(
  productListReadyButtonMatch[1].includes('productListReadyStockSelectedIds()'),
  'product-list READY STOCK button must use productListSelectedIds, not PRE ORDER tab selection state',
);
assert(
  productListReadyButtonMatch[1].includes('canOpenFromSelection'),
  'product-list READY STOCK button must show when selected rows still need a READY STOCK name push',
);
assert(
  productListReadyButtonMatch[1].includes('btn.disabled = count === 0'),
  'product-list READY STOCK button must enable when selected READY STOCK name+DTS rows exist',
);

const productListReadySelectedMatch = html.match(/function productListReadyStockSelectedIds\(\) \{([\s\S]*?)\n  \}/);
assert(productListReadySelectedMatch, 'product-list READY STOCK selected-id filter is missing');
assert(
  productListReadySelectedMatch[1].includes('productCanRunReadyStockNameDts(product)'),
  'product-list READY STOCK selected IDs must include lifecycle PRE ORDER rows and name-stale READY STOCK rows',
);
assert(
  html.includes("productLifecycleFilterKey(product) === 'ready_stock' && !!primaryListing(product)?.global_item_id"),
  'product-list READY STOCK selected IDs must also allow mapped READY_STOCK rows for stale region-name recovery',
);

const productListReadyOpenMatch = html.match(/function openProductListReadyStockModal\(\) \{([\s\S]*?)\n  \}/);
assert(productListReadyOpenMatch, 'product-list READY STOCK click handler is missing');
assert(
  productListReadyOpenMatch[1].includes('showReadyDtsOnlyModal(productListReadyStockSelectedIds())'),
  'product-list READY STOCK click must open DTS-only modal with product-list selected IDs',
);

const toolbarOpenMatch = html.match(/function openReadyStockToolbarModal\(\) \{([\s\S]*?)\n  \}/);
assert(toolbarOpenMatch, 'READY STOCK toolbar click router is missing');
assert(
  toolbarOpenMatch[1].includes('productListSelectionReady'),
  'READY STOCK toolbar click must route product-list name-stale selections to the product-list modal',
);

const bulkUiMatch = html.match(/function updateBulkDeleteUi\(\) \{([\s\S]*?)\n  \}/);
assert(bulkUiMatch, 'product-list selection UI sync function is missing');
assert(
  bulkUiMatch[1].includes('updateProductListReadyStockButton'),
  'product-list checkbox changes must refresh READY STOCK button enabled state',
);

const dtsSlice = html.slice(
  html.indexOf('function buildReadyDtsOnlyPlan'),
  html.indexOf('function listingTargetSummary'),
);
assert(dtsSlice.includes("callBridgeMutation('set_global_sync_fields'"), 'READY STOCK flow must enable global sync fields before renaming');
assert(html.includes('tier_variation_name_and_option: true'), 'READY STOCK flow must sync option names from Global Product');
assert(dtsSlice.includes('readyOptionNameEnglishIssues(product)'), 'READY STOCK flow must validate option names before sync');
assert(dtsSlice.includes("callBridgeMutation('update_global_item'"), 'READY STOCK flow must update global item name+DTS');
assert(dtsSlice.includes('global_item_name: call.newName'), 'READY STOCK flow must send global_item_name');
assert(dtsSlice.includes("callBridgeMutation('update_shop_item_name'"), 'READY STOCK flow must fall back to shop item name updates when sync readback is stale');
assert(!dtsSlice.includes('SHOPEE_BANNED_SHOP_IDS'), 'READY STOCK readback/fallback must include BR instead of skipping legacy banned-shop ids');
assert(dtsSlice.includes('days_to_ship: 1'), 'global catalog DTS baseline must be days_to_ship=1');
assert(dtsSlice.includes('days_to_ship: call.daysToShip'), 'shop-level DTS must use region-specific daysToShip');
assert(dtsSlice.includes('days_to_ship: daysToShip'), 'DB listing update must store region-specific days_to_ship');
assert(dtsSlice.includes('product_name: pushedName'), 'DB product update must store the READY STOCK master product name');
assert(dtsSlice.includes('readyVerifyShopItemNames'), 'READY STOCK flow must verify region shop item names after sync');
assert(!dtsSlice.includes('update_global_price'), 'DTS-only flow must not update price');
assert(!dtsSlice.includes('update_global_model'), 'DTS-only flow must not update model SKU or weight');
assert(!dtsSlice.includes('update_tier_variation'), 'READY STOCK flow must not call deprecated shop-level tier variation update');
assert(!dtsSlice.includes('weight_g:'), 'DTS-only flow must not update product weight');
assert(!dtsSlice.includes('sku:'), 'DTS-only flow must not update product SKU');

for (const source of [bridge, edgeBridge]) {
  assert(source.includes("if (action === 'update_global_dts'"), 'bridge must keep update_global_dts action');
  assert(source.includes("if (action === 'update_shop_item_dts'"), 'bridge must keep update_shop_item_dts action');
  assert(source.includes("'set_global_sync_fields'"), 'bridge must expose set_global_sync_fields action');
  assert(source.includes("'update_shop_item_name'"), 'bridge must expose update_shop_item_name action');
  assert(source.includes('body: payload, account_key: accountKey'), 'bridge must execute logged shop item update payloads');
  assert(source.includes('hydrateUpdateGlobalItemPayload'), 'bridge must hydrate update_global_item required image ids');
  assert(!source.includes("blockedFields.push('global_item_name')"), 'documented global_item_name must not be blocked by probe preflight');
  assert(source.includes('pre_order: { is_pre_order, days_to_ship }'), 'bridge must send is_pre_order + days_to_ship');
  assert(source.includes('const READY_STOCK_GLOBAL_DTS = 1'), 'bridge must fix READY STOCK Global Product DTS at 1');
  assert(source.includes('const PRE_ORDER_GLOBAL_DTS = 10'), 'bridge must fix PRE ORDER Global Product DTS at 10');
  assert(source.includes('function resolveGlobalProductDts'), 'bridge must resolve Global Product DTS by lifecycle');
  assert(!source.includes('clampReadyStockDts(targetInputs[0]?.days_to_ship'), 'bridge must not derive Global Product DTS from the first region target');
}

for (const token of [
  'lifecycle_state',
  'days_to_ship',
  'title_state',
  'last_pushed_at',
]) {
  assert(migration.includes(token), `migration missing ${token}`);
}

console.log('v2 READY STOCK name+DTS transition static checks passed');
