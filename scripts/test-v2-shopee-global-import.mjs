#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL ${msg}`);
    process.exit(1);
  }
  console.log(`OK ${msg}`);
};

const html = read('v2/index.html');
const migration = read('supabase/migrations/202605290002_shopee_global_import_master.sql');
const bridgeA = read('supabase/functions/shopee-bridge/index.ts');
const bridgeB = read('edge-functions/shopee-bridge/index.ts');

assert(html.includes('id="sg-import-panel"'), 'V2 register view has Shopee Global import panel');
assert(html.includes('id="sg-keyword"') && html.includes('id="sg-search-btn"') && html.includes('id="sg-refresh-btn"') && html.includes('id="sg-import-btn"'), 'V2 has keyword/search/import/refresh controls');
assert(html.includes('function sgOptionImageUrl') && html.includes('tier_index') && html.includes('option_list'), 'V2 derives option images from Shopee tier/model data');
assert(html.includes("models.map((m) => text(sgModelSku(m) || '<empty>'))"), 'V2 escapes Shopee model SKUs before rendering search results');
assert(html.includes('function canonicalShopeeSkuForImport') && html.includes('global_model_sku') && html.includes('model_sku'), 'V2 preserves Global/model SKU as canonical SKU');
assert(html.includes('class="sg-select-all"') && html.includes('sgSyncSelectAllState') && html.includes("document.querySelectorAll('.sg-select')"), 'V2 search results have a header select-all checkbox for Global Products');
assert(html.includes('function sgModelDisplayName') && html.includes("optionNames.length ? optionNames : [sgModelDisplayName(model)]"), 'V2 falls back to model names so option imports render as grouped master rows');
assert(html.includes('shopee_global_raw_payload') && html.includes('shopee_global_model_raw_payload') && html.includes('raw_payload'), 'V2 writes raw item/model/listing payloads');
assert(html.includes('product_shopee_listings') && html.includes('global_item_id') && html.includes('global_model_id'), 'V2 maps master products to Shopee listing/global IDs');
assert(html.includes("els.sgSearchBtn?.addEventListener('click'") && html.includes("els.sgKeyword?.addEventListener('keydown'") && html.includes("els.sgImportBtn?.addEventListener('click'"), 'V2 Shopee Global event handlers are wired');
assert(html.includes('sgMakeMockRows') && html.includes("searchShopeeGlobalProducts({ useMock: true })"), 'V2 supports dry-run/mock import path');
assert(!html.includes('const maxPages = keyword ? 8 : 1'), 'V2 Shopee Global search no longer stops after the first 400 checked products');
assert(!html.includes('rows.length < targetRows'), 'V2 Shopee Global search no longer stops after an arbitrary result target');
assert(html.includes('function sgSearchCacheKey') && html.includes('async function sgReadSearchCache') && html.includes('async function sgWriteSearchCache'), 'V2 caches completed Shopee Global searches for fast reload');
assert(html.includes('sgSearchMemoryCache') && html.includes('sgReadSearchCacheSync'), 'V2 keeps an in-memory Global Product cache for instant repeat searches in the same session');
assert(html.includes('forceRefresh') && html.includes('sgCompareSearchRows'), 'V2 Global Product refresh must bypass cache and compare fresh Shopee data against cached rows');
assert(html.includes("els.sgRefreshBtn?.addEventListener('click'") && html.includes('searchShopeeGlobalProducts({ forceRefresh: true })'), 'V2 Global Product refresh button must be wired to force a live Shopee reload');
assert(html.includes('staleWhileRevalidate') && html.includes('sgRefreshShopeeGlobalInBackground'), 'V2 cached Global Product results must render immediately and refresh in the background');
assert(html.includes('seenOffsets') && html.includes('while (true)'), 'V2 Shopee Global search paginates until Shopee returns no next offset');

for (const col of ['shopee_global_raw_payload', 'shopee_global_model_raw_payload', 'shopee_option_image_url', 'shopee_global_item_sku', 'shopee_global_model_sku', 'joom_category_id']) {
  assert(migration.includes(`add column if not exists ${col}`), `migration adds products.${col}`);
}
assert(migration.includes('alter table public.product_shopee_listings') && migration.includes('add column if not exists raw_payload jsonb'), 'migration adds product_shopee_listings.raw_payload');

for (const [name, src] of [['supabase', bridgeA], ['edge-functions', bridgeB]]) {
  assert(src.includes("url.searchParams.get('keyword')") && src.includes('query.keyword = keyword') && src.includes('query.item_name = keyword'), `${name} shopee-bridge forwards keyword/item_name`);
  assert(src.includes("'/api/v2/global_product/get_global_item_list'") && src.includes('keyword: keyword || null'), `${name} shopee-bridge global_items response includes keyword`);
}

console.log('Shopee Global import static coverage OK');
