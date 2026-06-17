import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');

function sliceBetween(source, start, end) {
  const s = source.indexOf(start);
  assert.notEqual(s, -1, `missing start token: ${start}`);
  const e = source.indexOf(end, s);
  assert.ok(e > s, `missing end token after ${start}`);
  return source.slice(s, e);
}

const optionHelpers = sliceBetween(
  html,
  'function plCanonicalOptionParts(value) {',
  'function plProductName(product) {',
);
const masterEditPatches = sliceBetween(
  html,
  'function plMasterEditReadOptionPatches(rows) {',
  'async function saveProductMasterEditModal() {',
);

class FakeInput {
  constructor(value) {
    this.value = value;
  }
}

class FakeTr {
  constructor(id, fields) {
    this.dataset = { productId: id };
    this.fields = fields;
  }

  querySelector(selector) {
    const match = selector.match(/data-field="([^"]+)"/);
    return match ? new FakeInput(this.fields[match[1]] ?? '') : null;
  }
}

function buildMasterEditReader(fakeTrs) {
  return new Function(
    'document',
    'stripNonMarketplaceText',
    'hasNonMarketplaceText',
    `${optionHelpers}\n${masterEditPatches}\nreturn plMasterEditReadOptionPatches;`,
  )(
    { querySelectorAll: () => fakeTrs },
    (value) => String(value || '').replace(/[^\x20-\x7E]/g, '').trim(),
    (value) => /[^\x00-\x7F]/.test(String(value || '')),
  );
}

const arirangRows = [
  {
    id: 'ar1',
    option_name: 'ROOTED IN KOREA',
    variation_tier_names: ['Version', 'Member'],
    variation_option_names: ['ROOTED IN KOREA VER', 'ROOTED IN KOREA'],
    variation_tier_index: [0, 0],
  },
  {
    id: 'ar2',
    option_name: 'ROOTED IN MUSIC',
    variation_tier_names: ['Version', 'Member'],
    variation_option_names: ['ROOTED IN MUSIC VER', 'ROOTED IN MUSIC'],
    variation_tier_index: [0, 1],
  },
  {
    id: 'ar3',
    option_name: 'SET',
    variation_tier_names: ['Version', 'Member'],
    variation_option_names: ['2 VER SET', 'SET'],
    variation_tier_index: [0, 2],
  },
];

const arirangReader = buildMasterEditReader([
  new FakeTr('ar1', { sku: 'M4-BTS-ARIRA-PHO-ROOTED-IN-KOREA', option_name: 'ROOTED IN KOREA VER', cost_krw: '10000', weight_g: '300', shopee_option_image_url: 'https://img/k.jpg' }),
  new FakeTr('ar2', { sku: 'M4-BTS-ARIRA-PHO-ROOTED-IN-MUSIC', option_name: 'ROOTED IN MUSIC VER', cost_krw: '10000', weight_g: '300', shopee_option_image_url: 'https://img/m.jpg' }),
  new FakeTr('ar3', { sku: 'M4-BTS-ARIRA-PHO-SET', option_name: '2 VER SET', cost_krw: '20000', weight_g: '600', shopee_option_image_url: 'https://img/s.jpg' }),
]);
const arirangPatches = arirangReader(arirangRows);
assert.deepEqual(
  arirangPatches.map((item) => item.patch.variation_option_names),
  [['ROOTED IN KOREA VER'], ['ROOTED IN MUSIC VER'], ['2 VER SET']],
  'ARIRANG master edit should store one canonical Version option per row',
);
assert.deepEqual(
  arirangPatches.map((item) => item.patch.variation_tier_names),
  [['Version'], ['Version'], ['Version']],
  'ARIRANG redundant secondary axis should be collapsed at save time',
);
assert.deepEqual(
  arirangPatches.map((item) => item.patch.variation_tier_index),
  [[0], [1], [2]],
  'ARIRANG tier indexes should be rewritten for the collapsed Version axis',
);

const trueTwoAxisRows = [
  { id: 'a1', option_name: 'A', variation_tier_names: ['MEMBER', 'VERSION'], variation_option_names: ['A', 'X'], variation_tier_index: [0, 0] },
  { id: 'a2', option_name: 'A', variation_tier_names: ['MEMBER', 'VERSION'], variation_option_names: ['A', 'Y'], variation_tier_index: [0, 1] },
  { id: 'b1', option_name: 'B', variation_tier_names: ['MEMBER', 'VERSION'], variation_option_names: ['B', 'X'], variation_tier_index: [1, 0] },
  { id: 'b2', option_name: 'B', variation_tier_names: ['MEMBER', 'VERSION'], variation_option_names: ['B', 'Y'], variation_tier_index: [1, 1] },
];
const twoAxisReader = buildMasterEditReader([
  new FakeTr('a1', { sku: 'SKU-A-X', option_name: 'A / X', cost_krw: '1', weight_g: '1', shopee_option_image_url: 'https://img/a-x.jpg' }),
  new FakeTr('a2', { sku: 'SKU-A-Y', option_name: 'A / Y', cost_krw: '1', weight_g: '1', shopee_option_image_url: 'https://img/a-y.jpg' }),
  new FakeTr('b1', { sku: 'SKU-B-X', option_name: 'B / X', cost_krw: '1', weight_g: '1', shopee_option_image_url: 'https://img/b-x.jpg' }),
  new FakeTr('b2', { sku: 'SKU-B-Y', option_name: 'B / Y', cost_krw: '1', weight_g: '1', shopee_option_image_url: 'https://img/b-y.jpg' }),
]);
const twoAxisPatches = twoAxisReader(trueTwoAxisRows);
assert.deepEqual(
  twoAxisPatches.map((item) => item.patch.variation_option_names),
  [['A', 'X'], ['A', 'Y'], ['B', 'X'], ['B', 'Y']],
  'true two-axis products should keep both option axes when saved unchanged',
);
assert.deepEqual(
  twoAxisPatches.map((item) => item.patch.variation_tier_index),
  [[0, 0], [0, 1], [1, 0], [1, 1]],
  'true two-axis products should keep two-dimensional tier indexes',
);

const ebayGroupBuilderBlock = sliceBetween(
  html,
  'function plBuildEbayPublishGroupFromProducts(rows) {',
  'let _mrQoo10 = {',
);
const buildEbayGroup = new Function(
  'rshSortedProducts',
  'plIsGroupedVariant',
  'plOptionDisplay',
  'stripNonMarketplaceText',
  'window',
  'plParentSku',
  'productKindIsGoods',
  'productKindDefaults',
  'productKindOfRow',
  'PLATFORM_EBAY_DEFAULT_CATEGORY_ID',
  'crypto',
  `${optionHelpers}\n${ebayGroupBuilderBlock}\nreturn plBuildEbayPublishGroupFromProducts;`,
)(
  (rows) => rows.slice(),
  (row) => !!row.product_group_id,
  (row) => (Array.isArray(row.variation_option_names) && row.variation_option_names.length ? row.variation_option_names.join(' / ') : String(row.option_name || '').trim()),
  (value) => String(value || '').replace(/[^\x20-\x7E]/g, '').trim(),
  { mrDeriveFromTitle: () => ({ artist: 'BTS', album: 'ARIRANG', version: '' }) },
  () => 'M4-BTS-ARIRA-PHO',
  () => false,
  () => ({ ebay_category_id: '176984' }),
  () => 'album',
  '176984',
  { randomUUID: () => 'uuid' },
);

const ebayGroup = buildEbayGroup([
  { id: 'ar1', product_group_id: 'g1', sku: 'M4-BTS-ARIRA-PHO-ROOTED-IN-KOREA', product_name: '[READY STOCK] (BTS) ARIRANG Rooted in Korea ver. / Rooted in Music ver.', option_name: 'ROOTED IN KOREA VER', variation_tier_names: ['Version', 'Member'], variation_option_names: ['ROOTED IN KOREA VER', 'ROOTED IN KOREA'], ebay_variation_value: 'ROOTED IN KOREA', cost_krw: 10000, weight_g: 300, inventory: 3 },
  { id: 'ar2', product_group_id: 'g1', sku: 'M4-BTS-ARIRA-PHO-ROOTED-IN-MUSIC', product_name: '[READY STOCK] (BTS) ARIRANG Rooted in Korea ver. / Rooted in Music ver.', option_name: 'ROOTED IN MUSIC VER', variation_tier_names: ['Version', 'Member'], variation_option_names: ['ROOTED IN MUSIC VER', 'ROOTED IN MUSIC'], ebay_variation_value: 'ROOTED IN MUSIC', cost_krw: 10000, weight_g: 300, inventory: 3 },
  { id: 'ar3', product_group_id: 'g1', sku: 'M4-BTS-ARIRA-PHO-SET', product_name: '[READY STOCK] (BTS) ARIRANG Rooted in Korea ver. / Rooted in Music ver.', option_name: '2 VER SET', variation_tier_names: ['Version', 'Member'], variation_option_names: ['2 VER SET', 'SET'], ebay_variation_value: 'SET', cost_krw: 20000, weight_g: 600, inventory: 3 },
]);
assert.deepEqual(ebayGroup.tierNames, ['Version'], 'eBay publish group should collapse one-to-one stale axes to Version');
assert.equal(ebayGroup.twoAxis, false, 'eBay publish group should not treat stale one-to-one axes as a real two-axis listing');
assert.deepEqual(
  ebayGroup.rows.map((row) => row._ebayVariationValue),
  ['ROOTED IN KOREA VER', 'ROOTED IN MUSIC VER', '2 VER SET'],
  'eBay draft rows should use normalized master option names instead of stale ebay_variation_value',
);
assert.deepEqual(
  ebayGroup.rows.map((row) => row._opt0),
  ['ROOTED IN KOREA VER', 'ROOTED IN MUSIC VER', '2 VER SET'],
  'eBay modal option labels should be seeded from master option names',
);

const joomGroupBuilderBlock = sliceBetween(
  html,
  'function plBuildJoomPublishGroupFromProducts(rows) {',
  'function plBuildEbayPublishGroupFromProducts(rows) {',
);
const buildJoomGroup = new Function(
  'rshSortedProducts',
  'plIsGroupedVariant',
  'plOptionDisplay',
  'stripNonMarketplaceText',
  'window',
  'plParentSku',
  'normalizeJoomCategoryId',
  'productKindDefaults',
  'productKindOfRow',
  'crypto',
  `${optionHelpers}\n${joomGroupBuilderBlock}\nreturn plBuildJoomPublishGroupFromProducts;`,
)(
  (rows) => rows.slice(),
  (row) => !!row.product_group_id,
  (row) => (Array.isArray(row.variation_option_names) && row.variation_option_names.length ? row.variation_option_names.join(' / ') : String(row.option_name || '').trim()),
  (value) => String(value || '').replace(/[^\x20-\x7E]/g, '').trim(),
  { mrDeriveFromTitle: () => ({ artist: 'BTS', album: 'ARIRANG' }) },
  () => 'M4-BTS-ARIRA-PHO',
  (value) => String(value || ''),
  () => ({ joom_category_id: 'music-cd' }),
  () => 'album',
  { randomUUID: () => 'uuid' },
);

const joomGroup = buildJoomGroup([
  { id: 'ar1', product_group_id: 'g1', sku: 'M4-BTS-ARIRA-PHO-ROOTED-IN-KOREA', product_name: '[READY STOCK] (BTS) ARIRANG Rooted in Korea ver. / Rooted in Music ver.', option_name: 'ROOTED IN KOREA VER', variation_tier_names: ['Version', 'Member'], variation_option_names: ['ROOTED IN KOREA VER', 'ROOTED IN KOREA'], cost_krw: 10000, weight_g: 300, inventory: 3 },
  { id: 'ar2', product_group_id: 'g1', sku: 'M4-BTS-ARIRA-PHO-ROOTED-IN-MUSIC', product_name: '[READY STOCK] (BTS) ARIRANG Rooted in Korea ver. / Rooted in Music ver.', option_name: 'ROOTED IN MUSIC VER', variation_tier_names: ['Version', 'Member'], variation_option_names: ['ROOTED IN MUSIC VER', 'ROOTED IN MUSIC'], cost_krw: 10000, weight_g: 300, inventory: 3 },
  { id: 'ar3', product_group_id: 'g1', sku: 'M4-BTS-ARIRA-PHO-SET', product_name: '[READY STOCK] (BTS) ARIRANG Rooted in Korea ver. / Rooted in Music ver.', option_name: '2 VER SET', variation_tier_names: ['Version', 'Member'], variation_option_names: ['2 VER SET', 'SET'], cost_krw: 20000, weight_g: 600, inventory: 3 },
]);
assert.deepEqual(joomGroup.tierNames, ['Version'], 'Joom publish group should collapse one-to-one stale axes to Version');
assert.deepEqual(
  joomGroup.rows.map((row) => row._opt0),
  ['ROOTED IN KOREA VER', 'ROOTED IN MUSIC VER', '2 VER SET'],
  'Joom modal option labels should be seeded from normalized master option names',
);

const ebayVariationOptions = sliceBetween(
  html,
  'function mrEbayBuildVariationOptions(draftBase) {',
  'function mrEbayValidateDraft(draft) {',
);
assert.doesNotMatch(
  ebayVariationOptions,
  /row\?\.ebay_variation_value/,
  'eBay variation option builder must not fall back to stale persisted platform option values',
);

console.log('v2 master option sync checks passed');
