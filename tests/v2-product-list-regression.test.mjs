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
const productsView = sliceBetween(html, '<div id="view-products" class="view active">', '</div><!-- /view-products -->');
const productRender = sliceBetween(html, 'function renderProductOptionRow(p, groupKey, isGroupChild) {', 'function plGroupRowsById(productGroupId) {');
const productGrouping = sliceBetween(html, 'function plIsGroupedVariant(product) {', 'function renderProductGroup(group) {');
const nameHelpers = sliceBetween(html, 'function cleanProductName(value, fallback = \'\') {', 'function numberOrNull(value) {');
const productNameDisplay = sliceBetween(html, 'function plProductName(product) {', 'function productLifecycleFilterKey(product) {');
const masterEdit = sliceBetween(html, 'function plMasterEditRenderOptions(rows) {', 'async function saveProductMasterEditModal() {');
const masterEditOpenSave = sliceBetween(html, 'async function openProductMasterEditModal(productGroupId) {', 'function beginEditCell(cell) {');
const inlineEdit = sliceBetween(html, 'function beginEditCell(cell) {', 'async function deleteOneMasterProduct(btn) {');
const shopeeGlobalImport = sliceBetween(html, 'async function sgUpsertProduct(row, model, productGroupId, lifecycleState) {', 'function sgReadSelectedStaronemallUrls() {');
const shopeeRegisterOpen = sliceBetween(html, 'async function openRegisterShopeeGroupModal(productGroupId) {', 'function rshCrawlImages(staronemallUrl) {');
const masterRegisterNaming = sliceBetween(html, 'function mrMasterProductName(row) {', 'function mrGroupComponents(group) {');
const platformSync = sliceBetween(html, 'async function syncPlatformSkus() {', 'function productListings(productId) {');
const coverageLookup = sliceBetween(html, 'async function coverageLookupViaPlatformPublish(platform, sku, productId) {', 'async function coverageCheckExistingPlatformsBySku() {');
const masterRegisterImageTools = sliceBetween(html, 'function mrGetGroupOptionImages(group, firstRow) {', 'function mrMasterPatchForGroup(group) {');
const openCreatedMasterEdit = sliceBetween(html, 'async function mrOpenCreatedMasterEdit(productId) {', 'function mrRenderPreviewCards() {');
const masterRegisterRender = sliceBetween(html, 'function mrRenderPreviewCards() {', 'async function mrPromoteAll() {');
const joomRegisterStatus = sliceBetween(html, 'function mrJoomListingStatusFromResponse(json) {', 'function mrJoomAssertOptionSkuLocked(row, idx, errors) {');

test('primary marketplace tabs render as a large left-side navigation rail', () => {
  assert.match(html, /\.app-layout[\s\S]*grid-template-columns: 276px minmax\(0, 1fr\)/, 'app shell should reserve a visible left rail for marketplace tabs');
  assert.match(html, /<aside class="app-sidebar" aria-label="Primary dashboard navigation">/, 'tabs should live in a dedicated left sidebar');
  assert.match(html, /<section class="app-content" aria-label="Dashboard content">/, 'views should render in the right content area');
  assert.match(html, /\.nav-tab[\s\S]*min-height: 64px/, 'desktop nav tabs should be visibly larger than the old top strip');
  assert.match(nav, /<span class="nav-label">마스터 상품<\/span>[\s\S]*<span class="nav-meta">공통 상품 관리<\/span>/, 'master tab should include a visible label and purpose');
  assert.match(nav, /<span class="nav-label">Shopee<\/span>[\s\S]*<span class="nav-meta">등록 \/ 수정 \/ 재시도<\/span>/, 'Shopee tab should expose the main work type');
});

test('standalone products have master edit button and master tab stays platform-neutral', () => {
  assert.match(productRender, /data-edit-master="\$\{text\(plMasterEditTargetKey\(p\)\)\}"/, 'single row should expose master edit target');
  assert.match(productRender, /isVariantRow && optionDisplay[\s\S]*\$\{editButton\}/, 'option-like single rows should also expose the master edit button');
  assert.doesNotMatch(productRender, /data-open-shopee-single="\$\{text\(p\.id\)\}"/, 'Shopee register button should move out of the master product table');
  assert.doesNotMatch(productRender, /platformLedCell\(p\.id, 'shopee'\)/, 'platform LEDs should move out of the master product table');
  assert.doesNotMatch(productRender, /data-open="\$\{text\(p\.id\)\}"[^>]*>Register<\/button>/, 'legacy action-column Register button should be removed');
});

test('single-option master products use the same Shopee single registration form', () => {
  assert.match(productGrouping, /function plShouldRenderAsGrouped\(product, sourceRows = state\.products \|\| \[\]\)/, 'product list should distinguish true multi-option groups from single-option masters');
  assert.match(productGrouping, /plVariantGroupMemberCount\(product\?\.product_group_id, sourceRows\) > 1/, 'only groups with more than one variant row should render as grouped Shopee registrations');
  assert.match(html, /function platformOpenExistingModal\(platform, group\)/, 'platform tabs should route grouped/single quick actions through existing modals when needed');
  assert.match(html, /platform === 'shopee'[\s\S]*openRegisterShopeeSingleModal\(group\.rows\[0\]\.id\)/, 'Shopee platform quick action should still reach the single Shopee form');
  assert.match(shopeeRegisterOpen, /function openRegisterShopeeSingleModal\(productId\)/, 'single Shopee button should route through a normalizing opener');
  assert.match(shopeeRegisterOpen, /allowVariant: true[\s\S]*mode: 'single'/, 'single-option variants should bypass the variant guard but keep the single form');
  assert.match(shopeeRegisterOpen, /if \(rows\.length === 1\)[\s\S]*openRegisterShopeeModal\(rows\[0\]\.id,[\s\S]*mode: 'single'/, 'group opener should downgrade one-row groups to the single Shopee form');
});

test('master product names are normalized with lifecycle prefix everywhere they are saved or displayed', () => {
  assert.match(nameHelpers, /function lifecycleProductNamePrefix\(lifecycleState\)/, 'lifecycle prefix helper should exist');
  assert.match(nameHelpers, /function normalizeMasterProductNameForLifecycle\(value, lifecycleState, fallback = ''\)/, 'master name lifecycle normalizer should exist');
  assert.ok(nameHelpers.includes("replace(/\\[\\s*(PRE\\s*[-]?\\s*ORDER|READY\\s*STOCK)\\s*\\]/gi"), 'normalizer should strip bracketed lifecycle tags before adding the canonical prefix');
  assert.match(productNameDisplay, /normalizeMasterProductNameForLifecycle\(product\?\.product_name, product\?\.lifecycle_state/, 'product list display should normalize names by lifecycle');
  assert.match(masterEditOpenSave, /nameInput\) nameInput\.value = normalizeMasterProductNameForLifecycle\(first\.product_name, first\.lifecycle_state/, 'master edit modal should open with the canonical lifecycle prefix');
  assert.match(masterEditOpenSave, /normalizeMasterProductNameForLifecycle\(rawName, lifecycleState, rows\[0\]\?\.sku/, 'master edit save should enforce the canonical lifecycle prefix');
  assert.match(inlineEdit, /normalizeMasterProductNameForLifecycle\(newVal, product\?\.lifecycle_state/, 'inline product-name edits should enforce the canonical lifecycle prefix');
  assert.match(shopeeGlobalImport, /product_name: normalizeMasterProductNameForLifecycle\(sgItemName\(item\), lifecycleState, sku\)/, 'Shopee Global import should store canonical lifecycle-prefixed master names');
  assert.match(masterRegisterNaming, /return normalizeMasterProductNameForLifecycle\(title, mrRowLifecycle\(row\), derived/, 'master register should store canonical lifecycle-prefixed master names from each row lifecycle');
});

test('master register cards expose master edit action whenever any master row was created', () => {
  assert.match(masterRegisterRender, /createdProductIds = group\.rows/, 'register card must collect every created option product id');
  assert.match(masterRegisterRender, /createdProductIds\.length/, 'register card must show edit action whenever at least one row was created');
  assert.doesNotMatch(masterRegisterRender, /cardStatus === 'done' && doneProductId/, 'edit action must not be limited to fully completed cards');
  assert.match(masterRegisterRender, /data-open-created-master-edit/, 'registered cards should expose a master edit button target');
  assert.match(masterRegisterRender, /mrOpenCreatedMasterEdit\(createdProductIds\[0\]\)/, 'registered cards should open the master edit modal from the created master row');
});

test('created master edit action still opens when product list refresh fails', () => {
  assert.match(openCreatedMasterEdit, /catch \(loadErr\)/, 'product list refresh failure should be isolated');
  assert.match(openCreatedMasterEdit, /openProductMasterEditModal\(id\)/, 'modal open should still run after refresh failure');
});

test('master edit modal supports manual option image edits including clearing URLs', () => {
  assert.match(masterEdit, /data-field="shopee_option_image_url"/, 'option image URL input should be present');
  assert.doesNotMatch(masterEdit, /data-field="main_image"/, 'representative image must not reuse the option image input');
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
  assert.doesNotMatch(platformSync, /rollupListedCountForLed\(rollup, platform\) > 0\)[\s\S]{0,120}continue;/, 'green LED rows must be remotely rechecked instead of skipped');
  assert.match(platformSync, /const wasListed = rollupListedCountForLed\(rollup, platform\) > 0/, 'sync should remember whether a green LED is being verified');
  assert.match(platformSync, /coverageClearPlatformMapping\(group\.id, platform, hit\)/, 'remote not-found should clear stale local LED mappings');
  assert.match(coverageLookup, /coverageLookupShopeePublishedBySku/, 'Shopee lookup should use published_list/global data');
  assert.match(coverageLookup, /coverageAbsorbShopeePublishedHit/, 'Shopee hit should be absorbed into product_shopee_listings');
  assert.match(coverageLookup, /coverageClearShopeePublishedMappings/, 'Shopee not-found should mark product_shopee_listings as not_listed');
  assert.match(coverageLookup, /coverageShopeePublishedItemsFromRaw/, 'Shopee sync should normalize bridge and cached published list shapes');
  assert.match(coverageLookup, /result\?\.response\?\.published_item/, 'Shopee bridge published_list shape should be accepted');
  assert.match(coverageLookup, /SHOPEE_BRIDGE\}\/published_list\?region=SG&global_item_id=/, 'Shopee sync should fetch published_list when only global_item_id is present');
  assert.match(coverageLookup, /coverageLookupShopeeLocalRowsByItemInfo/, 'Shopee stale shop item rows should be verified by item_info when global_item_id is unavailable');
  assert.doesNotMatch(coverageLookup, /if \(localHit\) return coverageNormalizeShopeePublishedHit/, 'Shopee sync must not trust cached local rows before remote verification');
  assert.doesNotMatch(coverageLookup, /row\?\.shopee_item_id \|\| row\?\.platform_item_id/, 'products.shopee_item_id is a global id and must not be treated as shop_item_id');
  assert.match(coverageLookup, /global_item_id: row\.global_item_id \|\| null/, 'absorbed listing should preserve global_item_id for later price/sync operations');
});

test('platform SKU sync absorbs Joom/Qoo10/eBay lookup hits through platform-publish sync', () => {
  assert.match(platformSync, /else await coverageAbsorbLookupHit\(group\.id, hit\)/, 'non-Shopee lookup hits should all be absorbed, not only Qoo10');
  assert.match(coverageLookup, /fetch\(PLATFORM_PUBLISH/, 'frontend should route non-Shopee absorbs through platform-publish');
  assert.match(coverageLookup, /capability: 'sync'/, 'non-Shopee absorb should use sync capability, not publish/create');
  assert.match(coverageLookup, /country: hit\.country \|\| \(hit\.platform === 'joom' \? 'GLOBAL' : \(hit\.platform === 'ebay' \? 'EBAY_US' : undefined\)\)/, 'Joom/eBay lookup absorbs should use stable rollup country keys');
  assert.doesNotMatch(coverageLookup, /db\.rpc\('absorb_platform_sku_lookup'/, 'browser must not call SECURITY DEFINER absorb RPC directly');
  assert.match(coverageLookup, /async function coverageLookupQoo10BySku\(sku, productId\)[\s\S]*coverageLookupViaPlatformPublish\('qoo10', sku, productId\)/, 'Qoo10 SKU sync should use platform-publish so stale mappings are cleared server-side');
  assert.match(coverageLookup, /syncedByPlatformPublish/, 'platform-publish lookup responses should not be re-synced by the browser');
  assert.match(coverageLookup, /listingStatus === 'not_listed'[\s\S]*notFound: true/, 'non-Shopee not_listed sync responses should clear stale LEDs');
});

test('Joom registration stores pending/non-active responses without marking them mapped', () => {
  assert.match(joomRegisterStatus, /json\?\.hasActiveVersion === false[\s\S]*return 'pending'/, 'Joom publish response with no active version should stay pending');
  assert.match(joomRegisterStatus, /state === 'archived'[\s\S]*return 'not_listed'/, 'archived Joom products should not be treated as listed');
  assert.match(html, /const joomMappingStatus = mrJoomMappingStatusFromResponse\(json\)/, 'Joom DB update should derive mapping status from publish response');
  assert.match(html, /joom_mapping_status: joomMappingStatus/, 'Joom DB update should not hard-code mapped after publish');
});
