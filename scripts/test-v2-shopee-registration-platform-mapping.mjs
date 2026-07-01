import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const bridgePath = join(root, 'supabase', 'functions', 'shopee-bridge', 'index.ts');
const adapterPath = join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'shopee.ts');

for (const path of [bridgePath, adapterPath]) {
  assert.equal(existsSync(path), true, `${path} must exist`);
}

const bridge = readFileSync(bridgePath, 'utf8');
const adapter = readFileSync(adapterPath, 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert(start >= 0, `missing function ${name}`);
  const paramsEnd = source.indexOf(')', start);
  const open = source.indexOf('{', paramsEnd);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function sliceBetween(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  assert(start >= 0, `missing start token: ${startToken}`);
  const end = source.indexOf(endToken, start);
  assert(end > start, `missing end token after ${startToken}`);
  return source.slice(start, end);
}

const persistHelper = extractFunction(bridge, 'persistShopeeRegistrationMappings');
const recordRegistrationMapping = extractFunction(bridge, 'recordRegistrationMapping');
const finalizePublishOutcomeAfterSuccess = extractFunction(bridge, 'finalizePublishOutcomeAfterSuccess');
const fetchShopeeModelMappingRowsForPublishedItem = extractFunction(bridge, 'fetchShopeeModelMappingRowsForPublishedItem');
const reconcilePublishResultsWithPublishedList = extractFunction(bridge, 'reconcilePublishResultsWithPublishedList');
const buildShopeePublishMappingRows = extractFunction(bridge, 'buildShopeePublishMappingRows');
const addItemBlock = sliceBetween(
  bridge,
  "if (action === 'add_item' && req.method === 'POST')",
  "if (action === 'unlist_item' && req.method === 'POST')",
);
const initShopTierVariationBlock = sliceBetween(
  bridge,
  "if (action === 'init_shop_tier_variation')",
  "if (action === 'update_shop_tier_variation')",
);
const publishToRegionBlock = sliceBetween(
  bridge,
  "if (action === 'publish_to_region' && req.method === 'POST')",
  "if (action === 'oauth_exchange')",
);
const registerCbscBlock = sliceBetween(
  bridge,
  "if (action === 'register_cbsc' && req.method === 'POST')",
  "if (action === 'item_info')",
);
const handleCreateListingMultiRegion = extractFunction(adapter, 'handleCreateListingMultiRegion');

assert.match(
  bridge,
  /type ShopeeRegistrationMappingInput/,
  'Shopee bridge must define a typed canonical mapping input',
);
assert.match(
  persistHelper,
  /product_shopee_listings[\s\S]*upsert[\s\S]*product_id,account_key,region/,
  'Shopee bridge mapping helper must upsert product_shopee_listings by product/account/region',
);
assert.match(
  persistHelper,
  /global_item_id[\s\S]*global_model_id[\s\S]*shop_item_id[\s\S]*shop_model_id/,
  'Shopee bridge mapping helper must persist global/shop item and model identifiers',
);
assert.match(
  persistHelper,
  /status[\s\S]*last_error[\s\S]*raw_payload/,
  'Shopee bridge mapping helper must persist status, last_error, and raw payload evidence',
);
assert.match(
  persistHelper,
  /resolveProductIdForMapping/,
  'Shopee bridge mapping helper must resolve SKU-only mapping rows before upsert',
);
assert.match(
  recordRegistrationMapping,
  /persistShopeeRegistrationMappings/,
  'record_registration_mapping must delegate listing persistence to the canonical Shopee mapping helper',
);
assert.match(
  finalizePublishOutcomeAfterSuccess,
  /model_mappings/,
  'successful publish finalization must attach enriched model mappings to the publish result',
);
assert.doesNotMatch(
  finalizePublishOutcomeAfterSuccess,
  /outcome\.ok\s*=\s*false/,
  'post-publish price sync failures must not overwrite an already published item result as a region failure',
);
assert.match(
  finalizePublishOutcomeAfterSuccess,
  /price_sync_stage:\s*'post_publish_price_sync'|outcome\.price_sync_stage\s*=\s*'post_publish_price_sync'/,
  'post-publish price sync failures must be reported as a separate warning stage',
);
assert.match(
  finalizePublishOutcomeAfterSuccess,
  /needs_price_review/,
  'post-publish price sync failures must flag the mapped listing for price review',
);
assert.match(
  buildShopeePublishMappingRows,
  /const status = shopItemId \? 'mapped' : 'failed'/,
  'Shopee mapping rows must stay mapped when Shopee returned an item_id even if a post-publish warning is present',
);
assert.match(
  fetchShopeeModelMappingRowsForPublishedItem,
  /get_model_list[\s\S]*shop_model_id/,
  'model mapping enrichment must read shop model IDs from product/get_model_list',
);
assert.match(
  fetchShopeeModelMappingRowsForPublishedItem,
  /get_global_model_list[\s\S]*global_model_id/,
  'successful publish finalization must try to enrich option mappings with model identifiers',
);
assert.match(
  `${publishToRegionBlock}\n${registerCbscBlock}`,
  /persistShopeeRegistrationMappings/,
  'register_cbsc and publish_to_region must persist mapping rows before returning success to callers',
);
assert.match(
  addItemBlock,
  /shop_item_id:\s*Number\(result\.response\?\.item_id\)[\s\S]*persistShopeeRegistrationMappings/,
  'shop-level add_item success must auto-map the returned item_id without manual SKU mapping',
);
assert.match(
  initShopTierVariationBlock,
  /get_model_list[\s\S]*shop_model_id[\s\S]*persistShopeeRegistrationMappings/,
  'shop-level init_tier_variation repair success must auto-map returned shop model IDs',
);
assert.match(
  reconcilePublishResultsWithPublishedList,
  /global_item_id:[\s\S]*globalItemId/,
  'final published_list reconciliation must retain global_item_id for downstream mapping',
);
assert.match(
  `${publishToRegionBlock}\n${registerCbscBlock}`,
  /mapping_results|mappingResults/,
  'Shopee registration responses must expose mapping_results for platform-publish/UI diagnosis',
);
assert.match(
  handleCreateListingMultiRegion,
  /mapping_results|mappingResults/,
  'platform-publish Shopee adapter must preserve bridge mapping diagnostics',
);
assert.match(
  adapter,
  /PLATFORM_BRIDGE_INTERNAL_TOKEN[\s\S]*x-platform-bridge-token/,
  'platform-publish Shopee adapter must forward the internal bridge token for server-side bridge calls',
);

console.log('v2 Shopee registration platform mapping checks passed');
