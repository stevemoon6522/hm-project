import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const bridge = readFileSync(join(root, 'supabase', 'functions', 'shopee-bridge', 'index.ts'), 'utf8');

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

const rshCore = sliceBetween(
  html,
  'function rshSortedProducts(rows) {',
  'function rshRefreshVariantRegionPrices',
);
const rshTierBuilder = sliceBetween(
  html,
  'function rshBuildTierVariation(products) {',
  'function rshBuildGroupRegisterPayload',
);

const context = {
  console,
};

const code = `
const _rsh = { globalOptionImageIds: { 'RS-BTS-ARIRANG-KR': 'sg-img-korea', 'RS-BTS-ARIRANG-MU': 'sg-img-music' } };
const document = { getElementById: () => null };
function stripNonMarketplaceText(value) { return String(value || '').replace(/[^\\x20-\\x7E]/g, '').trim(); }
function hasNonMarketplaceText(value) { return /[^\\x00-\\x7F]/.test(String(value || '')); }
function plTierSortKey(product) {
  const idx = Array.isArray(product?.variation_tier_index) ? product.variation_tier_index : [];
  const tier = idx.map((n) => String(Number(n) || 0).padStart(4, '0')).join('.');
  return tier + '|' + String(product?.sku || '');
}
function plOptionDisplay(product) {
  if (Array.isArray(product?.variation_option_names)) {
    const values = product.variation_option_names.map((v) => String(v || '').trim()).filter(Boolean);
    if (values.length) return values.join(' / ');
  }
  return String(product?.option_name || '').trim();
}
function plParentSku(rows) {
  const skus = rows.map((p) => String(p.sku || '').trim()).filter(Boolean);
  if (!skus.length) return '';
  let prefix = skus[0];
  for (let i = 1; i < skus.length; i += 1) {
    while (prefix && !skus[i].startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return (prefix || skus[0]).replace(/[-_]+$/, '');
}
${rshCore}
${rshTierBuilder}
function check(condition, message) { if (!condition) throw new Error(message); }
function same(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(message + ': expected ' + e + ', got ' + a);
}

const rootedProducts = [
  {
    id: 'p1',
    sku: 'RS-BTS-ARIRANG-KR',
    variation_tier_names: ['ARTIST', 'VERSION'],
    variation_option_names: ['BTS', 'Rooted in Korea ver.'],
    variation_tier_index: [0, 0],
  },
  {
    id: 'p2',
    sku: 'RS-BTS-ARIRANG-MU',
    variation_tier_names: ['ARTIST', 'VERSION'],
    variation_option_names: ['BTS', 'Rooted in Music ver.'],
    variation_tier_index: [0, 1],
  },
];
const rootedSpec = rshBuildVariationSpec(rootedProducts);
same(rootedSpec.tierVariation.map((t) => t.name), ['VERSION'], 'singleton first axis should collapse to the varying axis');
same(rootedSpec.tierVariation[0].option_list.map((o) => o.option), ['Rooted in Korea ver.', 'Rooted in Music ver.'], 'version options should be preserved in order');
same(rootedProducts.map((p, i) => rootedSpec.tierIndexForProduct(p, i)), [[0], [1]], 'collapsed model tier_index must match one effective tier');
same(rshBuildTierVariation(rootedProducts), rootedSpec.tierVariation, 'public tier builder should use variation spec');
check(rootedSpec.tierVariation[0].option_list.every((o) => o.image?.image_id), 'single effective axis keeps per-option image ids');

const arirangProducts = [
  {
    id: 'ar1',
    sku: 'M4-BTS-ARIRA-PHO-ROOTED IN KOREA',
    variation_tier_names: ['Version', 'Member'],
    variation_option_names: ['ROOTED IN KOREA VER', 'ROOTED IN KOREA'],
    variation_tier_index: [0, 0],
  },
  {
    id: 'ar2',
    sku: 'M4-BTS-ARIRA-PHO-ROOTED IN MUSIC',
    variation_tier_names: ['Version', 'Member'],
    variation_option_names: ['ROOTED IN MUSIC VER', 'ROOTED IN MUSIC'],
    variation_tier_index: [0, 1],
  },
  {
    id: 'ar3',
    sku: 'M4-BTS-ARIRA-PHO-SET',
    variation_tier_names: ['Version', 'Member'],
    variation_option_names: ['2 VER SET', 'SET'],
    variation_tier_index: [0, 2],
  },
];
const arirangSpec = rshBuildVariationSpec(arirangProducts);
same(arirangSpec.tierVariation.map((t) => t.name), ['Version'], 'ARIRANG one-to-one duplicate axes should collapse to Version');
same(arirangSpec.tierVariation[0].option_list.map((o) => o.option), ['ROOTED IN KOREA VER', 'ROOTED IN MUSIC VER', '2 VER SET'], 'ARIRANG options should use the Version axis');
same(arirangProducts.map((p, i) => arirangSpec.tierIndexForProduct(p, i)), [[0], [1], [2]], 'ARIRANG model tier_index must be one-dimensional');

const fullTwoAxisProducts = [
  { id: 'a1', sku: 'SKU-A-X', variation_tier_names: ['MEMBER', 'VERSION'], variation_option_names: ['A', 'X'], variation_tier_index: [0, 0] },
  { id: 'a2', sku: 'SKU-A-Y', variation_tier_names: ['MEMBER', 'VERSION'], variation_option_names: ['A', 'Y'], variation_tier_index: [0, 1] },
  { id: 'b1', sku: 'SKU-B-X', variation_tier_names: ['MEMBER', 'VERSION'], variation_option_names: ['B', 'X'], variation_tier_index: [1, 0] },
  { id: 'b2', sku: 'SKU-B-Y', variation_tier_names: ['MEMBER', 'VERSION'], variation_option_names: ['B', 'Y'], variation_tier_index: [1, 1] },
];
const twoAxisSpec = rshBuildVariationSpec(fullTwoAxisProducts);
same(twoAxisSpec.tierVariation.map((t) => t.name), ['MEMBER', 'VERSION'], 'true two-axis products keep two tiers');
same(twoAxisSpec.tierVariation.map((t) => t.option_list.map((o) => o.option)), [['A', 'B'], ['X', 'Y']], 'two-axis option lists should be axis-specific');
same(fullTwoAxisProducts.map((p, i) => twoAxisSpec.tierIndexForProduct(p, i)), [[0, 0], [0, 1], [1, 0], [1, 1]], 'two-axis tier indexes should remain two-dimensional');
check(twoAxisSpec.tierVariation.every((t) => t.option_list.every((o) => !o.image)), 'two-axis option images are not attached to ambiguous first-tier options');
`;

vm.runInNewContext(code, context);

for (const token of [
  'function validateVariationTierIndexes',
  'tier_index length mismatch for model in position',
  "stage: 'variation_preflight'",
  "error: 'invalid_variation'",
  'mandatoryRegions.includes(regionCode)',
  "name.includes('adult')",
  'requestPayload.attribute_list = attribute_list',
  'item.attribute_list = attributeList',
  'function buildStandardiseTierVariation',
  'variation_option_id',
  'variation_option_name',
  'item.standardise_tier_variation = standardiseTierVariation',
  'async function verifyPublishedListOutcome',
  'async function retryTwMinimalPublish',
  'async function syncShopModelPricesAfterPublish',
  "targetRegion === 'TW'",
  'tw_minimal_item_retry',
  "publish_status: 'verified_via_published_list_retry_'",
  'async function recordRegistrationMapping',
  "action === 'record_registration_mapping'",
  'const denied = requireInternalBridge(req)',
  ".from('product_shopee_listings')",
]) {
  assert(bridge.includes(token), `Shopee bridge regression guard missing token: ${token}`);
}

console.log('v2 Shopee tier_index regression checks passed');
