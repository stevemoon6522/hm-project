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
assert.match(productCreateRef, /status:\s*ACTIVE/, 'productCreate doc must record the current active-first Shopify policy');
assert.match(productCreateRef, /USD/, 'productCreate doc must record Shopify USD pricing policy');
assert.match(variantsBulkRef, /REMOVE_STANDALONE_VARIANT/, 'variant doc must record standalone variant removal strategy');
assert.match(inventoryRef, /write_inventory/, 'inventory doc must record write_inventory scope');
assert.match(publishRef, /write_publications/, 'publish doc must record write_publications scope');

const dispatcher = read('supabase', 'functions', 'platform-publish', 'index.ts');
const shopifyAdapter = read('supabase', 'functions', 'platform-publish', 'adapters', 'shopify.ts');
const shopeeDescription = read('supabase', 'functions', 'platform-publish', '_shared', 'shopee-description.ts');
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
assert.match(shopifyAdapter, /async function preflightShopifyDuplicateSkus/, 'Shopify adapter must preflight duplicate SKUs before live creates');
assert.match(shopifyAdapter, /duplicate_sku_preflight:\s*true/, 'Shopify dry-run payload must declare duplicate SKU preflight coverage');
assert.match(shopifyAdapter, /preflightShopifyDuplicateSkus\(payload, userToken\)/, 'Shopify live create must run duplicate SKU preflight before mutation');
assert.match(shopifyAdapter, /SHOPIFY_DUPLICATE_SKU/, 'Shopify duplicate SKU preflight must return a clear machine-readable marker');
assert.match(shopifyAdapter, /publishableGroupRows\(ctx\.masterProduct/, 'Shopify adapter must support grouped master variants');
assert.match(shopifyAdapter, /productVariantsBulkCreate/, 'Shopify adapter dry-run payload must expose variant bulk intent');
assert.match(shopifyAdapter, /option_products/, 'Shopify adapter must return option mapping hints for grouped creates');
assert.match(shopifyAdapter, /SHOPIFY_DEFAULT_PRICE_POLICY[\s\S]*currency:\s*'USD'[\s\S]*krwPerUsd:\s*1460[\s\S]*targetMarginPct:\s*30[\s\S]*paymentFeePct:\s*1[\s\S]*transactionFeePct:\s*10[\s\S]*includeShippingInPrice:\s*false[\s\S]*defaultStatus:\s*'ACTIVE'[\s\S]*setInventory:\s*false/, 'Shopify adapter must keep the approved USD active-first price policy as the fallback');
assert.match(shopifyAdapter, /async function loadShopifyPricePolicy[\s\S]*\.from\('shopify_price_policy'\)/, 'Shopify adapter must load the approved price policy from DB before creation');
assert.match(shopifyAdapter, /function shopifyPriceFromCostKrw[\s\S]*feePct = policy\.targetMarginPct \+ policy\.paymentFeePct \+ policy\.transactionFeePct \+ policy\.fixedOperationFeePct[\s\S]*denominator = 1 - feePct \/ 100[\s\S]*costKrw \/ policy\.krwPerUsd \/ denominator/, 'Shopify adapter must calculate USD price by backing out margin and percentage fees');
assert.match(shopifyAdapter, /status:\s*shopifyProductStatus\(shopify, policy\)/, 'Shopify adapter must create products with the DB-backed default status');
assert.match(shopifyAdapter, /set_inventory:\s*shopify\.set_inventory === true && policy\.setInventory === true/, 'Shopify adapter must keep Shopify inventory push disabled unless the DB policy enables it');
assert.match(shopifyAdapter, /import \{ shopeeSellerCenterDescription \} from '\.\.\/_shared\/shopee-description\.ts'/, 'Shopify adapter must reuse the Shopee Seller Center description template');
assert.match(shopifyAdapter, /shopeeSellerCenterDescription\(/, 'Shopify adapter must build default descriptionHtml from the Shopee template');
assert.match(shopifyAdapter, /raw\.split\(\/\\n\{2,\}\//, 'Shopify adapter must preserve Shopee template paragraph breaks when converting to HTML');
assert.match(shopeeDescription, /\[Official & Authentic K-POP Album\]/, 'Shared Shopee description template must keep the Seller Center section layout');
assert.match(shopeeDescription, /\[COD Policy\]/, 'Shared Shopee description template must keep the Seller Center COD section');

for (const [label, source] of [['Supabase', shopifyBridge], ['edge mirror', edgeShopifyBridge]]) {
  assert.match(source, /SHOPIFY_API_VERSION/, `${label} Shopify bridge must pin an Admin API version`);
  assert.match(source, /authorization-code grant/, `${label} Shopify bridge must document OAuth source`);
  assert.match(source, /function requireBridgeTokenOrAuthenticatedUser/, `${label} Shopify bridge must allow internal platform-publish and signed-in browser calls`);
  assert.match(source, /action === 'oauth-url'/, `${label} Shopify bridge must expose OAuth URL bootstrap`);
  assert.match(source, /action === 'oauth-callback'/, `${label} Shopify bridge must expose OAuth callback exchange`);
  assert.match(source, /action === 'create-product'/, `${label} Shopify bridge must expose product creation`);
  assert.match(source, /action === 'lookup-sku'/, `${label} Shopify bridge must expose SKU lookup`);
  assert.match(source, /function shopifySearchString/, `${label} Shopify lookup must escape search query values`);
  assert.match(source, /const queryText = `sku:"\$\{escapedSku\}"`/, `${label} Shopify lookup must quote SKU searches so hyphenated SKUs are exact`);
  assert.match(source, /productCreate/, `${label} Shopify bridge must call productCreate`);
  assert.match(source, /function shopifyProductStatus/, `${label} Shopify bridge must sanitize requested Shopify product status`);
  assert.match(source, /status:\s*shopifyProductStatus\(product\.status\)/, `${label} Shopify productCreate must honor the adapter status`);
  const createProductBlock = source.slice(source.indexOf('async function createProduct'), source.indexOf('async function createVariants'));
  assert.doesNotMatch(createProductBlock, /userErrors\s*\{\s*field\s+message\s+code\s*\}/, `${label} Shopify productCreate must not request unsupported UserError.code`);
  assert.match(source, /productVariantsBulkCreate/, `${label} Shopify bridge must call productVariantsBulkCreate`);
  assert.match(source, /async function archiveProduct/, `${label} Shopify bridge must include a product archive cleanup helper`);
  assert.match(source, /productUpdate/, `${label} Shopify bridge must archive failed creates with productUpdate`);
  assert.match(source, /status:\s*'ARCHIVED'/, `${label} Shopify cleanup must set product status to ARCHIVED`);
  assert.match(source, /cleanup_on_variant_failure !== false/, `${label} Shopify bridge must archive created products after variant failure by default`);
  assert.match(source, /cleanup_action:\s*'archive_product'/, `${label} Shopify variant failure response must report archive cleanup`);
  assert.match(source, /action === 'archive-product'/, `${label} Shopify bridge must expose archive-product for manual cleanup`);
  assert.match(source, /inventorySetQuantities/, `${label} Shopify bridge must include gated inventory support`);
  assert.match(source, /publishablePublish/, `${label} Shopify bridge must include gated publish support`);
  assert.match(source, /listing_status:\s*mapShopifyListingStatus\(product\)/, `${label} Shopify bridge must report ACTIVE products as listed even without inventory push`);
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
  'Shopify Active',
  'function platformConfirmShopifyActiveRegistration',
  'Shopify ACTIVE registration will create a live product',
  'platformConfirmShopifyActiveRegistration(groups)',
  "body.shopify = { status: 'ACTIVE' }",
  "platform === 'shopify' ? 'create_listing' :",
  "coverageBridgeUrl('shopify')",
  "coverageLookupViaPlatformPublish('shopify', sku, productId)",
]) {
  assert.match(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `V2 UI must include ${token}`);
}

console.log('Shopify product registration checks passed');
