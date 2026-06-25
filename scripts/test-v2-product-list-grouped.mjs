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

function extractFunction(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert(start >= 0, `missing function: ${name}`);
  const open = source.indexOf('{', start);
  assert(open > start, `missing function body: ${name}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function: ${name}`);
}

const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');

const loadData = sliceBetween(
  html,
  'async function loadData() {',
  'if (productsRes.error',
);
const productView = sliceBetween(
  html,
  '<div id="view-products" class="view active">',
  '</div><!-- /view-products -->',
);
const productList = sliceBetween(
  html,
  'function renderProducts() {',
  'function beginEditCell(cell) {',
);
const bulkDeleteUi = sliceBetween(
  html,
  'function updateBulkDeleteUi() {',
  'async function bulkDeleteSelectedProducts() {',
);
const plGroupMainImageSource = extractFunction(html, 'plGroupMainImage');

assert(productView.includes('<table class="pl-table">'), 'product list table must use wrapping table class');
assert(productView.includes('Official Barcode'), 'master table must expose official barcode after the product name');
assert(productView.includes('Vars'), 'master table must expose variation count');
assert(productView.includes('WMS'), 'master table must expose WMS match status');
assert(!productView.includes('data-master-register-open="custom"'), 'custom registration must live inside the new master registration panel');
assert(!productView.includes('data-master-register-open="url"'), 'URL bulk registration must live inside the new master registration panel');
assert(html.includes("requestedViewId === 'view-register' ? 'view-products' : requestedViewId"), 'legacy register view routing must activate the master product page');
assert(html.includes("if (requestedViewId === 'view-register')") && html.includes("openMasterRegisterPanel('global')"), 'legacy register view routing must open the unified master register panel');
assert(html.includes('.pl-group-row'), 'group row styling must exist');
assert(html.includes('.pl-option-row'), 'option row styling must exist');
assert(html.includes('productListExpandedGroups: new Set()'), 'expanded group state must be tracked');
assert(html.includes('productListSelectedIds: new Set()'), 'product list selected IDs must be tracked outside the DOM');
assert(html.includes('wmsInventoryBySku: new Map()'), 'product list must keep WMS inventory matches outside the DOM');
assert(html.includes('function plLoadWmsInventoryForProducts(products)'), 'product list must load WMS inventory matches by SKU');

const createdAtOrderIndex = loadData.indexOf(".order('created_at', { ascending: false })");
const groupOrderIndex = loadData.indexOf(".order('product_group_id'");
const tierOrderIndex = loadData.indexOf(".order('variation_tier_index'");
assert(createdAtOrderIndex >= 0, 'product loading must request newest products first');
assert(
  groupOrderIndex < 0 || createdAtOrderIndex < groupOrderIndex,
  'created_at DESC must be the primary product loading order before group_id',
);
assert(
  tierOrderIndex < 0 || createdAtOrderIndex < tierOrderIndex,
  'created_at DESC must be the primary product loading order before variation tier',
);
assert(
  html.includes('state.products = plSortProductsNewestFirst(productsRes.data || [])'),
  'loaded products must be locally normalized to newest-first even if the API order changes',
);

for (const token of [
  'function plBuildProductGroups(rows)',
  'function plProductCreatedTime(product)',
  'function plGroupCreatedTime(group)',
  'function plCompareProductGroupsNewestFirst(a, b)',
  'function plSortProductGroupsNewestFirst(groups)',
  'function renderProductGroup(group)',
  'function renderProductOptionRow(p, groupKey, isGroupChild)',
  'function plParentSku(rows)',
  'function plGroupMainImage(rows)',
  'function plProductName(product)',
  'function plSetProductSelected(productId, selected)',
  'function plVisibleRenderedProductIds()',
  'function plGroupPlatformCell(rows, platform)',
  'function plOfficialBarcodeCell(rows)',
  'function plWmsStatusCell(rows)',
  'function plActionButtonsHtml(editTarget, deleteIds, label)',
  'function plComputedSetNumber(row, groupRows, field)',
  'function plDisplayWeightCell(row, groupRows)',
  'openProductMasterEditModal',
  'data-group-toggle',
  'data-edit-master',
  'class="pl-group-check"',
  'class="pl-row-check"',
]) {
  assert(productList.includes(token), `grouped product list must include ${token}`);
}

assert(
  productList.includes('group.isGrouped ? renderProductGroup(group) : renderProductOptionRow'),
  'renderProducts must route grouped variants through the master group renderer',
);
assert(
  productList.includes('return plSortProductGroupsNewestFirst(groups)')
    && !productList.includes('return groups.sort((a, b) => a.firstIndex - b.firstIndex)'),
  'master groups must sort by newest registration time, not by first visible source index',
);
assert(
  html.includes('function plImageUrlFromShopeeId(imageId)')
    && html.includes('https://cf.shopee.sg/file/${id}'),
  'product thumbnails must fall back to saved Shopee image_id when no master image URL exists',
);
assert(
  html.includes('function plGroupSharedMainImageValues(rows)')
    && productList.includes('function plAllRowsForGroup(product, groupRows)')
    && productList.includes('const fullRows = plGroupRowsById(groupId)')
    && productList.includes('function plGroupMainImage(rows)')
    && !plGroupMainImageSource.includes('._main_image')
    && !plGroupMainImageSource.includes('.shopee_option_image_url')
    && productList.includes('${plProductThumb(first, rows)}'),
  'group master thumbnails must use shared representative images only, not row option images',
);
assert(
  productList.includes('rows.map((row) => renderProductOptionRow(row, group.key, true))'),
  'group renderer must render child option rows under the master row',
);
assert(
  productList.includes('!product?.product_group_id')
    && productList.includes('product.global_model_id')
    && productList.includes('variation_option_names'),
  'group detection must keep Shopee Global option rows grouped even when Shopee omits tier metadata',
);
assert(
  productList.includes("!state.productListExpandedGroups.has(group.key)")
    && productList.includes('state.productListExpandedGroups.add(groupKey)')
    && productList.includes('state.productListExpandedGroups.delete(groupKey)'),
  'group rows must be expandable/collapsible',
);
assert(
  productList.includes("const typeLabel = plVariantTypeLabel(p)")
    && productList.includes("pl-status-pill ${typeLabel === 'SET' ? 'info' : 'neutral'}")
    && !productList.includes('data-open="${text(p.id)}"')
    && !productList.includes('data-open-shopee-single="${text(p.id)}"'),
  'variant option rows must not show legacy or platform Register buttons in the master table',
);
assert(
  html.includes('.pl-status-pill.missing')
    && !html.includes('.pl-status-pill.empty')
    && productList.includes("key: 'missing'")
    && productList.includes('data-delete-ids="${text(ids.join(\',\'))}"'),
  'WMS status pills must use scoped status classes and action deletes must carry exact product ids',
);
assert(
  productList.includes("plActionButtonsHtml(first.product_group_id || first.id || '', productIds, productName)")
    && productList.includes("plActionButtonsHtml(plMasterEditTargetKey(p), [p.id], p.sku || productName)")
    && !productList.includes('const editButton = !isGroupChild')
    && !productList.includes('</span>${editButton}</span>'),
  'master edit/delete buttons must live in the Actions column for grouped and single rows',
);
assert(
  productList.includes("isGroupChild ? '<span class=\"pl-cell-label\">SP Barcode</span>' + text(spBarcode || '-') : plOfficialBarcodeCell([p])")
    && !productList.includes("isGroupChild ? 'SP Barcode' : 'Official Barcode'"),
  'Official Barcode cells must use one value-only format on master rows',
);
assert(
  html.includes('id="platform-shopee-root"')
    && html.includes('function renderPlatformWorkbench(platform)')
    && html.includes('data-platform-quick="register"')
    && html.includes('openRegisterShopeeGroupModal(targetId)'),
  'Shopee register actions must live in the separated platform workbench',
);
assert(
  productList.includes("const lifecycleFilter = String(els.plLifecycleFilter?.value || 'all')")
    && productList.includes("return lifecycleFilter === 'all' || lifecycle === lifecycleFilter"),
  'product list must honor the selected lifecycle filter for ALL/PRE ORDER/READY STOCK tabs',
);
assert(
  productList.includes('data-product-ids="${text(productIds.join(\',\'))}"')
    && productList.includes('plProductIdsFromDataset(cb.dataset.productIds).forEach((id) => plSetProductSelected(id, cb.checked))')
    && bulkDeleteUi.includes('const visibleIds = plVisibleRenderedProductIds()')
    && bulkDeleteUi.includes('state.productListSelectedIds?.has(String(id))'),
  'collapsed group checkbox selection must select option product IDs even when child rows are not rendered',
);
assert(
  productList.includes("optionDisplay || '옵션'")
    && productList.includes("'<span class=\"pl-cell-label\">Variation</span>'")
    && productList.includes("SP Barcode")
    && productList.includes("const spBarcode = typeLabel === 'SET' ? ''")
    && productList.includes("plDisplayCostCell(p, groupRowsForDisplay)")
    && productList.includes("plDisplayWeightCell(p, groupRowsForDisplay)"),
  'grouped child option rows must display variation-only operational fields with auto cost/weight helpers',
);
assert(
  html.includes('id="pl-master-edit-modal"')
    && html.includes('id="pl-master-edit-components"')
    && productList.includes('components_extracted_en'),
  'product list must expose a master edit modal with components fields',
);
assert(
  bulkDeleteUi.includes("document.querySelectorAll('.pl-group-check')")
    && bulkDeleteUi.includes('groupCb.indeterminate'),
  'bulk delete UI must keep group checkboxes in sync with child options',
);

const groupSortSource = [
  extractFunction(html, 'plProductCreatedTime'),
  extractFunction(html, 'plGroupCreatedTime'),
  extractFunction(html, 'plCompareProductGroupsNewestFirst'),
  extractFunction(html, 'plSortProductGroupsNewestFirst'),
].join('\n');
const { plSortProductGroupsNewestFirst } = Function(`${groupSortSource}; return { plSortProductGroupsNewestFirst };`)();
const sortedGroups = plSortProductGroupsNewestFirst([
  {
    key: 'edited-old',
    firstIndex: 0,
    rows: [{ id: 'old', created_at: '2025-01-01T00:00:00Z', updated_at: '2026-12-31T00:00:00Z' }],
  },
  {
    key: 'new-group',
    firstIndex: 1,
    rows: [
      { id: 'new-a', created_at: '2026-06-01T00:00:00Z' },
      { id: 'new-b', created_at: '2026-06-02T00:00:00Z' },
    ],
  },
  {
    key: 'mid-single',
    firstIndex: 2,
    rows: [{ id: 'mid', created_at: '2026-03-01T00:00:00Z' }],
  },
]);
assert(
  sortedGroups.map((group) => group.key).join(',') === 'new-group,mid-single,edited-old',
  'group sorting must place newest registered products first and ignore later edit timestamps',
);

console.log('v2 grouped product list checks passed');
