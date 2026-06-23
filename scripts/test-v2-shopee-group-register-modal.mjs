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
const productList = sliceBetween(html, 'function renderProducts() {', 'function beginEditCell(cell) {');
const rshModal = sliceBetween(
  html,
  'PHASE B — NEW SHOPEE REGISTER MODAL',
  '// P2-1: Legacy modal URL flag',
);
const rshBatchHelper = sliceBetween(
  html,
  'async function shopeeRegisterCbscWithRegionBatches(payload, headers, options = {})',
  'async function fetchShopModels(region, itemId, accountKeyOverride)',
);

assert(html.includes('id="rsh-variant-section"'), 'Shopee modal must show grouped option rows');
assert(html.includes('id="rsh-variant-body"'), 'Shopee modal must have a variant tbody');
assert(!html.includes('Basic Information · Product Images'), 'Shopee image section must not show the old Basic Information product-image heading');
assert(html.includes('id="rsh-image-toolbar"'), 'Shopee image section must keep a compact image toolbar without the old heading');
assert(html.includes('id="rsh-product-name" type="text"'), 'Shopee modal must allow editing the Shopee product name');
assert(html.includes('id="rsh-desc-reset"'), 'Shopee modal must allow regenerating the Seller Center description');
assert(html.includes('Sales Information · Variations'), 'Shopee modal must include Seller Center sales information section');
assert(html.includes('id="rsh-variation-name"'), 'Shopee modal must expose the Variation1 name field');
assert(html.includes('id="rsh-cover-preview"'), 'Shopee modal must show a separate representative image preview');
assert(html.includes('id="rsh-detail-preview"'), 'Shopee modal must show a separate detail image preview');
assert(html.includes('image_id_list[0]') && html.includes('image_id_list[1..8]'), 'Shopee modal image roles must distinguish cover and detail image_id positions');
assert(html.includes('id="rsh-image-source-label"') && html.includes('Source thumbnails - click one thumbnail to set the Shopee representative image.'), 'Shopee modal must label the source thumbnail selector separately from upload roles');
assert(html.includes('id="rsh-image-upload-label"') && html.includes('Shopee upload order preview'), 'Shopee modal must label the actual Shopee upload order preview');
assert(html.includes('id="rsh-cover-role-card"') && html.includes('id="rsh-detail-role-card"'), 'Shopee modal must render visually distinct cover/detail role cards');
assert(
  html.includes('id="rsh-var-bulk-sourcing"') && html.includes('id="rsh-var-bulk-price"') && html.includes('id="rsh-var-bulk-stock"'),
  'Shopee modal must expose bulk sourcing/settlement/stock inputs',
);
assert(html.includes('id="rsh-ship-weight-kg"'), 'Shopee modal must expose Shipping weight in kg');
assert(html.includes('id="rsh-stock" type="number"'), 'Shopee modal must expose single-product stock input');
assert(html.includes('id="rsh-others-section"'), 'Shopee modal must include Others/Condition section');
assert(productList.includes('data-open-shopee-group'), 'master group row must expose a Shopee register button');
assert(productList.includes('openRegisterShopeeGroupModal'), 'group register button must open the Shopee modal');

for (const token of [
  'const RSH_PRODUCT_SELECT',
  'async function openRegisterShopeeGroupModal(productGroupId)',
  "mode: 'group'",
  'rshRenderVariantSection',
  'rshFormatShopeeProductName',
  'rshReadProductName',
  'rshCanonicalShopeeProductName',
  'rshReadBrandObject',
  'rshReadVariantInputs',
  'rshComputeRegionPrice',
  'rshBuildSingleRegionPrices',
  'rshBuildTierVariation',
  'rshNormalizeRegionalGlobalModelPrices',
  'Shopee option name must be English before registration',
  'rshBuildGroupRegisterPayload',
  'rshRegisterOptionGroupViaCbsc',
  'rshRegisterGroupViaCbsc',
  'shopeeRegisterCbscWithRegionBatches',
  'variation: {',
  'tier_variation: tierVariation',
  'condition: rshReadCondition()',
  'persistMappings(json, payload)',
]) {
  assert(rshModal.includes(token), `group Shopee modal missing token: ${token}`);
}

assert(html.includes("'publish_to_region'") || html.includes('"publish_to_region"'), 'Shopee batch helper must call publish_to_region for follow-up region batches');
assert(
  html.includes('id="rsh-existing-region-section"')
    && html.includes('id="rsh-publish-missing-btn"')
    && rshModal.includes('rshRefreshExistingPublishPlans')
    && rshModal.includes('rshPublishMissingRegionsOnly'),
  'Shopee modal must expose a DB-backed missing-region-only publish action',
);
assert(
  /publishExistingOnly[\s\S]*shopeeBridgePostJson\('publish_to_region'[\s\S]*if \(targets\.length <= SHOPEE_REGISTER_REGION_BATCH_SIZE\)/.test(rshBatchHelper),
  'existing Global Product publish must route through publish_to_region before the normal register_cbsc branch',
);
assert(
  !/register_cbsc/.test(sliceBetween(rshBatchHelper, 'if (publishExistingOnly) {', 'if (targets.length <= SHOPEE_REGISTER_REGION_BATCH_SIZE)')),
  'existing Global Product missing-region publish must not call register_cbsc or create a new Global Product',
);
assert(
  rshModal.includes('rshApplyShopeePublishStateFromListings')
    && rshModal.includes('payload?.publish_existing_global_only === true')
    && rshModal.includes('hasRenderedTargetRows'),
  'missing-region-only publish must persist failed rows and compute product state from all listing mappings',
);

assert(
  rshModal.includes('product_group_id')
    && rshModal.includes('variation_tier_names')
    && rshModal.includes('variation_option_names')
    && rshModal.includes('variation_tier_index'),
  'group modal must load variation metadata from products',
);
assert(
  rshModal.includes('async function rshUseMasterImages(master')
    && rshModal.includes('function rshMasterDetailImageRefs(master)')
    && rshModal.includes('function rshActiveDetailImageSources()')
    && rshModal.includes('function rshRenderImageRolePreview()')
    && rshModal.includes("kind: 'master-layered-cover'")
    && rshModal.includes('detailRefs.slice(0, REGISTER_MAX_IMAGE_IDS - 1)')
    && rshModal.indexOf('if (master.main_image)') < rshModal.indexOf('} else if (master.staronemall_url)'),
  'group modal must prefer master main_image/extra_images, with StarOneMall crawl only as fallback',
);
assert(
  rshModal.includes('id="rsh-attr-brand-select"')
    && rshModal.includes('rshLoadBrandOptions')
    && rshModal.includes('rshPopulateBrandSelect')
    && rshModal.includes('rshSyncBrandHidden')
    && rshModal.includes('SHOPEE_BRIDGE}/global_brands?'),
  'Shopee modal must load and show registered Shopee Global brand options',
);
assert(
  rshModal.includes('COD Policy')
    && rshModal.includes('[Official & Authentic K-POP Album]')
    && rshModal.includes('[Contents]')
    && rshModal.includes('[Important Notice]')
    && rshModal.includes('[COD Policy]')
    && rshModal.includes('components_extracted_en')
    && rshModal.includes('rshDescriptionTemplate'),
  'Shopee description must include API-safe COD policy and extracted components when available',
);
assert(
  !rshModal.includes('master.shopee_description')
    && !rshModal.includes('_rsh.master.shopee_description'),
  'Shopee transfer must generate description at send time without reading saved master shopee_description',
);
assert(
  html.includes('도매가 KRW')
    && html.includes('정산가 KRW')
    && html.includes('stock_override: stockOverride')
    && html.includes('stage1Updates.inventory = stockOverride')
    && rshModal.includes('model_sku: String(v.sku')
    && rshModal.includes('stock: Number(v.stock || 0)'),
  'group modal must transmit visible option sourcing/settlement/stock/SKU fields',
);
assert(
  rshModal.includes('calculateShopeePrice')
    && rshModal.includes('modelForRegion(region)')
    && rshModal.includes('price: calc.originalPrice')
    && rshModal.includes('region_prices: rshBuildSingleRegionPrices'),
  'Shopee registration must calculate and send V1-derived per-region prices',
);
assert(
  rshModal.includes('shopee_extra_image_ids: extraImageIds')
    && rshModal.includes('updateQuery.in')
    && rshModal.includes('rshProductIds()'),
  'image upload cache must save cover and detail image IDs back to every product in the option group',
);
assert(
  rshModal.includes('rshBuildLayeredCoverDataUrl')
    && rshModal.includes('rshBuildDetailUploadRefs')
    && rshModal.includes('const detailSources = rshActiveDetailImageSources()')
    && rshModal.includes('sdShopeeLayerVersion(accountKey)'),
  'group modal must build a shop-layer cover and upload detail images after it',
);
assert(
  rshModal.includes("badge.textContent = 'Representative'")
    && rshModal.includes('const coverKey = rshImageRefKey((_rsh.selectedImages || [])[0])')
    && rshModal.includes(".filter((ref) => !coverKey || rshImageRefKey(ref) !== coverKey)"),
  'Shopee image UI must mark the representative thumbnail and exclude it from detail uploads',
);
assert(
  rshModal.includes('description: rshDescriptionForRegistration')
    && rshModal.includes('function rshPlainTextDescription')
    && rshModal.includes('function rshLooksLikeHtmlDescription')
    && html.includes("shopee_description: document.getElementById('rsh-description')?.value || ''"),
  'Shopee registration must sanitize option-group descriptions while preserving the single publish description input path',
);
assert(
  rshModal.includes('name: productName || parentSku')
    && rshModal.includes('const shopeeProductName = rshCanonicalShopeeProductName(lifecycle)')
    && html.includes('shopee_product_name: shopeeProductName'),
  'Shopee registration must forward the canonical modal product name for group and single publish flows',
);
assert(
  rshModal.includes('rshUploadOptionImages')
    && rshModal.includes('function rshOptionImageUrl(product)')
    && rshModal.includes('const src = rshOptionImageUrl(row)')
    && rshModal.includes('entry.image = { image_id: optionImageId }')
    && rshModal.includes('globalOptionImageIds'),
  'group modal must upload master option images and attach them to Shopee variation options',
);
assert(
  rshModal.includes("return String(product?.shopee_option_image_url || '').trim();")
    && rshModal.includes('function rshHasExplicitOptionImages')
    && rshModal.includes("rshHasExplicitOptionImages() && !_rsh.accountGlobalOptionImageIds")
    && rshModal.includes("!regionsOverride && _rsh.mode === 'group' && rshHasExplicitOptionImages()")
    && rshModal.includes("console.warn('[rsh] optional Shopee option image skipped:'")
    && rshModal.includes("'선택 사항'")
    && !rshModal.includes("product?._main_image || ''"),
  'Shopee option images must be optional and must not block registration when absent or skipped',
);
assert(
  rshModal.includes("if (_rsh.mode === 'group')")
    && rshModal.includes('rshRegisterOptionGroupViaCbsc(session, activeRegions, dtsValues, lifecycle, errorEl)'),
  'Stage 2 must route grouped products to the direct variation register flow',
);
assert(
  html.includes("const listingStatus = hasItemId && info.ok !== false ? 'mapped' : 'failed'")
    && html.includes("d.status === 'error' || d.status === 'failed' || d.status === 'rejected'"),
  'Shopee listing mappings must store mapped/failed LED statuses',
);

console.log('v2 Shopee grouped register modal checks passed');
