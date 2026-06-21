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

const shopeeRows = sliceBetween(
  html,
  'function shopeePlatformListingRows(rows) {',
  'function platformTableHeadHtml(platform) {',
);
const shopeeTableRows = sliceBetween(
  html,
  'function shopeePlatformTableRows() {',
  'function platformTableHeadHtml(platform) {',
);
const tableHead = sliceBetween(
  html,
  'function platformTableHeadHtml(platform) {',
  'function platformTableRows(platform) {',
);
const platformRows = sliceBetween(
  html,
  'function platformTableRows(platform) {',
  'function renderPlatformWorkbench(platform) {',
);
const platformRender = sliceBetween(
  html,
  'function renderPlatformWorkbench(platform) {',
  'function renderPlatformWorkbenches() {',
);
const platformBinding = sliceBetween(
  html,
  'function bindPlatformWorkbench(root, platform) {',
  'function platformGroupsByKeys(keys) {',
);

test('Shopee platform tab uses the unified product-list table layout', () => {
  for (const token of [
    '.platform-table-shopee',
    '.platform-product-cell',
    '.platform-id-stack',
    '.platform-actions-cell',
    'function shopeePlatformIdsCell(group)',
    'function shopeePlatformProductCell(group, expanded)',
    'function shopeePlatformActionButtonsHtml(key, quickDisabled)',
  ]) {
    assert.match(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing ${token}`);
  }

  assert.match(tableHead, /if \(platform === 'shopee'\)/, 'Shopee should receive its own table header');
  for (const heading of ['Product', 'Shopee IDs', 'KRW', 'Listing', 'Master', 'WMS', 'Actions']) {
    assert.match(tableHead, new RegExp(`>${heading}<`), `Shopee header must include ${heading}`);
  }
  assert.match(platformRows, /if \(platform === 'shopee'\) return shopeePlatformTableRows\(\);/, 'Shopee should route through the new row renderer');
  assert.match(platformRender, /const platformTableClass = platform === 'shopee' \? 'platform-table platform-table-shopee' : 'platform-table'/, 'Shopee should use the scoped table class');
  assert.match(platformRender, /platformTableHeadHtml\(platform\)/, 'platform renderer should use the shared header helper');
});

test('Shopee platform rows reuse master product status and action patterns', () => {
  assert.match(shopeeRows, /plProductThumb\(first\)/, 'Shopee rows should show the master product image');
  assert.match(shopeeTableRows, /platformStatusPill\(status\)/, 'Shopee rows should render listing state as a horizontal pill');
  assert.match(shopeeTableRows, /plWmsStatusCell\(group\.rows \|\| \[\]\)/, 'Shopee rows should render WMS state with the master product pill helper');
  assert.match(shopeeTableRows, /<span class="pl-status-pill ok">Linked<\/span>/, 'Shopee rows should expose the master-linked status');
  assert.match(shopeeRows, /data-platform-quick="register"/, 'Shopee row actions should still route registration through platformOpenAction');
  assert.match(shopeeRows, /data-platform-quick="edit"/, 'Shopee row actions should still route edit through platformOpenAction');
  assert.match(shopeeRows, /data-platform-quick="delete"/, 'Shopee row actions should still route delete through platformOpenAction');
  assert.match(platformBinding, /data-platform-quick[\s\S]*platformOpenAction\(platform, btn\.dataset\.platformQuick \|\| 'register', \[btn\.dataset\.platformKey \|\| ''\]\)/, 'row action buttons must stay wired to the existing platform action handler');
});
