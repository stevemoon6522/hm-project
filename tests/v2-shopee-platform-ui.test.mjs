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
    '.platform-region-status-chip',
    '.platform-note-cell',
    'function shopeePlatformRegionsCell(group)',
    'function shopeePlatformNoteCell(group)',
    'function shopeePlatformProductCell(group, expanded)',
  ]) {
    assert.match(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing ${token}`);
  }

  assert.match(tableHead, /if \(platform === 'shopee'\)/, 'Shopee should receive its own table header');
  for (const heading of ['Product', 'Shopee Status', 'Regions', 'WMS', 'Note']) {
    assert.match(tableHead, new RegExp(`>${heading}<`), `Shopee header must include ${heading}`);
  }
  for (const removedHeading of ['Shopee IDs', 'KRW', 'Master', 'Actions']) {
    assert.doesNotMatch(tableHead, new RegExp(`>${removedHeading}<`), `Shopee header should not expose ${removedHeading}`);
  }
  assert.match(platformRows, /if \(platform === 'shopee'\) return shopeePlatformTableRows\(\);/, 'Shopee should route through the new row renderer');
  assert.match(platformRender, /const platformTableClass = platform === 'shopee' \? 'platform-table platform-table-shopee' : 'platform-table'/, 'Shopee should use the scoped table class');
  assert.match(platformRender, /platformTableHeadHtml\(platform\)/, 'platform renderer should use the shared header helper');
});

test('Shopee platform rows expose only operational status columns', () => {
  assert.match(shopeeRows, /plProductThumb\(first\)/, 'Shopee rows should show the master product image');
  assert.match(shopeeTableRows, /shopeePlatformStatusCell\(group\)/, 'Shopee rows should render listing state as a horizontal pill');
  assert.match(shopeeTableRows, /shopeePlatformRegionsCell\(group\)/, 'Shopee rows should render fixed region signal chips');
  assert.match(shopeeTableRows, /plWmsStatusCell\(group\.rows \|\| \[\]\)/, 'Shopee rows should render WMS state with the master product pill helper');
  assert.match(shopeeTableRows, /shopeePlatformNoteCell\(group\)/, 'Shopee rows should keep issue notes in the final column');
  assert.doesNotMatch(shopeeTableRows, /shopeePlatformIdsCell\(group\)/, 'Shopee rows should hide raw item/model/shop IDs from the main table');
  assert.doesNotMatch(shopeeTableRows, /shopeePlatformActionButtonsHtml/, 'Shopee rows should not expose row-level action buttons');
});

test('Shopee platform actions are grouped in the top toolbar', () => {
  assert.match(platformRender, /platform-toolbar platform-toolbar-shopee/, 'Shopee should render the compact toolbar variant');
  assert.match(platformRender, /platform-selection-meter/, 'Shopee toolbar should keep selected count beside actions');
  assert.match(platformRender, /data-platform-preview="register"[\s\S]*>등록<\/button>/, 'register should remain a selected-item toolbar action');
  assert.match(platformRender, /data-platform-preview="edit"[\s\S]*>가격 수정<\/button>/, 'price edit should remain a selected-item toolbar action');
  assert.match(platformRender, /data-platform-sync[\s\S]*>SKU 매핑<\/button>/, 'SKU mapping should remain a selected-item toolbar action');
  assert.match(platformRender, /data-shopee-more-toggle/, 'secondary Shopee actions should live under the more menu');
  assert.match(platformRender, /data-shopee-name-sync/, 'name sync should remain available from the more menu');
  assert.match(platformRender, /data-platform-preview="delete"[\s\S]*>매핑 삭제\/초기화<\/button>/, 'delete/reset should remain available from the more menu');
  assert.match(platformBinding, /data-shopee-more-toggle[\s\S]*data-shopee-more-menu/, 'the more menu toggle should be wired');
  assert.match(platformBinding, /data-platform-quick[\s\S]*platformOpenAction\(platform, btn\.dataset\.platformQuick \|\| 'register', \[btn\.dataset\.platformKey \|\| ''\]\)/, 'row action buttons must stay wired to the existing platform action handler');
});
