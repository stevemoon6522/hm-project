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
assert(productList.includes('data-open-shopee-group'), 'master group row must expose a Shopee register button');
assert(productList.includes('openRegisterShopeeGroupModal'), 'group register button must open the Shopee modal');

for (const token of [
  'const RSH_PRODUCT_SELECT',
  'async function openRegisterShopeeGroupModal(productGroupId)',
  "mode: 'group'",
  'rshRenderVariantSection',
  'rshBuildTierVariation',
  'rshBuildGroupRegisterPayload',
  'rshRegisterGroupViaCbsc',
  '/register_cbsc',
  'variation: {',
  'tier_variation: rshBuildTierVariation(products)',
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
  rshModal.includes('master.main_image')
    && rshModal.includes('rshUseDirectImage(master.main_image'),
  'group modal must use attached master images without requiring StarOneMall crawl',
);
assert(
  rshModal.includes('update({ shopee_image_id: coverImageId })')
    && rshModal.includes('updateQuery.in')
    && rshModal.includes('rshProductIds()'),
  'image upload cache must be saved back to every product in the option group',
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
