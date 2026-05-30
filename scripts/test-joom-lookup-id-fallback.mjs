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
assert.match(joomAdapter, /fallbackStoredJoomMapping/, 'Joom platform adapter must fall back to stored Joom IDs when bridge lookup misses but product.joom_product_id is known');
assert.match(joomAdapter, /joom_lookup_fallback: 'stored_joom_product_id'/, 'Joom stored-ID fallback must be auditable in absorbed raw payload');
assert.match(joomAdapter, /platformItemId: storedProductId/, 'Joom stored-ID fallback must still populate platform_item_id for platform_listings');
assert.match(joomAdapter, /joom_variant_id: storedVariantId/, 'Joom stored-ID fallback must preserve the stored variant id/SKU for platform_listings.external_variant_id');

console.log('Joom lookup id fallback checks passed');
