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

function extractFunctionBlock(source, functionName) {
  let start = source.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `${functionName} must exist`);
  const asyncStart = start - 'async '.length;
  if (asyncStart >= 0 && source.slice(asyncStart, start) === 'async ') start = asyncStart;
  const open = source.indexOf('{', start);
  assert.ok(open > start, `${functionName} must have a body`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${functionName} body must close`);
}

const nav = sliceBetween(html, '<div class="nav-tabs">', '</div>');
const productsView = sliceBetween(html, '<div id="view-products" class="view active">', '</div><!-- /view-products -->');
const productRender = sliceBetween(html, 'function renderProductOptionRow(p, groupKey, isGroupChild) {', 'function plGroupRowsById(productGroupId) {');
const productGrouping = sliceBetween(html, 'function plIsGroupedVariant(product) {', 'function renderProductGroup(group) {');
const nameHelpers = sliceBetween(html, 'function cleanProductName(value, fallback = \'\') {', 'function numberOrNull(value) {');
const productNameDisplay = sliceBetween(html, 'function plProductName(product) {', 'function productLifecycleFilterKey(product) {');
const masterEdit = sliceBetween(html, 'function plMasterEditRenderOptions(rows) {', 'async function saveProductMasterEditModal() {');
const masterEditSkuHelpers = sliceBetween(html, 'function plMasterEditAutoSku(row = {}, optionName = \'\') {', 'function plMasterEditRenderDetailImageManager(urls) {');
const masterEditOpenSave = sliceBetween(html, 'async function openProductMasterEditModal(productGroupId) {', 'function beginEditCell(cell) {');
const inlineEdit = sliceBetween(html, 'function beginEditCell(cell) {', 'async function deleteOneMasterProduct(btn) {');
const shopeeGlobalImport = sliceBetween(html, 'async function sgUpsertProduct(row, model, productGroupId, lifecycleState) {', 'function sgReadSelectedStaronemallUrls() {');
const shopeeRegisterOpen = sliceBetween(html, 'async function openRegisterShopeeGroupModal(productGroupId) {', 'function rshCrawlImages(staronemallUrl) {');
const masterRegisterNaming = sliceBetween(html, 'function mrMasterProductName(row) {', 'function mrGroupComponents(group) {');
const platformSync = sliceBetween(html, 'function normalizePlatformSyncTargets(platforms) {', 'function productListings(productId) {');
const coverageLookup = sliceBetween(html, 'async function coverageLookupViaPlatformPublish(platform, sku, productId) {', 'async function coverageCheckExistingPlatformsBySku() {');
const coverageSkuCheck = sliceBetween(html, 'async function coverageCheckExistingPlatformsBySku() {', 'function coverageRender() {');
const masterRegisterImageTools = sliceBetween(html, 'function mrGetGroupOptionImages(group, firstRow) {', 'function mrMasterPatchForGroup(group) {');
const openCreatedMasterEdit = sliceBetween(html, 'async function mrOpenCreatedMasterEdit(productId) {', 'function mrRenderPreviewCards() {');
const masterRegisterRender = sliceBetween(html, 'function mrRenderPreviewCards() {', 'async function mrPromoteAll() {');
const masterRegisterPromote = sliceBetween(html, 'async function mrPromoteAll() {', 'let _v2EbayExCountryCache = null;');
const joomRegisterStatus = sliceBetween(html, 'function mrJoomListingStatusFromResponse(json) {', 'function mrJoomAssertOptionSkuLocked(row, idx, errors) {');
const shopeePlatformRegions = sliceBetween(html, 'const SHOPEE_PLATFORM_ACTIVE_REGIONS', '/** Preselect state: set by openReadyStockWizard()');
const platformSelectionFlow = sliceBetween(html, 'function platformGroupsByKeys(keys) {', 'function platformOpenPreview(platform, action, explicitKeys = null) {');
const platformPreviewExecution = sliceBetween(html, 'function platformCanUseDispatcher(platform, action, group) {', 'async function platformPublishDirect(platform, row, action) {');
const platformBinding = sliceBetween(html, 'function bindPlatformWorkbench(root, platform) {', 'function platformGroupsByKeys(keys) {');
const shopeeRegisterClose = sliceBetween(html, 'function rshCloseModal() {', '// Wire up static modal button listeners once at init.');

test('primary marketplace tabs render as a large left-side navigation rail', () => {
  assert.match(html, /\.app-layout[\s\S]*grid-template-columns: 276px minmax\(0, 1fr\)/, 'app shell should reserve a visible left rail for marketplace tabs');
  assert.match(html, /<aside class="app-sidebar" aria-label="Primary dashboard navigation">/, 'tabs should live in a dedicated left sidebar');
  assert.match(html, /<section class="app-content" aria-label="Dashboard content">/, 'views should render in the right content area');
  assert.match(html, /\.nav-tab[\s\S]*min-height: 64px/, 'desktop nav tabs should be visibly larger than the old top strip');
  assert.match(nav, /<span class="nav-label">마스터 상품<\/span>[\s\S]*<span class="nav-meta">공통 상품 관리<\/span>/, 'master tab should include a visible label and purpose');
  assert.match(nav, /<span class="nav-label">Shopee<\/span>[\s\S]*<span class="nav-meta">등록 \/ 수정<\/span>/, 'Shopee tab should expose only the primary platform work types');
});

test('Shopee platform tab always includes BR as an active region', () => {
  assert.match(shopeePlatformRegions, /SHOPEE_PLATFORM_ACTIVE_REGIONS = Object\.freeze\(\['SG', 'TW', 'TH', 'MY', 'PH', 'BR'\]\)/, 'Shopee platform active regions must include BR');
  assert.doesNotMatch(shopeePlatformRegions, /\{ region: 'BR'/, 'BR must not be rendered as an excluded Shopee platform region');
  assert.match(html, /\{ code: 'BR', currency: 'BRL', enabled: true \}/, 'BR must remain enabled in shared Shopee region metadata');
});

test('platform tab buttons keep selection and route registration through the proven modals', () => {
  assert.match(platformSelectionFlow, /function platformGroupKeysFromProductIds\(productIds\)/, 'platform tabs should be able to map master-list selections to platform groups');
  assert.match(platformSelectionFlow, /state\.productListSelectedIds/, 'platform tabs should adopt master product selections when opened');
  assert.match(html, /platformAdoptProductListSelection\(platform\);[\s\S]*const selectedCount = platformSelection\(platform\)\.size/, 'platform render should adopt selections before enabling action buttons');
  assert.match(html, /data-platform-sync[\s\S]*>\$\{text\(label\)\} SKU 매핑<\/button>/, 'platform tabs should label remote SKU matching as platform-specific SKU mapping');
  assert.match(platformBinding, /data-platform-preview[\s\S]*platformOpenAction\(platform, btn\.dataset\.platformPreview \|\| 'register'\)/, 'bulk preview buttons must route through the platform action handler');
  assert.match(platformBinding, /platform-master-check[\s\S]*sel\.add\(key\)[\s\S]*renderPlatformWorkbench\(platform\)/, 'row selection must enable preview actions after rerender');
  assert.match(platformPreviewExecution, /return false;/, 'platform tabs must not bypass registration modals through direct dispatcher execution');
  assert.match(platformPreviewExecution, /platformOpenExistingModal\(platform, group\)/, 'preview execution must open the existing platform registration modal');
  assert.match(html, /const registerActionLabel = actionTargetCount === 1 \? '등록' : '선택 등록 확인'/, 'single platform registration should be labeled as direct registration, not preview');
  assert.doesNotMatch(html, /data-platform-(?:quick|preview)="retry"/, 'platform tabs should not expose a duplicate retry button that opens the same registration flow');
  assert.match(html, /if \(action === 'register'\)[\s\S]*if \(groups\.length > 1\)[\s\S]*platformOpenPreview\(platform, action, explicitKeys\)[\s\S]*await platformOpenExistingModal\(platform, groups\[0\]\)/, 'single register actions should open existing platform modals directly while multi-selection keeps confirmation');
  assert.match(html, /if \(platform === 'shopee'\)[\s\S]*openRegisterShopeeSingleModal\(group\.rows\[0\]\.id\)/, 'Shopee single registration must use the existing single modal');
  assert.match(html, /if \(platform === 'joom'\) return openRegisterJoomGroupModal\(targetId\)/, 'Joom registration must use the existing Joom modal');
  assert.match(html, /if \(platform === 'qoo10'\) return openRegisterQoo10GroupModal\(targetId\)/, 'Qoo10 registration must use the existing Qoo10 modal');
  assert.match(html, /if \(platform === 'ebay'\) return openRegisterEbayGroupModal\(targetId\)/, 'eBay registration must use the existing eBay modal');
});

test('single selected platform register uses direct modal while multi-selected stays confirm-first', async () => {
  const platformOpenActionFactory = new Function(
    'state',
    'platformActionGroups',
    'platformSelectedGroups',
    'platformVisibleGroups',
    'platformOpenPreview',
    'platformOpenExistingModal',
    'PLATFORM_LABELS',
    'showToast',
    'renderPlatformWorkbench',
    `${extractFunctionBlock(html, 'platformOpenAction')}; return platformOpenAction;`,
  );
  const labels = { shopee: 'Shopee', joom: 'Joom', qoo10: 'Qoo10', ebay: 'eBay' };

  for (const platform of Object.keys(labels)) {
    const state = { platformPreview: { platform, action: 'register', keys: ['stale'] } };
    const calls = { modals: [], previews: [], toasts: [], renders: [] };
    const openAction = platformOpenActionFactory(
      state,
      () => [{ key: `single:${platform}-one`, rows: [{ id: `${platform}-one` }] }],
      () => [],
      () => [],
      (...args) => calls.previews.push(args),
      async (targetPlatform, group) => calls.modals.push({ targetPlatform, group }),
      labels,
      (message, kind) => calls.toasts.push({ message, kind }),
      (targetPlatform) => calls.renders.push(targetPlatform),
    );

    await openAction(platform, 'register');

    assert.equal(state.platformPreview, null, `${platform} single selected register must clear stale preview state`);
    assert.deepEqual(calls.renders, [platform], `${platform} single selected register must rerender before modal open`);
    assert.equal(calls.modals.length, 1, `${platform} single selected register must open exactly one modal`);
    assert.equal(calls.modals[0].targetPlatform, platform, `${platform} single selected register must use the current platform`);
    assert.equal(calls.previews.length, 0, `${platform} single selected register must not open the bulk preview`);
    assert.equal(calls.toasts.length, 0, `${platform} single selected register must not show a confirmation toast`);
  }

  {
    const state = { platformPreview: null };
    const calls = { modals: [], previews: [], toasts: [] };
    const openAction = platformOpenActionFactory(
      state,
      () => [
        { key: 'single:one', rows: [{ id: 'one' }] },
        { key: 'single:two', rows: [{ id: 'two' }] },
      ],
      () => [],
      () => [],
      (...args) => calls.previews.push(args),
      async (targetPlatform, group) => calls.modals.push({ targetPlatform, group }),
      labels,
      (message, kind) => calls.toasts.push({ message, kind }),
      () => {},
    );

    await openAction('shopee', 'register');

    assert.equal(calls.modals.length, 0, 'multi-selected register must not open multiple modals at once');
    assert.equal(calls.previews.length, 1, 'multi-selected register must keep the confirm-first preview');
    assert.equal(calls.toasts.length, 1, 'multi-selected register must explain the confirmation step');
  }
});

test('platform SKU mapping button syncs only the selected products for the current platform', async () => {
  const platformSyncSelectedFactory = new Function(
    'platformSelectedGroups',
    'platformVisibleGroups',
    'syncPlatformSkusForProductIds',
    'renderPlatformWorkbenches',
    'showToast',
    'PLATFORM_LABELS',
    `${extractFunctionBlock(html, 'platformSyncSelected')}; return platformSyncSelected;`,
  );
  const labels = { shopee: 'Shopee', joom: 'Joom', qoo10: 'Qoo10', ebay: 'eBay' };

  for (const platform of Object.keys(labels)) {
    const calls = { syncs: [], renders: [], toasts: [] };
    const button = { textContent: `${labels[platform]} SKU mapping`, disabled: false };
    const syncSelected = platformSyncSelectedFactory(
      () => [{ rows: [{ id: `${platform}-one` }, { id: `${platform}-two` }] }],
      () => [],
      async (ids, platforms) => calls.syncs.push({ ids, platforms }),
      () => calls.renders.push(platform),
      (message, kind) => calls.toasts.push({ message, kind }),
      labels,
    );

    await syncSelected(platform, button);

    assert.deepEqual(calls.syncs, [{
      ids: [`${platform}-one`, `${platform}-two`],
      platforms: [platform],
    }], `${platform} SKU mapping must stay scoped to the current platform and selected products`);
    assert.deepEqual(calls.renders, [platform], `${platform} SKU mapping should rerender after sync`);
    assert.equal(button.disabled, false, `${platform} SKU mapping button should be restored`);
    assert.equal(button.textContent, `${labels[platform]} SKU mapping`, `${platform} SKU mapping button label should be restored`);
  }

  {
    const calls = { syncs: [] };
    const syncSelected = platformSyncSelectedFactory(
      () => [],
      () => [{ rows: [{ id: 'visible-only' }] }],
      async (ids, platforms) => calls.syncs.push({ ids, platforms }),
      () => {},
      () => {},
      labels,
    );

    await syncSelected('joom', null);

    assert.deepEqual(calls.syncs, [{
      ids: ['visible-only'],
      platforms: ['joom'],
    }], 'one visible filtered product should be used without widening beyond the current platform');
  }
});

test('platform delete cleanup stays scoped to selected product IDs', () => {
  const deleteTargets = extractFunctionBlock(html, 'platformDeleteTargets');
  const deleteRemote = extractFunctionBlock(html, 'platformDeleteRemoteListing');

  assert.match(deleteTargets, /const productIds = platformGroupProductIds\(group\)/, 'delete targets must be derived from the selected platform group');
  assert.match(deleteTargets, /platform === 'joom'[\s\S]*product_ids: productIds/, 'Joom delete targets must carry only the selected master product IDs');
  assert.match(deleteTargets, /platform === 'qoo10'[\s\S]*product_ids: productIds/, 'Qoo10 delete targets must carry only the selected master product IDs');
  assert.match(deleteTargets, /platform === 'ebay'[\s\S]*product_ids: \[row\.id\]\.filter\(Boolean\)/, 'eBay delete targets must be narrowed per selected row');
  assert.match(deleteRemote, /let body = \{ dry_run: false, reset_local: true, confirm: confirmPhrase \}/, 'delete execution must request local mapping cleanup with an explicit confirmation phrase');
  assert.match(deleteRemote, /product_ids: target\.product_ids \|\| \[\]/, 'bridge delete calls must forward the scoped product_ids list');
});

test('Shopee register modal clears internal focus before aria-hidden close', () => {
  assert.match(
    shopeeRegisterClose,
    /overlay\.contains\(document\.activeElement\)[\s\S]*document\.activeElement\.blur\(\)[\s\S]*overlay\.setAttribute\('aria-hidden', 'true'\)/,
    'Shopee register modal must blur focused modal controls before hiding the overlay',
  );
});

test('standalone products have master edit button and master tab stays platform-neutral', () => {
  assert.match(productRender, /plActionButtonsHtml\(plMasterEditTargetKey\(p\), \[p\.id\], p\.sku \|\| productName\)/, 'single row should expose master edit target in the Actions column');
  assert.doesNotMatch(productRender, /const editButton = !isGroupChild/, 'single row edit button should not render inside the product title');
  assert.match(html, /function plActionButtonsHtml\(editTarget, deleteIds, label\)/, 'product list should share one edit/delete action helper');
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

test('master product list resolves image candidates before text fallback', () => {
  const factory = new Function(
    `${extractFunctionBlock(html, 'plImageUrlFromShopeeId')}
     ${extractFunctionBlock(html, 'plImageCandidateValues')}
     ${extractFunctionBlock(html, 'plPickImageUrl')}
     ${extractFunctionBlock(html, 'plMainImage')}
     ${extractFunctionBlock(html, 'plGroupMainImage')}
     return { plMainImage, plGroupMainImage };`,
  );
  const { plMainImage, plGroupMainImage } = factory();

  assert.equal(
    plMainImage({ main_image: '', shopee_option_image_url: '', extra_images: ['https://cdn.example/cover.jpg'] }),
    'https://cdn.example/cover.jpg',
    'single rows should use stored image arrays before showing the artist text fallback',
  );
  assert.equal(
    plGroupMainImage([{ main_image: '' }, { observed: { main_image_urls: ['https://cdn.example/observed.jpg'] } }]),
    'https://cdn.example/observed.jpg',
    'group rows should use observed/source representative images when DB main_image is blank',
  );
  assert.equal(
    plMainImage({ shopee_image_id: 'abc123' }),
    'https://cf.shopee.sg/file/abc123',
    'Shopee image IDs should still render as CDN thumbnails',
  );
});

test('master product list backfills missing representative images from StarOneMall', () => {
  assert.match(html, /const PL_REPRESENTATIVE_IMAGE_BACKFILL_LIMIT = 8/, 'backfill must stay bounded on product-list load');
  assert.match(html, /function plBackfillMissingRepresentativeImages\(products\)/, 'product list should expose a representative image backfill helper');
  assert.match(html, /await db\.auth\.getSession\(\)/, 'backfill must require the signed-in Supabase session');
  assert.match(html, /fetch\(STARONE_CRAWL_URL,[\s\S]*write_to_source_records: false/, 'backfill should crawl StarOneMall without creating source records');
  assert.match(html, /const patch = \{ main_image: mainImage \}/, 'backfill must persist the crawled representative image into products.main_image');
  assert.match(html, /void plBackfillMissingRepresentativeImages\(state\.products\)[\s\S]*renderProducts\(\);[\s\S]*renderPlatformWorkbenches\(\);/, 'loadData should refresh the UI after image backfill');
});

test('selected master register avoids SKU collision checks against unchecked cards', () => {
  assert.match(masterRegisterPromote, /const activeGroups = promotableGroups\.filter\(mrGroupSelected\)/, 'master register should build an explicit selected-card set');
  assert.match(masterRegisterPromote, /const crossSkuMap = new Map\(\)[\s\S]*for \(const g of activeGroups\)/, 'cross-card SKU map must only include selected cards');
  assert.doesNotMatch(masterRegisterPromote, /const crossSkuMap = new Map\(\)[\s\S]{0,400}for \(const g of groups\)/, 'unchecked cards must not block selected-card registration');
});

test('master registration persists representative images on every created product row', () => {
  assert.match(html, /function mrProductMainImageFromRow\(row\)/, 'register flow should centralize the product main image source');
  assert.match(html, /function mrProductExtraImagesFromRow\(row\)/, 'register flow should centralize detail image persistence');
  assert.match(masterRegisterPromote, /main_image:\s*productMainImage \|\| null/, 'created/reused rows must persist products.main_image after promotion');
  assert.match(masterRegisterPromote, /extra_images:\s*mrProductExtraImagesFromRow\(row\)/, 'created/reused rows must persist detail images after promotion');
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

test('master edit modal supports auto-generated editable SKUs', () => {
  assert.match(masterEditSkuHelpers, /function plMasterEditAutoSku/, 'master edit should expose an auto SKU helper');
  assert.match(masterEditSkuHelpers, /autoMasterSkuForRow\(row/, 'master edit auto SKU should use the shared generator');
  assert.match(masterEdit, /data-field="sku"[\s\S]*data-sku-mode="\$\{text\(skuMode\)\}"/, 'SKU input should track auto/manual mode');
  assert.match(masterEdit, /data-auto-sku-apply="1"/, 'SKU input should include an Auto regenerate button');
  assert.match(masterEdit, /skuInput\.dataset\.skuMode = 'manual'/, 'typing in SKU should switch to manual mode');
  assert.match(masterEdit, /plMasterEditRefreshSkuInput\(tr, true\)/, 'Auto button should force regeneration');
  assert.match(html, /plMasterEditRefreshAutoSkus\(false\)/, 'master name or lifecycle changes should refresh auto-mode SKUs');
  assert.match(masterEditOpenSave, /const seenSkus = new Set\(\)/, 'master edit save should detect duplicate SKUs before updating rows');
});

test('READY STOCK transition is moved into product list PRE ORDER filter and PRE ORDER nav tab is removed', () => {
  assert.doesNotMatch(nav, /showView\('view-pre-order'\)/, 'PRE ORDER top-level tab should be removed');
  assert.match(productsView, /id="po-ready-stock-open"/, 'READY STOCK transition button should be in product list toolbar');
  assert.match(productsView, /id="pl-ready-stock-panel-host"/, 'READY STOCK wizard host should be inside product list view');
  assert.match(html, /function ensureReadyStockPanelInProductList\(\)/, 'READY STOCK wizard panel should be moved into the product list host at runtime');
  assert.match(html, /function updateProductListReadyStockButton\(lifecycleFilter\)/, 'button visibility should be tied to product list lifecycle filter');
});

test('master register flow has a manual option-image management modal and sends selected component images to Vision', () => {
  assert.match(masterRegisterImageTools, /function mrOpenOptionImageModal\(group\)/, 'option image management modal should exist');
  assert.match(masterRegisterImageTools, /옵션 이미지 관리/, 'modal should be labeled for operators');
  assert.match(masterRegisterImageTools, /type: 'checkbox', checked: true/, 'each crawled option image should be removable with a keep checkbox');
  assert.match(masterRegisterImageTools, /type: 'checkbox', name: 'mr-component-image-url'/, 'operator should be able to pick multiple component extraction images');
  assert.match(masterRegisterImageTools, /mrSetGroupOptionImages\(group, kept, picked\)/, 'modal save should persist removed images and selected component images');
  assert.match(masterRegisterImageTools, /function mrGroupComponentImageUrls\(group\)/, 'selected component images should be read as an array');
  assert.match(masterRegisterImageTools, /_components_image_urls/, 'selected component images should be stored on preview rows');
  assert.match(masterRegisterImageTools, /image_url: componentImageUrls\[0\] \|\| ''/, 'Vision extraction should keep a first-image URL for backward compatibility');
  assert.match(masterRegisterImageTools, /image_urls: componentImageUrls/, 'Vision extraction should send all operator-selected component images');
  assert.match(masterRegisterImageTools, /image_data_urls: imageDataUrls/, 'Vision extraction should send browser-prepared image tiles when available');
  assert.match(masterRegisterImageTools, /mrNormalizeComponentsText/, 'Vision result should be normalized into one deduplicated component list');
});

test('platform SKU sync includes Shopee lookup-sku and absorbs matched region ids', () => {
  assert.match(platformSync, /const allowed = \['shopee', 'joom', 'qoo10', 'ebay'\]/, 'product list platform sync default targets should include Shopee');
  assert.match(platformSync, /const targetPlatforms = normalizePlatformSyncTargets\(options\.platforms\)/, 'platform SKU sync should accept a narrowed platform target list');
  assert.match(platformSync, /async function syncPlatformSkusForProductIds\(productIds, platforms = null\)[\s\S]*return await syncPlatformSkus\(\{ platforms \}\)/, 'platform tab SKU mapping should pass selected product IDs with narrowed platform targets');
  assert.doesNotMatch(platformSync, /rollupListedCountForLed\(rollup, platform\) > 0\)[\s\S]{0,120}continue;/, 'green LED rows must be remotely rechecked instead of skipped');
  assert.match(platformSync, /const wasListed = rollupListedCountForLed\(rollup, platform\) > 0/, 'sync should remember whether a green LED is being verified');
  assert.match(platformSync, /coverageClearPlatformMapping\(group\.id, platform, hit\)/, 'remote not-found should clear stale local LED mappings');
  assert.match(coverageLookup, /coverageLookupShopeePublishedBySku/, 'Shopee lookup should use the shared platform lookup entrypoint');
  assert.match(coverageLookup, /coverageNormalizeShopeeSkuLookupHit/, 'Shopee lookup-sku response should be normalized before absorb');
  assert.match(coverageLookup, /SHOPEE_BRIDGE\}\/lookup-sku\?\$\{qs\.toString\(\)\}/, 'Shopee sync should call the bridge SKU lookup route');
  assert.match(coverageLookup, /qs\.append\('item_name', productName\)/, 'Shopee sync should pass the selected master product name for remote item-name lookup');
  assert.match(coverageLookup, /regions: SHOPEE_PLATFORM_ACTIVE_REGIONS\.join\(','\)/, 'Shopee lookup should check every active marketplace region');
  assert.match(coverageLookup, /coverageAbsorbShopeePublishedHit/, 'Shopee hit should be absorbed into product_shopee_listings');
  assert.match(coverageLookup, /coverageClearShopeePublishedMappings/, 'Shopee not-found should mark product_shopee_listings as not_listed');
  assert.match(coverageLookup, /raw: lookupRaw/, 'Shopee not-found should preserve the bridge debug payload instead of reducing it to a generic skip');
  assert.match(coverageLookup, /upsert\(rows, \{ onConflict: SHOPEE_LISTING_CONFLICT \}\)/, 'Shopee not-found should persist checked regions so the next sync cannot silently skip the same SKU');
  assert.match(coverageLookup, /platform === 'shopee' \|\| platform === 'joom' \? 'health' : 'healthz'/, 'Shopee SKU sync must call shopee-bridge /health, not /healthz, so selected rows are not skipped as unavailable');
  assert.match(coverageLookup, /coverageShopeePublishedItemsFromRaw/, 'Shopee sync should normalize bridge and cached published list shapes');
  assert.match(coverageLookup, /result\?\.response\?\.published_item/, 'Shopee bridge published_list shape should be accepted');
  assert.match(coverageLookup, /SHOPEE_BRIDGE\}\/published_list\?\$\{qs\.toString\(\)\}/, 'Shopee sync should keep published_list as a global-item fallback');
  assert.match(coverageLookup, /coverageLookupShopeeLocalRowsByItemInfo/, 'Shopee stale shop item rows should be verified by item_info when global_item_id is unavailable');
  assert.doesNotMatch(coverageLookup, /if \(localHit\) return coverageNormalizeShopeePublishedHit/, 'Shopee sync must not trust cached local rows before remote verification');
  assert.doesNotMatch(coverageLookup, /row\?\.shopee_item_id \|\| row\?\.platform_item_id/, 'products.shopee_item_id is a global id and must not be treated as shop_item_id');
  assert.match(coverageLookup, /global_region_hits/, 'Shopee sync should consume Global Product SKU hits separately from shop listing hits');
  assert.match(coverageLookup, /global_model_id: entry\.global_model_id \|\| entry\.model_id \|\| entry\.globalModelId \|\| null/, 'Shopee global lookup hits should preserve global_model_id');
  assert.match(coverageLookup, /entry\.region && \(entry\.shop_item_id \|\| entry\.global_item_id\)/, 'Shopee global lookup hits without shop_item_id must not be filtered out');
  assert.match(coverageLookup, /global_item_id: row\.global_item_id \|\| null/, 'absorbed listing should preserve global_item_id for later price/sync operations');
  assert.match(coverageLookup, /global_model_id: row\.global_model_id \|\| null/, 'absorbed listing should preserve global_model_id for later Global Product operations');
  assert.match(coverageSkuCheck, /const targetPlatforms = \['shopee', 'joom', 'qoo10', 'ebay'\]/, 'coverage SKU check should also include Shopee');
  assert.match(coverageSkuCheck, /if \(platform === 'shopee'\) await coverageAbsorbShopeePublishedHit/, 'coverage Shopee hits should be absorbed through product_shopee_listings');
});

test('Shopee Global Product SKU lookup hits map without shop listing ids', async () => {
  const normalizeFactory = new Function(
    `${extractFunctionBlock(html, 'coverageNormalizeShopeeSkuLookupHit')}; return coverageNormalizeShopeeSkuLookupHit;`,
  );
  const normalize = normalizeFactory();
  const hit = normalize({
    ok: true,
    found: true,
    not_found: false,
    global_region_hits: [{
      region: 'SG',
      sku: 'T4-TEA-WEONF-SOL-EJ',
      global_item_id: 57356515280,
      global_model_id: 292422335253,
      global_model_sku: 'T4-TEA-WEONF-SOL-EJ',
      match_type: 'global_model_sku',
      lookup_source: 'global_model_list',
    }],
  }, 'T4-TEA-WEONF-SOL-EJ');

  assert.equal(hit.found, true, 'global-only lookup hit should count as found');
  assert.equal(hit.notFound, false, 'global-only lookup hit must not be treated as not_found');
  assert.equal(hit.platformItemId, 57356515280, 'global_item_id should be the fallback platform id for Shopee-tab mapping');
  assert.equal(hit.regionHits[0].shop_item_id, null, 'Global Product SKU mapping must not invent shop_item_id values');
  assert.equal(hit.regionHits[0].global_model_id, 292422335253, 'global_model_id should survive normalization');

  const calls = [];
  const db = {
    from(table) {
      return {
        upsert(payload, options) {
          calls.push({ table, payload, options });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  const absorbFactory = new Function(
    'db',
    'SHOPEE_DEFAULT_ACCOUNT_KEY',
    'SHOPEE_LISTING_CONFLICT',
    `${extractFunctionBlock(html, 'coverageAbsorbShopeePublishedHit')}; return coverageAbsorbShopeePublishedHit;`,
  );
  const absorb = absorbFactory(db, 'starphotocard', 'product_id,account_key,region');
  const count = await absorb('product-1', hit);

  assert.equal(count, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, 'product_shopee_listings');
  assert.equal(calls[0].payload.region, 'SG');
  assert.equal(calls[0].payload.global_item_id, 57356515280);
  assert.equal(calls[0].payload.global_model_id, 292422335253);
  assert.equal(calls[0].payload.shop_item_id, null);
  assert.equal(calls[0].payload.status, 'mapped');
});

test('Shopee not-found SKU sync records checked regions instead of disappearing as a skip', async () => {
  const clearFactory = new Function(
    'db',
    'SHOPEE_DEFAULT_ACCOUNT_KEY',
    'SHOPEE_LISTING_CONFLICT',
    'SHOPEE_PLATFORM_ACTIVE_REGIONS',
    `${html.includes('function coverageShopeeLookupRegions(') ? extractFunctionBlock(html, 'coverageShopeeLookupRegions') : ''}
     ${extractFunctionBlock(html, 'coverageClearShopeePublishedMappings')};
     return coverageClearShopeePublishedMappings;`,
  );
  const calls = [];
  const chain = {
    eq() { return chain; },
    select() { return Promise.resolve({ data: [], error: null }); },
  };
  const db = {
    from(table) {
      return {
        update(payload) {
          calls.push({ type: 'update', table, payload });
          return chain;
        },
        upsert(rows, options) {
          calls.push({ type: 'upsert', table, rows, options });
          return {
            select() {
              return Promise.resolve({
                data: rows.map((row) => ({ product_id: row.product_id, account_key: row.account_key, region: row.region })),
                error: null,
              });
            },
          };
        },
      };
    },
  };
  const clear = clearFactory(db, 'starphotocard', 'product_id,account_key,region', Object.freeze(['SG', 'TW', 'TH', 'MY', 'PH', 'BR']));
  const count = await clear('product-1', {
    error: 'shopee_sku_not_found',
    raw: {
      source: 'lookup-sku',
      regions: ['SG', 'TW'],
      region_results: [
        { region: 'SG', not_found: true, search_item_name: ['WE ON FIRE SOLO VER'] },
        { region: 'TW', not_found: true, search_item_name: ['WE ON FIRE SOLO VER'] },
      ],
    },
  });
  const upsert = calls.find((call) => call.type === 'upsert');
  assert.ok(upsert, 'not-found lookup should upsert explicit not_listed rows for checked Shopee regions');
  assert.equal(count, 2, 'clear should report the number of checked regions persisted');
  assert.deepEqual(upsert.rows.map((row) => row.region), ['SG', 'TW']);
  assert.equal(upsert.options.onConflict, 'product_id,account_key,region');
  assert.ok(upsert.rows.every((row) => row.status === 'not_listed' && row.shop_item_id === null && row.shop_model_id === null));
  assert.equal(upsert.rows[0].raw_payload.raw.region_results[0].search_item_name[0], 'WE ON FIRE SOLO VER');
});

test('Shopee not-listed SKU lookup rows render as missing instead of error', () => {
  const stateFactory = new Function(
    `${extractFunctionBlock(html, 'shopeePlatformDetailState')}; return shopeePlatformDetailState;`,
  );
  const detailState = stateFactory();
  assert.equal(
    detailState({ status: 'not_listed', last_error: 'shopee_sku_not_found', shop_item_id: null, global_item_id: null }),
    'missing',
    'not_listed rows persisted by SKU lookup should stay in the missing bucket even with debug last_error text',
  );
  assert.equal(
    detailState({ status: 'error', last_error: 'publish failed' }),
    'error',
    'real error rows should still render as error',
  );
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
