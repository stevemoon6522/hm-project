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
