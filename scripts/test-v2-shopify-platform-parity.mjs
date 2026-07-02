import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const apiRefRoot = 'C:\\dev\\api-refs\\marketplaces\\shopify';

function readApiRef(file) {
  const path = join(apiRefRoot, file);
  assert.equal(existsSync(path), true, `Shopify local API ref missing: ${path}`);
  return readFileSync(path, 'utf8');
}

const html = read('v2', 'index.html');
const adapter = read('supabase', 'functions', 'platform-publish', 'adapters', 'shopify.ts');
const platformPublish = read('supabase', 'functions', 'platform-publish', 'index.ts');
const shopifyBridge = read('supabase', 'functions', 'shopify-bridge', 'index.ts');
const edgeShopifyBridge = read('edge-functions', 'shopify-bridge', 'index.ts');
const capabilityMigration = read('supabase', 'migrations', '202607020002_shopify_platform_parity.sql');

const variantsBulkUpdateRef = readApiRef('product-variants-bulk-update.graphql.md');
const tagsAddRef = readApiRef('tags-add.graphql.md');
assert.match(variantsBulkUpdateRef, /productVariantsBulkUpdate/, 'local Shopify docs must cover mapped variant price updates');
assert.match(tagsAddRef, /additive/i, 'local Shopify docs must preserve the additive tag-sync constraint');

for (const token of [
  "shopify: ['price']",
  "editLabel: 'Price sync'",
  "deleteLabel: 'Archive'",
  "data-platform-preview=\"delete\"",
  "if (platform === 'shopify')",
  "archive-product",
  "cleanup_action: 'archive_product'",
  "Shopify archive complete",
  "['shopee', 'joom', 'qoo10', 'ebay', 'shopify'].includes(platform)",
  "case 'shopify':",
  "catExecuteShopifySync",
  "platform=eq.shopify",
  "catShopifyMapping(product)",
  "catComputeShopifyPrice",
  "capability: 'update_price_qty'",
]) {
  assert.match(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `V2 Shopify parity token missing: ${token}`);
}

assert.match(html, /if \(platform !== 'shopify'\) buttons\.push\(`<button type="button" data-platform-master-sync-needed/, 'Shopify master-sync must remain hidden until a non-destructive metadata path is implemented');
assert.doesNotMatch(html, /SHOPIFY_PRICE_POLICY_DEFAULTS[\s\S]*include_shipping_in_price:\s*true/, 'Shopify price sync must keep shipping out of product price by default');

assert.match(adapter, /supports: new Set\(\['create_listing', 'sync', 'update_price_qty'\]\)/, 'Shopify adapter must expose price update capability through platform-publish');
assert.match(adapter, /bridgePost\('reprice-products'/, 'Shopify adapter must route repricing through shopify-bridge');
assert.match(adapter, /master_product_ids/, 'Shopify adapter must send a selected master_product_ids filter to repricing');
assert.match(adapter, /Shopify update_price_qty found no mapped Shopify variant rows/, 'Shopify adapter must fail selected repricing when mappings are missing');
assert.doesNotMatch(adapter, /inventorySetQuantities[\s\S]*updatePriceQty/, 'Shopify price sync must not push inventory in the update_price_qty path');

for (const [label, source] of [['Supabase', shopifyBridge], ['edge mirror', edgeShopifyBridge]]) {
  assert.match(source, /function normalizeIdList/, `${label} Shopify bridge must normalize selected repricing filters`);
  assert.match(source, /masterProductIds/, `${label} Shopify bridge must accept master_product_ids filters`);
  assert.match(source, /listingIds/, `${label} Shopify bridge must accept listing_ids filters`);
  assert.match(source, /\.in\('master_product_id', masterProductIds\)/, `${label} Shopify bridge must restrict repricing to selected master products`);
  assert.match(source, /\.in\('id', listingIds\)/, `${label} Shopify bridge must restrict repricing to selected listing rows`);
}

assert.match(platformPublish, /platformLookupShopId\(platform, raw, shop_id\)/, 'platform-publish must preserve Shopify shop_domain as shop_id when writing listings');
assert.match(platformPublish, /p_shop_id:\s*platformLookupShopId\(platform, raw, shop_id\)/, 'platform-publish generic upsert must use Shopify bridge shop_domain when available');
assert.match(platformPublish, /p_raw_payload:\s*\{ capability, publish_request_id, platform_item_id: adapterResult\.platformItemId, option \}/, 'grouped create absorb path must remain intact while Shopify parity is added');

assert.match(capabilityMigration, /set docs_ready = true[\s\S]*where platform = 'shopify'[\s\S]*capability = 'update_price_qty'/, 'migration must enable Shopify update_price_qty docs gate');
assert.match(capabilityMigration, /product-variants-bulk-update\.graphql\.md/, 'migration must reference local Shopify variant price update docs');

console.log('V2 Shopify platform parity checks passed');
