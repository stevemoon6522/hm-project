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

const docsReadme = readApiRef('README.md');
const productCreateRef = readApiRef('product-create.graphql.md');
const variantsBulkRef = readApiRef('product-variants-bulk-create.graphql.md');
const inventoryRef = readApiRef('inventory-set-quantities.graphql.md');
const publishRef = readApiRef('publishable-publish.graphql.md');

assert.match(docsReadme, /product-create\.graphql\.md/, 'Shopify README must index productCreate local docs');
assert.match(docsReadme, /product-variants-bulk-create\.graphql\.md/, 'Shopify README must index variant bulk create local docs');
assert.match(productCreateRef, /write_products/, 'productCreate doc must record write_products scope');
assert.match(variantsBulkRef, /REMOVE_STANDALONE_VARIANT/, 'variant doc must record standalone variant removal strategy');
assert.match(inventoryRef, /write_inventory/, 'inventory doc must record write_inventory scope');
assert.match(publishRef, /write_publications/, 'publish doc must record write_publications scope');

const dispatcher = read('supabase', 'functions', 'platform-publish', 'index.ts');
const shopifyAdapter = read('supabase', 'functions', 'platform-publish', 'adapters', 'shopify.ts');
const shopifyBridge = read('supabase', 'functions', 'shopify-bridge', 'index.ts');
const edgeShopifyBridge = read('edge-functions', 'shopify-bridge', 'index.ts');
const shopifyOAuthCallback = read('api', 'shopify-oauth-callback.js');
const html = read('v2', 'index.html');
const supabaseConfig = read('supabase', 'config.toml');
const migration = read('supabase', 'migrations', '202606270001_shopify_product_registration.sql');

for (const token of [
  "import { shopifyAdapter } from './adapters/shopify.ts'",
  'shopify: shopifyAdapter',
  "new Set(['shopee', 'joom', 'qoo10', 'ebay', 'alibaba', 'shopify'])",
  "const AUTH_VERIFIED_GATED = new Set(['qoo10', 'alibaba', 'shopify'])",
  "['joom', 'qoo10', 'ebay', 'shopify'].includes(platform)",
  'shopify: (body as any).shopify || {}',
]) {
  assert.match(dispatcher, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `platform-publish must wire Shopify token: ${token}`);
}

assert.match(shopifyAdapter, /supports: new Set\(\['create_listing', 'sync'\]\)/, 'Shopify adapter must expose MVP create_listing and sync only');
assert.match(shopifyAdapter, /bridgePost\('create-product'/, 'Shopify adapter must route creates through shopify-bridge create-product');
assert.match(shopifyAdapter, /bridgeGet\('lookup-sku'/, 'Shopify adapter must sync by SKU through shopify-bridge');
assert.match(shopifyAdapter, /publishableGroupRows\(ctx\.masterProduct/, 'Shopify adapter must support grouped master variants');
assert.match(shopifyAdapter, /productVariantsBulkCreate/, 'Shopify adapter dry-run payload must expose variant bulk intent');
assert.match(shopifyAdapter, /option_products/, 'Shopify adapter must return option mapping hints for grouped creates');
assert.match(shopifyAdapter, /listingStatus: ctx\.dryRun \? 'draft' : 'draft'/, 'Shopify create must remain draft-first in MVP');

for (const [label, source] of [['Supabase', shopifyBridge], ['edge mirror', edgeShopifyBridge]]) {
  assert.match(source, /SHOPIFY_API_VERSION/, `${label} Shopify bridge must pin an Admin API version`);
  assert.match(source, /authorization-code grant/, `${label} Shopify bridge must document OAuth source`);
  assert.match(source, /function requireBridgeTokenOrAuthenticatedUser/, `${label} Shopify bridge must allow internal platform-publish and signed-in browser calls`);
  assert.match(source, /action === 'oauth-url'/, `${label} Shopify bridge must expose OAuth URL bootstrap`);
  assert.match(source, /action === 'oauth-callback'/, `${label} Shopify bridge must expose OAuth callback exchange`);
  assert.match(source, /action === 'create-product'/, `${label} Shopify bridge must expose product creation`);
  assert.match(source, /action === 'lookup-sku'/, `${label} Shopify bridge must expose SKU lookup`);
  assert.match(source, /productCreate/, `${label} Shopify bridge must call productCreate`);
  assert.match(source, /productVariantsBulkCreate/, `${label} Shopify bridge must call productVariantsBulkCreate`);
  assert.match(source, /inventorySetQuantities/, `${label} Shopify bridge must include gated inventory support`);
  assert.match(source, /publishablePublish/, `${label} Shopify bridge must include gated publish support`);
  assert.match(source, /scopeSet\.has\('write_products'\)/, `${label} Shopify bridge must verify product write scope before enabling create_listing`);
  assert.match(source, /missing_scopes/, `${label} Shopify bridge must report missing Shopify product scopes`);
  assert.doesNotMatch(source, /stack: e\?\.stack/, `${label} Shopify bridge must not expose stack traces`);
}

assert.match(supabaseConfig, /\[functions\.shopify-bridge\]\s+verify_jwt = false/s, 'Shopify OAuth callback must be allowed through Supabase gateway');
assert.match(shopifyOAuthCallback, /SHOPIFY_BRIDGE_CALLBACK/, 'Vercel OAuth callback relay must target shopify-bridge');
assert.match(shopifyOAuthCallback, /target\.search = incoming\.search/, 'Vercel OAuth callback relay must preserve Shopify query parameters');
assert.match(shopifyOAuthCallback, /shopee-dashboard-kohl\.vercel\.app/, 'Vercel OAuth callback relay must keep the app host aligned with Shopify Application URL');

for (const token of [
  "('shopify')",
  "('shopify', 'create_listing', true, false",
  "('shopify', 'sync', true, false",
  'create table if not exists public.shopify_shops',
  'default_location_gid',
  'default_publication_gid',
  "cross join (values ('joom'), ('qoo10'), ('ebay'), ('shopify'))",
  "v_platform not in ('joom', 'qoo10', 'ebay', 'shopify')",
  "platform in ('shopee','joom','qoo10','ebay','alibaba','shopify')",
]) {
  assert.match(migration, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Shopify migration must include ${token}`);
}

for (const token of [
  "showView('view-platform-shopify')",
  'id="view-platform-shopify"',
  'id="platform-shopify-root"',
  "const PLATFORM_TABS = Object.freeze(['shopee', 'joom', 'qoo10', 'ebay', 'alibaba', 'shopify'])",
  'shopify: {',
  'Shopify Draft',
  "platform === 'shopify' ? 'create_listing' :",
  "coverageBridgeUrl('shopify')",
  "coverageLookupViaPlatformPublish('shopify', sku, productId)",
]) {
  assert.match(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `V2 UI must include ${token}`);
}

console.log('Shopify product registration checks passed');
