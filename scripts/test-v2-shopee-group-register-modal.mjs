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

assert(html.includes('id="rsh-variant-section"'), 'Shopee modal must show grouped option rows');
assert(html.includes('id="rsh-variant-body"'), 'Shopee modal must have a variant tbody');
assert(html.includes('Basic Information · Product Images'), 'Shopee modal must mirror Seller Center basic image section');
assert(html.includes('id="rsh-product-name" type="text"'), 'Shopee modal must allow editing the Shopee product name');
assert(html.includes('id="rsh-desc-reset"'), 'Shopee modal must allow regenerating the Seller Center description');
assert(html.includes('Sales Information · Variations'), 'Shopee modal must include Seller Center sales information section');
assert(html.includes('id="rsh-variation-name"'), 'Shopee modal must expose the Variation1 name field');
assert(
  html.includes('id="rsh-var-bulk-sourcing"') && html.includes('id="rsh-var-bulk-price"') && html.includes('id="rsh-var-bulk-stock"'),
  'Shopee modal must expose bulk sourcing/settlement/stock inputs',
);
assert(html.includes('id="rsh-ship-weight-kg"'), 'Shopee modal must expose Shipping weight in kg');
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
  'rshReadBrandObject',
  'rshReadVariantInputs',
  'rshComputeRegionPrice',
  'rshBuildSingleRegionPrices',
  'rshBuildTierVariation',
  'rshBuildGroupRegisterPayload',
  'rshRegisterGroupViaCbsc',
  '/register_cbsc',
  'variation: {',
  'tier_variation: tierVariation',
  'condition: rshReadCondition()',
  'persistMappings(json, payload)',
]) {
  assert(rshModal.includes(token), `group Shopee modal missing token: ${token}`);
}

assert(
  rshModal.includes('product_group_id')
    && rshModal.includes('variation_tier_names')
    && rshModal.includes('variation_option_names')
    && rshModal.includes('variation_tier_index'),
  'group modal must load variation metadata from products',
);
assert(
  rshModal.includes('await rshCrawlImages(master.staronemall_url)')
    && rshModal.indexOf('if (master.staronemall_url)') < rshModal.indexOf('} else if (_rsh.cachedImageId'),
  'group modal must prefer StarOneMall layered cover over stale cached/raw master images',
);
assert(
  rshModal.includes('COD Policy')
    && rshModal.includes('components_extracted_en')
    && rshModal.includes('rshDescriptionTemplate'),
  'Shopee description must include COD policy and extracted components when available',
);
assert(
  html.includes('도매가 KRW')
    && html.includes('정산가 KRW')
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
    && rshModal.includes('STARONEMALL_LAYER_VERSION'),
  'group modal must build a shop-layer cover and upload StarOneMall detail images after it',
);
assert(
  rshModal.includes('rshUploadOptionImages')
    && rshModal.includes('entry.image = { image_id: optionImageId }')
    && rshModal.includes('globalOptionImageIds'),
  'group modal must upload master option images and attach them to Shopee variation options',
);
assert(
  rshModal.includes("if (_rsh.mode === 'group')")
    && rshModal.includes('rshRegisterGroupViaCbsc(session, activeRegions, dtsValues, lifecycle, errorEl)'),
  'Stage 2 must route grouped products to the direct variation register flow',
);
assert(
  rshModal.includes("status: info.ok === false ? 'error' : 'mapped'")
    || html.includes("status: info.ok === false ? 'error' : 'mapped'"),
  'Shopee listing mappings must store mapped/error LED statuses',
);

console.log('v2 Shopee grouped register modal checks passed');
