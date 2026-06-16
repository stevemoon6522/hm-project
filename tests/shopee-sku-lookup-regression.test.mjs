import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const bridgeCopies = [
  ['supabase', readFileSync(join(process.cwd(), 'supabase/functions/shopee-bridge/index.ts'), 'utf8')],
  ['edge-functions', readFileSync(join(process.cwd(), 'edge-functions/shopee-bridge/index.ts'), 'utf8')],
];

test('Shopee bridge exposes a SKU lookup route backed by official item_sku/model_sku APIs', () => {
  for (const [label, source] of bridgeCopies) {
    assert.match(source, /"lookup-sku"/, `${label} bridge should expose lookup-sku as a read route`);
    assert.match(source, /action === 'lookup-sku'/, `${label} bridge should handle lookup-sku requests`);
    assert.match(source, /\/api\/v2\/product\/search_item/, `${label} bridge should use product.search_item`);
    assert.match(source, /item_sku: needle/, `${label} bridge should search by the requested item_sku`);
    assert.match(source, /\/api\/v2\/product\/get_model_list/, `${label} bridge should verify model_sku via get_model_list`);
    assert.match(source, /shopeeSkuEquals\(model\?\.model_sku, sku\)/, `${label} bridge should require an exact model_sku match`);
    assert.match(source, /const SHOPEE_SKU_LOOKUP_STATUSES = \['NORMAL', 'UNLIST'\]/, `${label} bridge should only map active or unlisted shop items`);
    assert.match(source, /listItemsForRegion\(r, status, maxScanItems, accountKey\)/, `${label} bridge should scan shop listings as a model_sku fallback`);
    assert.match(source, /source_docs:[\s\S]*v2\.product\.search_item\.json:item_sku[\s\S]*v2\.product\.get_model_list\.json:model_sku/, `${label} bridge response should cite the local Shopee API docs used`);
  }
});
