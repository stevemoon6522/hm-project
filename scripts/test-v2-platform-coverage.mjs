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

for (const platform of ['shopee', 'joom', 'qoo10', 'alibaba', 'ebay']) {
  assert(html.includes(`value="${platform}"`) || html.includes(`'${platform}'`), `coverage UI must include ${platform}`);
}

console.log('v2 platform coverage checks passed');
