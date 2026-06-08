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
  'return mrMasterProductName(row).replace',
  'preservePublishedVariationValue',
  '🟣 ${productName}',
  '📌 Contents',
  "The item price do not included import duties",
  'function mrEbayBuildVariationOptions',
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
  'openRegisterEbayGroupModal(btn.dataset.openEbayGroup)',
  'openRegisterEbayGroupModal(btn.dataset.openEbaySingle)',
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
]) {
  assert(edge.includes(token), `ebay-bridge variation flow missing token: ${token}`);
}

console.log('v2 eBay K-pop listing flow static checks passed');
