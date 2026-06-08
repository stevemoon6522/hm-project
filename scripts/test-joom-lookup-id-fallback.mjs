import assert from 'node:assert/strict';
import fs from 'node:fs';

const joomBridge = fs.readFileSync(new URL('../supabase/functions/joom-bridge/index.ts', import.meta.url), 'utf8');
const edgeJoomBridge = fs.readFileSync(new URL('../edge-functions/joom-bridge/index.ts', import.meta.url), 'utf8');
const platformPublish = fs.readFileSync(new URL('../supabase/functions/platform-publish/index.ts', import.meta.url), 'utf8');
const joomAdapter = fs.readFileSync(new URL('../supabase/functions/platform-publish/adapters/joom.ts', import.meta.url), 'utf8');

for (const [label, source] of [['supabase', joomBridge], ['edge mirror', edgeJoomBridge]]) {
  assert.match(source, /url\.searchParams\.get\("id"\)/, `${label} Joom lookup-sku must accept stored joom_product_id as id fallback`);
  assert.match(source, /lookupJoomProductBySkuOrId/, `${label} Joom lookup must retry by stored product id when parent SKU lookup misses`);
  assert.match(source, /\/products\?id=\$\{encodeURIComponent\(id\)\}/, `${label} Joom lookup must call /products?id=... fallback`);
  assert.match(source, /lookup_by_id: !!id/, `${label} Joom lookup errors should expose whether id fallback was used`);
}

assert.match(platformPublish, /joom_product_id, joom_variant_id, joom_currency/, 'platform-publish must select stored Joom mapping fields for sync fallback');
assert.match(joomAdapter, /id: s\(ctx\.masterProduct\.joom_product_id\)/, 'Joom platform adapter must send stored joom_product_id to lookup-sku');
assert.doesNotMatch(joomAdapter, /trustedStoredMapping = fallbackStoredJoomMapping/, 'Joom adapter must not trust stored IDs before bridge lookup');
assert.doesNotMatch(joomAdapter, /joom_lookup_fallback: 'stored_joom_product_id'/, 'stale stored Joom IDs must not be absorbed as listed without remote verification');
assert.match(joomAdapter, /raw\?\.hasActiveVersion === false\) return 'pending'/, 'Joom adapter must not classify non-active products as listed');
assert.match(joomAdapter, /state === 'archived' \|\| state === 'not_listed'/, 'Joom adapter must treat archived products as not listed');

for (const [label, source] of [['supabase', joomBridge], ['edge mirror', edgeJoomBridge]]) {
  assert.match(source, /hasActiveVersion: product\?\.hasActiveVersion \?\? null/, `${label} Joom lookup must expose hasActiveVersion`);
  assert.match(source, /listing_status: joomProductListingStatus\(product\)/, `${label} Joom lookup must expose listing_status derived from remote state`);
}

console.log('Joom lookup id fallback checks passed');
