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
  for (const heading of ['Product', 'Shopee Status', 'Regions', 'WMS', 'Note', 'Actions']) {
    assert.match(tableHead, new RegExp(`>${heading}<`), `Shopee header must include ${heading}`);
  }
  for (const removedHeading of ['Shopee IDs', 'KRW', 'Master']) {
    assert.doesNotMatch(tableHead, new RegExp(`>${removedHeading}<`), `Shopee header should not expose ${removedHeading}`);
  }
  assert.match(platformRows, /if \(platform === 'shopee'\) return shopeePlatformTableRows\(\);/, 'Shopee should route through the new row renderer');
  assert.match(platformRender, /const platformTableClass = platform === 'shopee' \? 'platform-table platform-table-shopee' : 'platform-table'/, 'Shopee should use the scoped table class');
  assert.match(platformRender, /platformTableHeadHtml\(platform\)/, 'platform renderer should use the shared header helper');
});

test('Shopee platform rows expose operational status and row actions', () => {
  assert.match(shopeeRows, /plProductThumb\(first\)/, 'Shopee rows should show the master product image');
  assert.match(shopeeTableRows, /shopeePlatformStatusCell\(group\)/, 'Shopee rows should render listing state as a horizontal pill');
  assert.match(shopeeTableRows, /shopeePlatformRegionsCell\(group\)/, 'Shopee rows should render fixed region signal chips');
  assert.match(shopeeTableRows, /plWmsStatusCell\(group\.rows \|\| \[\]\)/, 'Shopee rows should render WMS state with the master product pill helper');
  assert.match(shopeeTableRows, /shopeePlatformNoteCell\(group\)/, 'Shopee rows should keep issue notes in the final column');
  assert.doesNotMatch(shopeeTableRows, /shopeePlatformIdsCell\(group\)/, 'Shopee rows should hide raw item/model/shop IDs from the main table');
  assert.match(shopeeTableRows, /shopeePlatformActionButtonsHtml\(key, group, ''\)/, 'Shopee rows should expose row-level action buttons');
  assert.match(shopeeRows, /platformMasterDeleteButtonHtml/, 'Shopee row actions should include the local master delete button');
});

test('Shopee platform actions keep delete visible and secondary actions under more', () => {
  assert.match(platformRender, /platform-toolbar platform-toolbar-shopee/, 'Shopee should render the compact toolbar variant');
  assert.match(platformRender, /platform-selection-meter/, 'Shopee toolbar should keep selected count beside actions');
  assert.match(platformRender, /data-platform-preview="register"[\s\S]*>등록<\/button>/, 'register should remain a selected-item toolbar action');
  assert.match(platformRender, /data-platform-preview="edit"[\s\S]*>가격 수정<\/button>/, 'price edit should remain a selected-item toolbar action');
  assert.match(platformRender, /data-platform-sync[\s\S]*>SKU 매핑<\/button>/, 'SKU mapping should remain a selected-item toolbar action');
  assert.match(platformRender, /class="platform-danger-action" data-platform-preview="delete"[\s\S]*>삭제\/초기화<\/button>/, 'delete/reset should be visible in the main Shopee toolbar');
  assert.match(platformRender, /data-shopee-more-toggle/, 'secondary Shopee actions should live under the more menu');
  assert.match(platformRender, /data-shopee-name-sync/, 'name sync should remain available from the more menu');
  assert.doesNotMatch(platformRender, /data-platform-preview="delete"[\s\S]*>매핑 삭제\/초기화<\/button>/, 'delete/reset should no longer be hidden in the more menu');
  assert.match(platformBinding, /data-shopee-more-toggle[\s\S]*data-shopee-more-menu/, 'the more menu toggle should be wired');
  assert.match(platformBinding, /data-platform-quick[\s\S]*platformOpenAction\(platform, btn\.dataset\.platformQuick \|\| 'register', \[btn\.dataset\.platformKey \|\| ''\]\)/, 'row action buttons must stay wired to the existing platform action handler');
  assert.match(platformBinding, /data-platform-master-delete[\s\S]*deleteOneMasterProduct\(btn\)/, 'platform-tab master delete buttons should use the master delete RPC flow');
});

test('non-Shopee platform tabs use platform-specific operational queue columns', () => {
  assert.match(tableHead, />Product</, 'non-Shopee header should keep product context first');
  assert.match(tableHead, />등록 상태</, 'non-Shopee header should show registration state');
  assert.match(tableHead, />가격\/재고</, 'non-Shopee header should show price and stock together');
  assert.match(tableHead, />문제</, 'non-Shopee header should show only actionable issues');
  assert.match(tableHead, />Actions</, 'non-Shopee header should keep actions last');
  assert.doesNotMatch(tableHead, />Lifecycle</, 'lifecycle should move into filters/product meta, not stay as a table column');
  assert.doesNotMatch(tableHead, />옵션\/SKU</, 'option/SKU should move into product meta, not stay as a separate table column');
  assert.match(platformRows, /platformQueueProductCell\(group, platform, expanded\)/, 'non-Shopee master rows should use the operational queue product cell');
  assert.match(platformRows, /platformQueuePriceStockCell\(group\.rows \|\| \[\], platform\)/, 'non-Shopee master rows should render platform-specific price/stock');
  assert.match(platformRows, /platformQueueIssueCell\(group, platform, status\)/, 'non-Shopee master rows should render compact issue summaries');
  assert.match(platformRows, /platformQueueOptionRows\(group, platform, key\)/, 'expanded option products should render child rows in the same queue shape');
});

test('platform-specific copy removes unnecessary marketplace setup details from tab surface', () => {
  assert.match(html, /const PLATFORM_QUEUE_COPY = Object\.freeze/, 'platform queue copy should be centralized');
  assert.match(html, /Qoo10은 JPY 가격, 재고, 등록\/보정 상태만 표시합니다\./, 'Qoo10 tab should focus on registration and price management');
  assert.match(html, /BrandNo, ShippingNo, header\/template 값은 등록\/보정 모달에서 확인합니다\./, 'Qoo10 setup ids should be modal-only guidance');
  assert.match(html, /eBay는 검증 차단 사유, live offer 가격\/재고, 매핑, 종료 여부만 표시합니다\./, 'eBay tab should focus on live offer operations');
  assert.doesNotMatch(html, /eBay는 초안/, 'eBay tab copy should not frame the workflow around drafts');
  assert.match(html, /Alibaba는 일반 SKU 가격 동기화가 아니라 ICBU B2B 조건 준비 큐입니다\./, 'Alibaba tab should be modeled as B2B readiness');
  assert.match(html, /if \(platform !== 'alibaba'\)[\s\S]*data-platform-sync/, 'Alibaba toolbar should omit SKU mapping actions');
});
