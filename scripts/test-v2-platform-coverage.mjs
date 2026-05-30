import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '202605280001_v2_existing_platform_import.sql'),
  'utf8',
);
const skuCoverageMigration = readFileSync(
  join(root, 'supabase', 'migrations', '202605290001_sku_coverage_and_absorb_lookup.sql'),
  'utf8',
);
const platformPublish = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'index.ts'), 'utf8');
const joomAdapter = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'joom.ts'), 'utf8');
const ebayAdapter = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'ebay.ts'), 'utf8');
const qoo10Adapter = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'qoo10.ts'), 'utf8');
const ebayBridge = readFileSync(join(root, 'supabase', 'functions', 'ebay-bridge', 'index.ts'), 'utf8');
const edgeJoomBridge = readFileSync(join(root, 'edge-functions', 'joom-bridge', 'index.ts'), 'utf8');
const supabaseJoomBridge = readFileSync(join(root, 'supabase', 'functions', 'joom-bridge', 'index.ts'), 'utf8');
const globalImportMigration = readFileSync(
  join(root, 'supabase', 'migrations', '202605290002_shopee_global_import_master.sql'),
  'utf8',
);

for (const token of [
  'platform_listing_snapshots',
  'platform_listing_match_candidates',
  'platform_listing_coverage',
  'external_variant_id',
  'mapping_status',
  'publish_origin',
  'raw_snapshot_id',
  'joom_product_id',
]) {
  assert(migration.includes(token), `migration must define ${token}`);
}

assert(
  migration.includes('platform_listings_remote_uniq')
    && migration.includes('coalesce(country')
    && migration.includes('external_variant_id'),
  'remote listing uniqueness must include country and variant identity',
);
assert(
  migration.includes("legacy_source', 'products.joom_columns'")
    && migration.includes("insert into public.platform_listings"),
  'migration must backfill legacy products.joom_* mappings into platform_listings',
);

assert(
  migration.includes("coverage_status")
    && migration.includes("'mapped'")
    && migration.includes("'missing'"),
  'coverage view must expose mapped/missing status',
);

assert(html.includes("showView('view-coverage')"), 'V2 nav must expose platform coverage tab');
assert(html.includes('id="view-coverage"'), 'V2 must include platform coverage view');
assert(html.includes('renderCoverageView(false)'), 'showView patch must render coverage on tab activation');
assert(html.includes('async function coverageFetchFromView()'), 'coverage view must prefer DB coverage view');
assert(html.includes('async function coverageFetchFallback()'), 'coverage view must fall back before DB migration is applied');
assert(html.includes("'/rest/v1/platform_listing_coverage'"), 'coverage fetch must call platform_listing_coverage');
assert(html.includes('joom_product_id,joom_variant_id'), 'coverage fallback must include legacy Joom product mappings');
assert(html.includes("pushRow(product.id, 'joom'"), 'coverage fallback must convert legacy Joom mappings into coverage rows');

for (const platform of ['shopee', 'joom', 'qoo10', 'ebay']) {
  assert(html.includes(`value="${platform}"`) || html.includes(`'${platform}'`), `coverage UI must include ${platform}`);
}
assert(!html.includes('value="alibaba"'), 'coverage UI must not expose Alibaba in SKU-dispatch flow');

for (const token of [
  'sku_platform_coverage',
  'absorb_platform_sku_lookup',
  "cross join (values ('joom'), ('qoo10'), ('ebay'))",
  'Alibaba is intentionally excluded',
  'v_platform not in',
  'external_sku',
  'remote_imported',
]) {
  assert(skuCoverageMigration.includes(token), `SKU coverage migration must include ${token}`);
}
assert(!skuCoverageMigration.includes("('alibaba')"), 'SKU coverage migration must not include Alibaba rows');
assert(!globalImportMigration.includes('grant select, insert, update on public.products to authenticated'), 'Shopee import migration must not add broad authenticated products grants');
assert(!globalImportMigration.includes('grant select, insert, update on public.product_shopee_listings to authenticated'), 'Shopee import migration must not add broad authenticated listing grants');
assert(html.includes('id="coverage-sku-check"'), 'coverage UI must include SKU lookup action');
assert(html.includes('async function coverageLookupViaPlatformPublish'), 'coverage UI must route Joom/eBay SKU lookup through platform-publish');
assert(html.includes('async function coverageLookupQoo10BySku'), 'coverage UI must represent Qoo10 lookup state');
assert(html.includes('PLATFORM_PUBLISH') && html.includes("capability: 'sync'"), 'coverage UI must absorb found SKU lookups via platform-publish sync');
assert(!html.includes("coverageBridgeUrl('joom') + '/lookup-sku") && !html.includes("coverageBridgeUrl('ebay') + '/lookup-item"), 'browser Joom/eBay SKU lookup must not call internal bridges directly');
assert(!html.includes("db.rpc('absorb_platform_sku_lookup'"), 'coverage UI must not expose SECURITY DEFINER absorb RPC directly to browser users');

for (const token of [
  "import { joomAdapter } from './adapters/joom.ts'",
  "import { ebayAdapter } from './adapters/ebay.ts'",
  "import { qoo10Adapter } from './adapters/qoo10.ts'",
  'joom: joomAdapter',
  'ebay: ebayAdapter',
  'qoo10: qoo10Adapter',
]) {
  assert(platformPublish.includes(token), `platform-publish must wire ${token}`);
}
for (const [name, source, bridgeToken] of [
  ['Joom', joomAdapter, '/joom-bridge/'],
  ['eBay', ebayAdapter, '/ebay-bridge/'],
]) {
  assert(source.includes('supports: new Set') && source.includes("'create_listing'") && source.includes("'sync'"), `${name} adapter must support create_listing and sync`);
  assert(source.includes(bridgeToken), `${name} adapter must call ${bridgeToken}`);
  assert(source.includes('PLATFORM_VALIDATION_ERROR') && source.includes('PLATFORM_NOT_FOUND'), `${name} adapter must map validation/not-found errors`);
}
assert(qoo10Adapter.includes("supports: new Set(['sync'])") && qoo10Adapter.includes('qoo10 adapter only supports sync'), 'Qoo10 adapter must support sync only and explicitly block create/publish capabilities');
assert(platformPublish.includes('absorb_platform_sku_lookup') && platformPublish.includes('shouldAbsorbLookup'), 'platform-publish sync must absorb remote SKU hits through service-role RPC');
assert(platformPublish.includes('raw_response: adapterResult.rawResponse && dry_run'), 'platform-publish must not return live bridge raw responses to browser callers');
assert(joomAdapter.includes('raw?.joom_enabled !== false') && joomAdapter.includes("return 'listed'"), 'Joom adapter must treat enabled lookup hits as listed');
assert(ebayBridge.includes('requireAuthenticatedUser(req)') && ebayBridge.includes('EBAY_OAUTH_ENDPOINT') && ebayBridge.includes('identity/v1/oauth2/token'), 'eBay bridge must require authenticated users and use a valid OAuth endpoint');
assert(ebayBridge.includes('function requireInternalBridge') && ebayBridge.includes('internal_bridge_required'), 'eBay bridge should retain internal bridge guard helper for server-only routes');
assert(ebayBridge.includes('V2 eBay registration UI calls ebay-bridge directly') && ebayBridge.includes('server-only platform bridge token'), 'eBay publish/lookup routes must allow authenticated browser UI calls without exposing the internal bridge token');
assert(ebayAdapter.includes('x-platform-bridge-token') && ebayAdapter.includes('PLATFORM_BRIDGE_INTERNAL_TOKEN'), 'eBay adapter must forward the internal bridge token when routed through platform-publish');
assert(ebayAdapter.includes('lookupMiss') && ebayAdapter.includes('PLATFORM_NOT_FOUND'), 'eBay adapter must classify ordinary lookup misses as PLATFORM_NOT_FOUND');
assert(ebayAdapter.includes("title.slice(0, 50)"), 'eBay adapter aspect values must be clamped to bridge validation limits');
assert(ebayBridge.includes('upstream_inventory_lookup_failed') && ebayBridge.includes('upstream_offer_lookup_failed'), 'eBay bridge lookup must distinguish upstream failures from true SKU misses');
assert(joomAdapter.includes('x-platform-bridge-token') && joomAdapter.includes('PLATFORM_BRIDGE_INTERNAL_TOKEN'), 'Joom adapter must forward the internal bridge token');
assert(edgeJoomBridge.includes('requireInternalBridge(req)') && edgeJoomBridge.includes('internal_bridge_required'), 'Joom bridge credential-backed SKU lookup must require an internal bridge token');
assert(supabaseJoomBridge.includes('requireInternalBridge(req)') && supabaseJoomBridge.includes('internal_bridge_required'), 'deployed Supabase Joom bridge source must require an internal bridge token');
for (const source of [edgeJoomBridge, supabaseJoomBridge]) {
  for (const token of ['action === "publish" || action === "dryrun"', 'action === "update-price"', 'action === "delete"']) {
    const routeIndex = source.indexOf(token);
    assert(routeIndex >= 0, `Joom bridge must include ${token}`);
    assert(source.slice(routeIndex, routeIndex + 220).includes('requireInternalBridge(req)'), `Joom bridge ${token} route must require internal token`);
  }
  assert(source.includes('upstream_joom_lookup_failed'), 'Joom lookup must not classify every upstream failure as not found');
  assert(!source.includes('stack: e?.stack'), 'Joom bridge must not expose stack traces in JSON responses');
}
assert(!ebayBridge.includes('stack: e?.stack'), 'eBay bridge must not expose stack traces in JSON responses');

console.log('v2 platform coverage checks passed');
