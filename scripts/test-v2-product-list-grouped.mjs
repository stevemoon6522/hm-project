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

const productView = sliceBetween(
  html,
  '<div id="view-products" class="view">',
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

assert(productView.includes('<table class="pl-table">'), 'product list table must use wrapping table class');
assert(html.includes('.pl-group-row'), 'group row styling must exist');
assert(html.includes('.pl-option-row'), 'option row styling must exist');
assert(html.includes('productListCollapsedGroups: new Set()'), 'collapsed group state must be tracked');
assert(html.includes('productListSelectedIds: new Set()'), 'product list selected IDs must be tracked outside the DOM');

for (const token of [
  'function plBuildProductGroups(rows)',
  'function renderProductGroup(group)',
  'function renderProductOptionRow(p, groupKey, isGroupChild)',
  'function plParentSku(rows)',
  'function plProductName(product)',
  'function plSetProductSelected(productId, selected)',
  'function plVisibleRenderedProductIds()',
  'function plGroupPlatformCell(rows, platform)',
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
  productList.includes("state.productListCollapsedGroups.has(group.key)")
    && productList.includes('state.productListCollapsedGroups.add(groupKey)'),
  'group rows must be expandable/collapsible',
);
assert(
  productList.includes("isVariantRow ? '<span class=\"muted\"")
    && productList.includes('data-open="${text(p.id)}"'),
  'variant option rows must not show the legacy Register button',
);
assert(
  productList.includes('class="pl-shopee-cell"')
    && productList.includes('class="pl-shopee-register"')
    && productList.includes('aria-label="Shopee 등록"')
    && productList.includes('>📤</button>')
    && !productList.includes('<svg viewBox="0 0 24 24"')
    && !productList.includes('class="primary pl-shopee-register"')
    && !productList.includes('class="primary pl-shopee-register">Shopee 등록</button>')
    && productList.includes('<td class="pl-platform-cell">'),
  'Shopee group register button must be a neutral emoji-only button inside the Shopee platform cell',
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
    && productList.includes("${isGroupChild ? '' : productLifecycleBadge(p)}")
    && productList.includes("isVariantRow\r\n            ? ''"),
  'grouped child option rows must display only the option name without repeated product/group metadata',
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

console.log('v2 grouped product list checks passed');
