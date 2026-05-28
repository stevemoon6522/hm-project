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

for (const token of [
  'function plBuildProductGroups(rows)',
  'function renderProductGroup(group)',
  'function renderProductOptionRow(p, groupKey, isGroupChild)',
  'function plParentSku(rows)',
  'function plProductName(product)',
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
  productList.includes('plIsGroupedVariant(product)')
    && productList.includes('product.product_group_id')
    && productList.includes('variation_tier_names'),
  'group detection must rely on product_group_id plus variation metadata',
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
    && productList.includes('class="primary pl-shopee-register"')
    && productList.includes('<td class="pl-platform-cell">'),
  'Shopee group register button must sit inside the Shopee platform cell',
);
assert(
  productList.includes("isGroupChild\n      ? `<div style=\"font-weight:700;color:#523563;\">${text(optionDisplay || '옵션')}</div>`")
    && productList.includes("isVariantRow\n            ? ''"),
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
