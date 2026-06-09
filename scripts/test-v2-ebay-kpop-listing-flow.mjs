import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const htmlPath = join(root, 'v2', 'index.html');
const edgePath = join(root, 'supabase', 'functions', 'ebay-bridge', 'index.ts');
const edgeMirrorPath = join(root, 'edge-functions', 'ebay-bridge', 'index.ts');
const migrationPath = join(root, 'supabase', 'migrations', '202606020003_ebay_kpop_variation_publish.sql');
const planPath = join(root, 'plans', 'ebay-kpop-listing-process-plan.md');

for (const path of [htmlPath, edgePath, edgeMirrorPath, migrationPath, planPath]) {
  assert.equal(existsSync(path), true, `${path} must exist`);
}

const html = readFileSync(htmlPath, 'utf8');
const edge = readFileSync(edgePath, 'utf8');
const edgeMirror = readFileSync(edgeMirrorPath, 'utf8');
const migration = readFileSync(migrationPath, 'utf8');
const plan = readFileSync(planPath, 'utf8');

const parserStart = html.indexOf('    function mrStripNonAscii');
const parserEnd = html.indexOf('    function mrUpdateStage1Summary', parserStart);
assert(parserStart >= 0 && parserEnd > parserStart, 'title parser block must be extractable');
const deriveFromTitle = new Function(
  'stripNonMarketplaceText',
  'hasNonMarketplaceText',
  `${html.slice(parserStart, parserEnd)}\nreturn mrDeriveFromTitle;`,
)(
  (value) => String(value == null ? '' : value)
    .replace(/[^\x00-\x7F]+/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim(),
  (value) => /[^\x00-\x7F]/.test(String(value || '')),
);
assert.deepEqual(
  deriveFromTitle('[READY STOCK] CORTIS - [ GREENGREEN ] 2ND EP (WEVERSE Ver.)'),
  { artist: 'CORTIS', album: 'GREENGREEN', version: 'WEVERSE', member: '' },
  'READY STOCK prefix must not become the eBay Release Title',
);
assert.deepEqual(
  deriveFromTitle('[READY STOCK] (JENNIE) The 1st Studio Album [Ruby] (CD Digipack)'),
  { artist: 'JENNIE', album: 'Ruby', version: 'CD Digipack', member: '' },
  'JENNIE Ruby Digipack must derive eBay Artist/Release Title/Version from the actual listing title',
);
assert.deepEqual(
  deriveFromTitle('CORTIS (코르티스) The 2nd EP [GREENGREEN] (CORTIS Ball ver.)'),
  { artist: 'CORTIS', album: 'GREENGREEN', version: 'CORTIS Ball', member: '' },
  'existing CORTIS bracket-title derivation must keep working',
);

const descStart = html.indexOf('    function mrEbayDescriptionForPayload');
const descEnd = html.indexOf('    function mrEbayReleaseType', descStart);
assert(descStart >= 0 && descEnd > descStart, 'eBay description payload formatter must be extractable');
const descriptionForPayload = new Function(`${html.slice(descStart, descEnd)}\nreturn mrEbayDescriptionForPayload;`)();
assert.equal(
  descriptionForPayload('Line 1\n\nLine 2'),
  'Line 1<br>\n<br>\nLine 2',
  'eBay payload description must preserve textarea line breaks as HTML breaks',
);

const optionImageStart = html.indexOf('    function mrEbayOptionImageUrl');
const optionImageEnd = html.indexOf('    function mrEbayOptionStock', optionImageStart);
assert(optionImageStart >= 0 && optionImageEnd > optionImageStart, 'eBay option image helper block must be extractable');
const ebayOptionImageUrl = new Function(`${html.slice(optionImageStart, optionImageEnd)}\nreturn mrEbayOptionImageUrl;`)();
assert.equal(
  ebayOptionImageUrl({ _ebayOptionImageUrl: 'manual.jpg', shopee_option_image_url: 'master.jpg', ebay_variation_image_url: 'old.jpg' }),
  'manual.jpg',
  'modal-edited eBay option image must remain first priority',
);
assert.equal(
  ebayOptionImageUrl({ shopee_option_image_url: 'master.jpg', ebay_variation_image_url: 'old.jpg' }),
  'master.jpg',
  'current master option image must override stale saved eBay variation image',
);

const skuLikeStart = html.indexOf('    function mrEbayIsSkuLikeVariationValue');
const skuLikeEnd = html.indexOf('    function mrEbayBuildGroupKey', skuLikeStart);
assert(skuLikeStart >= 0 && skuLikeEnd > skuLikeStart, 'eBay SKU-like variation helper must be extractable');
const isSkuLikeVariationValue = new Function(`${html.slice(skuLikeStart, skuLikeEnd)}\nreturn mrEbayIsSkuLikeVariationValue;`)();
assert.equal(
  isSkuLikeVariationValue('V1-COR-GREEN-WEV-PORTRAIT A', 'V1-COR-GREEN-WEV-PORTRAIT A', 'V1-COR-GREEN-WEV'),
  true,
  'stored SKU-shaped variation values must be discarded in favor of master option names',
);
assert.equal(
  isSkuLikeVariationValue('PORTRAIT A', 'V1-COR-GREEN-WEV-PORTRAIT A', 'V1-COR-GREEN-WEV'),
  false,
  'plain master option names must be preserved',
);

const hash = (s) => createHash('sha256').update(s).digest('hex');
assert.equal(hash(edge), hash(edgeMirror), 'supabase and edge-functions ebay-bridge copies must match');

for (const token of [
  'smallest practical units',
  'Music > CDs',
  'category ID `176984`',
  'Store category: `/K-pop`',
  'fulfillment policy `253030471025`',
  '`ALBUM PRE-ORDER`',
  'PUT /sell/inventory/v1/inventory_item/{sku}',
  'POST /sell/inventory/v1/offer/publish_by_inventory_item_group',
  'deploy only after Steve explicitly requests deployment',
]) {
  assert(plan.includes(token), `eBay K-pop plan missing token: ${token}`);
}

for (const token of [
  'ebay_inventory_group_key',
  'ebay_listing_mode',
  'ebay_variation_axis',
  'ebay_variation_value',
  'ebay_variation_image_url',
  'create table if not exists public.ebay_publish_runs',
  "check (listing_mode in ('single', 'variation'))",
]) {
  assert(migration.includes(token), `eBay variation migration missing token: ${token}`);
}

for (const token of [
  "const MR_EBAY_DEFAULT_CATEGORY_ID = '176984'",
  "const MR_EBAY_STORE_CATEGORY = '/K-pop'",
  "const MR_EBAY_VARIATION_AXIS = 'Version'",
  'function mrEbayPrettyVariationValue',
  'function mrEbayBuildDescription',
  'function mrEbayDescriptionForPayload',
  'return mrMasterProductName(row).replace',
  'function mrStripListingStatusPrefix',
  'function mrFirstMeaningfulBracketValue',
  'function mrFallbackAlbumFromDashRemainder',
  'function mrLeadingUppercaseTokenBlock',
  "mrIsListingStatusTag(storedAlbum) ? '' : storedAlbum",
  'eBay item specific Artist is required for category 176984',
  'eBay item specific Release Title is required for category 176984',
  'preservePublishedVariationValue',
  '🟣 ${productName}',
  '📌 Contents',
  "The item price do not included import duties",
  'function mrEbayBuildVariationOptions',
  'function mrEbayIsSkuLikeVariationValue',
  'mrEbayMasterOptionImageUrl(row)',
  'description: mrEbayDescriptionForPayload(draft.description).slice(0, 4000)',
  "listingMode: 'variation'",
  "listingMode: 'single'",
  "storeCategoryNames: draft.storeCategoryNames",
  "variationAxis: draft.variationAxis",
  "mrEbayBridgeUrl() + action",
  "action = draft.mode === 'variation' ? '/publish-variation' : '/publish'",
  "mrEbayBridgeUrl() + '/lookup-group?inventory_group_key='",
  "data-ebay-var-image",
  'data-open-ebay-group',
  'data-open-ebay-single',
  'window.sdOpenRegisterEbayGroupModal',
  'function openRegisterEbayGroupModal',
  "els.productBody.querySelectorAll('[data-open-ebay-group]')",
  "btn.addEventListener('click', () => openRegisterEbayGroupModal",
  'mrOpenEbayModal(plBuildJoomPublishGroupFromProducts(rows))',
  "'Country of Origin': ['Korea, South']",
]) {
  assert(html.includes(token), `V2 eBay K-pop UI missing token: ${token}`);
}

for (const token of [
  'normalizeStoreCategoryNames',
  'const EBAY_DEFAULT_FULFILLMENT_POLICY_ID = "253030471025"',
  'const EBAY_DEFAULT_FULFILLMENT_POLICY_NAME = "ALBUM PRE-ORDER"',
  'stored.fulfillment_policy_id !== EBAY_DEFAULT_FULFILLMENT_POLICY_ID',
  'fulfillmentPolicyId: EBAY_DEFAULT_FULFILLMENT_POLICY_ID',
  'includeCatalogProductDetails: false',
  'storeCategoryNames: safeStoreCategoryNames',
  'async function handlePublishVariationCore',
  'Inventory docs now require POST for createInventoryLocation',
  'method: "POST"',
  '/sell/inventory/v1/inventory_item_group/',
  '/sell/inventory/v1/offer/publish_by_inventory_item_group',
  'inventoryItemGroupKey: inventoryGroupKey',
  'variantSKUs: skus',
  'aspectsImageVariesBy: [axis]',
  'specifications:',
  'async function handleLookupGroup',
  'ebay_publish_runs',
  'withEbayPublishRun("variation"',
  'validateRequiredMusicAspects(String(categoryId), safeAspects)',
  'const EBAY_KPOP_REQUIRED_ASPECTS = ["Artist", "Release Title"]',
]) {
  assert(edge.includes(token), `ebay-bridge variation flow missing token: ${token}`);
}

console.log('v2 eBay K-pop listing flow static checks passed');
