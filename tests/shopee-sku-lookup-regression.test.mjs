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
    assert.match(source, /item_name: term/, `${label} bridge should search by master product name when item_sku search misses`);
    assert.ok(source.includes("raw.replace(/[\\[\\]]/g, ' ')"), `${label} bridge should preserve non-status bracket text such as album titles in item_name searches`);
    assert.match(source, /bracketContents\.map/, `${label} bridge should try album-title plus option-name search terms`);
    assert.match(source, /\/api\/v2\/product\/get_model_list/, `${label} bridge should verify model_sku via get_model_list`);
    assert.match(source, /shopeeSkuEquals\(model\?\.model_sku, sku\)/, `${label} bridge should require an exact model_sku match`);
    assert.match(source, /const SHOPEE_SKU_LOOKUP_STATUSES = \['NORMAL', 'UNLIST'\]/, `${label} bridge should only map active or unlisted shop items`);
    assert.match(source, /listItemsForRegion\(r, status, maxScanItems, accountKey\)/, `${label} bridge should scan shop listings as a model_sku fallback`);
    assert.match(source, /lookupShopeeSkuAcrossRegions\(remoteRegions, sku, max_items, accountKey, \{ scanFallback: allowRemoteScan, itemNameTerms: remoteSearchTerms \}\)/, `${label} GET lookup-sku should search remote Shopee rows after DB misses`);
    assert.match(source, /url\.searchParams\.getAll\('item_name'\)/, `${label} GET lookup-sku should accept frontend-provided product-name search terms`);
    assert.match(source, /lookupSource\.startsWith\('scan_'\) \? 'remote_list_items' : \(lookupSource \|\| \(allowRemoteScan \? 'remote_list_items' : 'remote_search_item'\)\)/, `${label} GET lookup-sku should distinguish fast search from explicit full scan`);
    assert.match(source, /not_found: region_hits\.length === 0 && region_results\.every/, `${label} GET lookup-sku should return a conclusive not_found state`);
    assert.match(source, /source_docs:[\s\S]*v2\.product\.search_item\.json:item_sku[\s\S]*v2\.product\.search_item\.json:item_name[\s\S]*v2\.product\.get_model_list\.json:model_sku/, `${label} bridge response should cite the local Shopee API docs used`);
  }
});
