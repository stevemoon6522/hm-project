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

const nav = sliceBetween(html, '<div class="nav-tabs">', '</div>');
const productsView = sliceBetween(html, '<div id="view-products" class="view">', '</div><!-- /view-products -->');
const productRender = sliceBetween(html, 'function renderProductOptionRow(p, groupKey, isGroupChild) {', 'function plGroupRowsById(productGroupId) {');
const masterEdit = sliceBetween(html, 'function plMasterEditRenderOptions(rows) {', 'async function saveProductMasterEditModal() {');
const platformSync = sliceBetween(html, 'async function syncPlatformSkus() {', 'function productListings(productId) {');
const coverageLookup = sliceBetween(html, 'async function coverageLookupViaPlatformPublish(platform, sku, productId) {', 'async function coverageCheckExistingPlatformsBySku() {');
const masterRegisterImageTools = sliceBetween(html, 'function mrGetGroupOptionImages(group, firstRow) {', 'function mrMasterPatchForGroup(group) {');

test('standalone products have master edit button and platform register button next to Shopee LED', () => {
  assert.match(productRender, /data-edit-master="\$\{text\(plMasterEditTargetKey\(p\)\)\}"/, 'single row should expose master edit target');
  assert.match(productRender, /data-open-shopee-single="\$\{text\(p\.id\)\}"/, 'single row Shopee register should live in Shopee platform cell');
  assert.doesNotMatch(productRender, /data-open="\$\{text\(p\.id\)\}"[^>]*>Register<\/button>/, 'legacy action-column Register button should be removed');
});

test('master edit modal supports manual option image edits including clearing URLs', () => {
  assert.match(masterEdit, /data-field="main_image"/, 'option image URL input should be present');
  assert.match(masterEdit, /data-clear-option-image="1"/, 'clear image button should be present for manual removal');
  assert.match(masterEdit, /plMasterEditBindOptionImageControls/, 'image controls should refresh previews after edit');
});

test('READY STOCK transition is moved into product list PRE ORDER filter and PRE ORDER nav tab is removed', () => {
  assert.doesNotMatch(nav, /showView\('view-pre-order'\)/, 'PRE ORDER top-level tab should be removed');
  assert.match(productsView, /id="po-ready-stock-open"/, 'READY STOCK transition button should be in product list toolbar');
  assert.match(productsView, /id="pl-ready-stock-panel-host"/, 'READY STOCK wizard host should be inside product list view');
  assert.match(html, /function ensureReadyStockPanelInProductList\(\)/, 'READY STOCK wizard panel should be moved into the product list host at runtime');
  assert.match(html, /function updateProductListReadyStockButton\(lifecycleFilter\)/, 'button visibility should be tied to product list lifecycle filter');
});

test('master register flow has a manual option-image management modal and sends the picked component image to Vision', () => {
  assert.match(masterRegisterImageTools, /function mrOpenOptionImageModal\(group\)/, 'option image management modal should exist');
  assert.match(masterRegisterImageTools, /옵션 이미지 관리/, 'modal should be labeled for operators');
  assert.match(masterRegisterImageTools, /type: 'checkbox', checked: true/, 'each crawled option image should be removable with a keep checkbox');
  assert.match(masterRegisterImageTools, /type: 'radio', name: 'mr-component-image-url'/, 'operator should be able to pick the component extraction image');
  assert.match(masterRegisterImageTools, /mrSetGroupOptionImages\(group, kept, picked\)/, 'modal save should persist removed images and selected component image');
  assert.match(masterRegisterImageTools, /body: JSON\.stringify\(\{ master_row_id: 0, staronemall_url: url, image_url: componentImageUrl \}\)/, 'Vision extraction should use the operator-selected component image, not the first/cover image');
});

test('platform SKU sync includes Shopee and absorbs published_list region ids for global-only rows', () => {
  assert.match(platformSync, /const targetPlatforms = \['shopee', 'joom', 'qoo10', 'ebay'\]/, 'product list platform sync should include Shopee');
  assert.match(coverageLookup, /coverageLookupShopeePublishedBySku/, 'Shopee lookup should use published_list/global data');
  assert.match(coverageLookup, /coverageAbsorbShopeePublishedHit/, 'Shopee hit should be absorbed into product_shopee_listings');
  assert.match(coverageLookup, /coverageShopeePublishedItemsFromRaw/, 'Shopee sync should normalize bridge and cached published list shapes');
  assert.match(coverageLookup, /result\?\.response\?\.published_item/, 'Shopee bridge published_list shape should be accepted');
  assert.match(coverageLookup, /SHOPEE_BRIDGE\}\/published_list\?region=SG&global_item_id=/, 'Shopee sync should fetch published_list when only global_item_id is present');
  assert.doesNotMatch(coverageLookup, /row\?\.shopee_item_id \|\| row\?\.platform_item_id/, 'products.shopee_item_id is a global id and must not be treated as shop_item_id');
  assert.match(coverageLookup, /global_item_id: row\.global_item_id \|\| null/, 'absorbed listing should preserve global_item_id for later price/sync operations');
});
