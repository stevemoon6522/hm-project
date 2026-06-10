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
const joomPendingLedMigration = readFileSync(
  join(root, 'supabase', 'migrations', '202606080001_joom_pending_led_status.sql'),
  'utf8',
);
const platformPublish = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'index.ts'), 'utf8');
const joomAdapter = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'joom.ts'), 'utf8');
const ebayAdapter = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'ebay.ts'), 'utf8');
const qoo10Adapter = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'qoo10.ts'), 'utf8');
const qoo10Bridge = readFileSync(join(root, 'supabase', 'functions', 'qoo10-bridge', 'index.ts'), 'utf8');
const shopeeAdapter = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'shopee.ts'), 'utf8');
const ebayBridge = readFileSync(join(root, 'supabase', 'functions', 'ebay-bridge', 'index.ts'), 'utf8');
const edgeEbayBridge = readFileSync(join(root, 'edge-functions', 'ebay-bridge', 'index.ts'), 'utf8');
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

for (const viewId of [
  'view-products',
  'view-platform-shopee',
  'view-platform-joom',
  'view-platform-qoo10',
  'view-platform-ebay',
  'view-platform-alibaba',
  'view-fee-settings',
]) {
  assert(html.includes(`showView('${viewId}')`), `V2 nav must expose ${viewId}`);
}
assert(!html.includes('<button class="nav-tab" onclick="showView(\'view-coverage\')"'), 'V2 nav must not expose the legacy platform coverage tab');
assert(html.includes('id="view-coverage"'), 'V2 must include platform coverage view');
assert(html.includes('id="platform-shopee-root"') && html.includes('function renderPlatformWorkbench(platform)'), 'V2 must include separated platform workbench tabs');
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
assert(html.includes('async function coverageLookupViaPlatformPublish'), 'coverage UI must route non-Shopee SKU lookup through platform-publish');
assert(html.includes('async function coverageLookupQoo10BySku'), 'coverage UI must represent Qoo10 lookup state');
assert(html.includes('PLATFORM_PUBLISH') && html.includes("capability: 'sync'"), 'coverage UI must absorb found SKU lookups via platform-publish sync');
assert(html.includes("coverageLookupViaPlatformPublish('qoo10', sku, productId)"), 'Qoo10 SKU lookup must go through platform-publish sync');
assert(html.includes('coverageClearPlatformMapping(group.id, platform, hit)'), 'product list sync must clear stale mappings when remote lookup misses');
assert(html.includes('coverageClearShopeePublishedMappings'), 'Shopee stale published_list rows must be marked not_listed');
assert(!html.includes('if (localHit) return coverageNormalizeShopeePublishedHit'), 'Shopee sync must not trust cached local rows before remote verification');
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
assert(qoo10Adapter.includes("supports: new Set(['create_listing', 'sync'])") && qoo10Adapter.includes("bridgeFetch('/create-listing'"), 'Qoo10 adapter must support create_listing plus sync and call qoo10-bridge create-listing');
assert(qoo10Adapter.includes('shipping_no') && qoo10Adapter.includes('brand_no') && qoo10Adapter.includes('available_date_type') && qoo10Adapter.includes('header_html') && qoo10Adapter.includes('production_place') && qoo10Adapter.includes('force_options'), 'Qoo10 create payload must include shipping template, brand, release-date, origin, option, and header fields');
assert(html.includes("return normalizeMasterProductNameForLifecycle(row?.product_name, productLifecycleFilterKey(row), row?.sku || '').slice(0, 100);"), 'Qoo10 modal title must be normalized from each master product lifecycle');
assert(html.includes('const isPreOrder = mrQoo10IsPreOrder(rows);'), 'Qoo10 modal must not hard-code PRE ORDER shipping state');
assert(html.includes("const defaultAvailableType = mrQoo10IsPreOrder(rows) ? '2' : '0';"), 'Qoo10 payload fallback must derive AvailableDateType from master lifecycle');
assert(qoo10Adapter.includes('function lifecycleProductName') && qoo10Adapter.includes('lifecycleProductName(master.product_name, lifecycleOf(master, qoo10), master.sku)'), 'Qoo10 adapter fallback title must be lifecycle-normalized');
assert(qoo10Adapter.includes('resolveQoo10AvailableDate(lifecycle, releaseDate)'), 'Qoo10 adapter must derive listing shipping type from lifecycle fulfillment rules');
assert(qoo10Adapter.includes('function mapQoo10ListingStatus') && qoo10Adapter.includes("status === 'S4'") && qoo10Adapter.includes("return 'not_listed'"), 'Qoo10 sync must map deleted/discontinued statuses out of green LED state');
assert(qoo10Bridge.includes('"S2,S1,S3,S0,S4,S5,S8"'), 'Qoo10 SKU scan must include deleted/restricted/rejected statuses');
assert(joomAdapter.includes('function lifecycleProductName') && joomAdapter.includes('name: lifecycleProductName(master.product_name, lifecycleOf(master), sku)'), 'Joom adapter fallback scraped name must be lifecycle-normalized');
assert(ebayAdapter.includes('function lifecycleProductName') && ebayAdapter.includes('const lifecycleState = lifecycleOf(master)') && ebayAdapter.includes('title: lifecycleProductName(master.product_name, lifecycleState, sku).slice(0, 80)'), 'eBay adapter fallback title must be lifecycle-normalized');
assert(ebayAdapter.includes('lifecycleState,'), 'eBay adapter create payload must forward lifecycleState for fulfillment-policy selection');
assert(ebayAdapter.includes('const title = stripLifecycleTags(master.album || master.release_title || master.product_name || master.sku);'), 'eBay adapter release-title aspect must not carry stock-state tags');
assert(shopeeAdapter.includes('function shopeeLifecycleProductName') && shopeeAdapter.includes('const lifecycle_state: string = shopeeLifecycleOf(master, (ctx as any).lifecycle_state);'), 'Shopee multi-region adapter must derive lifecycle with a ready-stock-safe helper');
assert(shopeeAdapter.includes('|| shopeeLifecycleProductName(master.product_name, lifecycle_state, master.sku)') && shopeeAdapter.includes('is_pre_order,'), 'Shopee adapter fallback name and preorder flag must follow lifecycle');
assert(shopeeAdapter.includes('global_item_name: shopeeLifecycleProductName(masterProduct.product_name, lifecycle_state, masterProduct.sku) || undefined'), 'Shopee metadata update must not push stale stock-state title tags');
assert(platformPublish.includes('absorb_platform_sku_lookup') && platformPublish.includes('shouldAbsorbLookup'), 'platform-publish sync must absorb remote SKU hits through service-role RPC');
assert(platformPublish.includes('shouldClearRemoteMissingMapping') && platformPublish.includes('clearRemoteMissingMapping'), 'platform-publish sync must clear stale rows when remote listings are deleted');
assert(platformPublish.includes("mapping_status: 'unmatched'") && platformPublish.includes('deleted_at: now'), 'remote-missing rows must be removed from active LED rollups');
assert(platformPublish.includes('joom_product_id: null') && platformPublish.includes('joom_variant_id: null'), 'remote-missing Joom sync must clear legacy Joom IDs');
assert(platformPublish.includes('raw_response: adapterResult.rawResponse && dry_run'), 'platform-publish must not return live bridge raw responses to browser callers');
assert(joomAdapter.includes("if (raw?.hasActiveVersion === false) return 'pending';"), 'Joom adapter must not treat non-active lookup hits as listed');
assert(joomAdapter.includes("state === 'archived' || state === 'not_listed'"), 'Joom adapter must treat archived lookup hits as missing');
assert(joomPendingLedMigration.includes("lower(coalesce(p.joom_mapping_status, '')) in ('pending', 'draft')"), 'Joom legacy rollup must count pending legacy mappings as pending');
assert(joomPendingLedMigration.includes("lower(coalesce(p.joom_status, '')) = 'archived'"), 'Joom legacy rollup must keep archived products out of listed count');
assert(ebayBridge.includes('requireAuthenticatedUser(req)') && ebayBridge.includes('EBAY_OAUTH_ENDPOINT') && ebayBridge.includes('identity/v1/oauth2/token'), 'eBay bridge must require authenticated users and use a valid OAuth endpoint');
assert(ebayBridge.includes('function requireInternalBridge') && ebayBridge.includes('internal_bridge_required'), 'eBay bridge should retain internal bridge guard helper for server-only routes');
for (const [label, source] of [['Supabase', ebayBridge], ['edge mirror', edgeEbayBridge]]) {
  assert(source.includes('V2 eBay registration UI calls ebay-bridge directly') && source.includes('server-only platform bridge token'), `${label} eBay publish/lookup routes must allow authenticated browser UI calls without exposing the internal bridge token`);
  for (const routeToken of ['action === "lookup-item" && req.method === "GET"', 'action === "publish" && req.method === "POST"']) {
    const routeIndex = source.indexOf(routeToken);
    assert(routeIndex >= 0, `${label} eBay bridge must include ${routeToken}`);
    assert(!source.slice(routeIndex, routeIndex + 520).includes('requireInternalBridge(req)'), `${label} eBay browser ${routeToken} route must not require the internal bridge token`);
  }
}
assert(ebayAdapter.includes('x-platform-bridge-token') && ebayAdapter.includes('PLATFORM_BRIDGE_INTERNAL_TOKEN'), 'eBay adapter must forward the internal bridge token when routed through platform-publish');
assert(ebayAdapter.includes('lookupMiss') && ebayAdapter.includes('PLATFORM_NOT_FOUND'), 'eBay adapter must classify ordinary lookup misses as PLATFORM_NOT_FOUND');
assert(ebayAdapter.includes("title.slice(0, 50)"), 'eBay adapter aspect values must be clamped to bridge validation limits');
assert(ebayBridge.includes('upstream_inventory_lookup_failed') && ebayBridge.includes('upstream_offer_lookup_failed'), 'eBay bridge lookup must distinguish upstream failures from true SKU misses');
assert(joomAdapter.includes('x-platform-bridge-token') && joomAdapter.includes('PLATFORM_BRIDGE_INTERNAL_TOKEN'), 'Joom adapter must forward the internal bridge token');
for (const [label, source] of [['edge mirror', edgeJoomBridge], ['Supabase', supabaseJoomBridge]]) {
  assert(source.includes('function requireInternalBridge') && source.includes('internal_bridge_required'), `${label} Joom bridge should retain internal bridge guard helper for server-routed calls`);
  assert(source.includes('requireAuthenticatedUser(req)') && source.includes('requireBridgeTokenOrAuthenticatedUser'), `${label} Joom bridge must allow signed-in browser UI calls without exposing the internal bridge token`);
  for (const token of ['action === "publish" || action === "dryrun"', 'action === "lookup-sku"', 'action === "update-price"', 'action === "delete"']) {
    const routeIndex = source.indexOf(token);
    assert(routeIndex >= 0, `${label} Joom bridge must include ${token}`);
    assert(source.slice(routeIndex, routeIndex + 260).includes('requireBridgeTokenOrAuthenticatedUser(req)'), `${label} Joom bridge ${token} route must use browser-session-or-internal-token auth`);
    assert(!source.slice(routeIndex, routeIndex + 260).includes('requireInternalBridge(req)'), `${label} Joom browser ${token} route must not require only the internal bridge token`);
  }
  assert(source.includes('upstream_joom_lookup_failed'), 'Joom lookup must not classify every upstream failure as not found');
  assert(!source.includes('stack: e?.stack'), 'Joom bridge must not expose stack traces in JSON responses');
}
assert(!ebayBridge.includes('stack: e?.stack'), 'eBay bridge must not expose stack traces in JSON responses');

console.log('v2 platform coverage checks passed');
