import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const supabaseBridgePath = join(root, 'supabase', 'functions', 'ebay-bridge', 'index.ts');
const edgeBridgePath = join(root, 'edge-functions', 'ebay-bridge', 'index.ts');
const migrationPath = join(root, 'supabase', 'migrations', '202606250001_ebay_platform_listings_backfill.sql');
const htmlPath = join(root, 'v2', 'index.html');
const groupingPath = join(root, 'supabase', 'functions', 'platform-publish', '_shared', 'grouping.ts');
const ebayAdapterPath = join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'ebay.ts');

for (const path of [supabaseBridgePath, edgeBridgePath, migrationPath, htmlPath, groupingPath, ebayAdapterPath]) {
  assert.equal(existsSync(path), true, `${path} must exist`);
}

const bridge = readFileSync(supabaseBridgePath, 'utf8');
const edge = readFileSync(edgeBridgePath, 'utf8');
const migration = readFileSync(migrationPath, 'utf8');
const html = readFileSync(htmlPath, 'utf8');
const grouping = readFileSync(groupingPath, 'utf8');
const ebayAdapter = readFileSync(ebayAdapterPath, 'utf8');
const hash = (s) => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex');

assert.equal(hash(bridge), hash(edge), 'supabase and edge-functions ebay-bridge copies must match');

for (const token of [
  'async function persistEbayPlatformListingMapping',
  'async function persistEbayPublishPlatformMappings',
  'publish_origin: "v2_created"',
  'mapping_status: "mapped"',
  'listing_status: "listed"',
  'platform_item_id: ebayItemId',
  'external_sku: sku',
  'external_variant_id: externalVariantId',
  'await persistEbayPublishPlatformMappings(listingMode, body, raw)',
  'await persistEbayPublishPlatformMappings("single", payload, publishJson)',
]) {
  assert(bridge.includes(token), `ebay-bridge missing platform mapping token: ${token}`);
}

for (const token of [
  'products.ebay_item_id',
  "'ebay'::text as platform",
  "upper(coalesce(p.ebay_status, '')) in ('PUBLISHED', 'MAPPED', 'LISTED')",
  "coalesce(nullif(p.ebay_marketplace_id, ''), 'EBAY_US')",
  "'v2_created'::text as publish_origin",
  'platform_listing_rollups',
  'platform_listing_coverage',
]) {
  assert(migration.includes(token), `eBay backfill migration missing token: ${token}`);
}

for (const token of [
  'ebay_sku,ebay_offer_id,ebay_item_id,ebay_status,ebay_last_synced_price,ebay_marketplace_id,ebay_last_synced_at,ebay_published_at',
  "pushRow(product.id, 'ebay'",
  "platform_item_id: product.ebay_item_id",
  "external_variant_id: product.ebay_offer_id || product.ebay_sku",
  "listing_status: 'listed'",
  "mapping_status: 'mapped'",
]) {
  assert(html.includes(token), `V2 coverage fallback missing eBay legacy token: ${token}`);
}

assert(ebayAdapter.includes('deriveKpopFromTitle'), 'eBay platform-publish adapter must use shared K-pop title parser');
assert(grouping.includes('export function deriveKpopFromTitle'), 'shared grouping helpers must export deriveKpopFromTitle');
assert(grouping.includes('parenthesized dash-prefix artists'), 'shared parser must document the ILLIT parenthesized artist case');

console.log('v2 eBay platform listing mapping checks passed');
