import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(process.cwd(), 'v2', 'index.html'), 'utf8');

function sliceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start token: ${start}`);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `missing end token after ${start}`);
  return source.slice(startIndex, endIndex);
}

const productListStyles = sliceBetween(html, '.pl-group-row td,', '.empty {');
const productListRender = sliceBetween(html, 'function renderProductOptionRow(p, groupKey, isGroupChild) {', 'function plGroupRowsById(productGroupId) {');
const appState = sliceBetween(html, 'const state = {', 'const PLATFORM_TABS');
const catalogStyles = sliceBetween(html, '/* row warnings */', '/* price delta cells */');
const catalogGroupRender = sliceBetween(html, 'function catRenderGroupRow(group, listingIdx) {', 'function catRenderProductRow(p, listingIdx, isGroupChild) {');
const catalogProductRender = sliceBetween(html, 'function catRenderProductRow(p, listingIdx, isGroupChild) {', '// \u2500\u2500 Main render');
const catalogApplyRender = sliceBetween(html, 'function applyAndRenderCatalog() {', 'function catSyncSelectAll() {');

test('single master product rows use the same highlighted background as option group headers', () => {
  assert.match(
    productListStyles,
    /\.pl-group-row td,\s*\.pl-single-product-row td\s*{\s*background:\s*#fff9fd;/s,
    'single product rows should share the group-row highlight color',
  );
  assert.match(
    productListRender,
    /const rowClass = isGroupChild\s*\? 'pl-option-row'\s*:\s*'pl-single-product-row';/,
    'every standalone master row, including a single-option master, should render with pl-single-product-row',
  );
  assert.match(
    productListRender,
    /<tr class="\$\{rowClass\}" data-product-id=/,
    'rendered product row should use the computed row class',
  );
});

test('price sync starts option groups collapsed and highlights standalone master rows', () => {
  assert.match(
    appState,
    /priceSyncExpandedGroups: new Set\(\)/,
    'price sync should store only user-expanded option groups',
  );
  assert.match(
    catalogGroupRender,
    /const collapsed = !state\.priceSyncExpandedGroups\.has\(group\.key\);/,
    'option groups should render collapsed until explicitly expanded',
  );
  assert.match(
    catalogApplyRender,
    /if \(!state\.priceSyncExpandedGroups\.has\(group\.key\)\) return groupHtml;/,
    'collapsed option groups should render only their master row by default',
  );
  assert.match(
    catalogApplyRender,
    /if \(state\.priceSyncExpandedGroups\.has\(groupKey\)\) state\.priceSyncExpandedGroups\.delete\(groupKey\);[\s\S]*else state\.priceSyncExpandedGroups\.add\(groupKey\);/,
    'the group toggle should switch between collapsed and expanded states',
  );
  assert.match(
    catalogProductRender,
    /const rowClass = \(isGroupChild \? 'pl-option-row ' : 'pl-single-product-row '\) \+ \(isLargeChange \? 'cat-row-warn' : ''\);/,
    'standalone rows in price sync should use the master-row highlight class',
  );
  assert.match(
    catalogStyles,
    /\.cat-row-warn,\s*\.cat-row-warn td \{ background: #fffbeb !important; \}/,
    'warning rows should still override master/option row background colors',
  );
});
