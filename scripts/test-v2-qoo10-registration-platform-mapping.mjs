import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const bridgePath = join(root, 'supabase', 'functions', 'qoo10-bridge', 'index.ts');
const adapterPath = join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'qoo10.ts');
const dispatcherPath = join(root, 'supabase', 'functions', 'platform-publish', 'index.ts');

for (const path of [bridgePath, adapterPath, dispatcherPath]) {
  assert.equal(existsSync(path), true, `${path} must exist`);
}

const bridge = readFileSync(bridgePath, 'utf8');
const adapter = readFileSync(adapterPath, 'utf8');
const dispatcher = readFileSync(dispatcherPath, 'utf8');

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

const createListing = sliceBetween(
  bridge,
  'async function handleCreateListing',
  'async function handleRequest',
);
const hydrateRegistrationMappings = extractFunction(bridge, 'hydrateQoo10RegistrationMappings');
const fetchItemDetail = extractFunction(bridge, 'fetchQoo10ItemDetailForMapping');
const fetchOptionMappings = extractFunction(bridge, 'fetchQoo10OptionMappings');
const persistRegistrationMappings = extractFunction(bridge, 'persistQoo10RegistrationMappings');
const executeCreate = extractFunction(adapter, 'executeCreate');

assert.match(
  bridge,
  /10007-GetItemDetailInfo\.md/,
  'Qoo10 bridge must cite the local GetItemDetailInfo API doc used for post-registration status hydration',
);
assert.match(
  bridge,
  /10004-GetGoodsOptionInfo\.md/,
  'Qoo10 bridge must cite the local GetGoodsOptionInfo API doc used for post-registration option mapping',
);
assert.match(
  fetchItemDetail,
  /ItemCode[\s\S]*ItemsLookup\.GetItemDetailInfo|ItemsLookup\.GetItemDetailInfo[\s\S]*ItemCode/,
  'Qoo10 registration hydration must fetch item detail by the newly created ItemCode/GdNo',
);
assert.match(
  fetchOptionMappings,
  /ItemCode[\s\S]*ItemsLookup\.GetGoodsOptionInfo|ItemsLookup\.GetGoodsOptionInfo[\s\S]*ItemCode/,
  'Qoo10 registration hydration must fetch option rows through GetGoodsOptionInfo by ItemCode',
);
assert.match(
  fetchOptionMappings,
  /fetchInventoryByItemCode/,
  'Qoo10 option hydration must fall back to inventory lookup when option rows are temporarily unavailable',
);
assert.match(
  hydrateRegistrationMappings,
  /variant_id[\s\S]*variant_source[\s\S]*option_code/,
  'Qoo10 hydration must enrich requested options with variant_id, variant_source, and option_code',
);
assert.match(
  hydrateRegistrationMappings,
  /mapping_results/,
  'Qoo10 hydration must expose mapping_results diagnostics for successful registrations',
);
assert.match(
  persistRegistrationMappings,
  /absorb_platform_sku_lookup[\s\S]*p_platform:\s*"qoo10"[\s\S]*p_external_variant_id/,
  'Qoo10 bridge must persist successful registration mappings through the canonical platform_listings RPC',
);
assert.match(
  createListing,
  /hydrateQoo10RegistrationMappings[\s\S]*persistQoo10RegistrationMappings[\s\S]*mapping_results/,
  'Qoo10 create-listing must hydrate and persist mapping diagnostics before returning success',
);
assert.match(
  createListing,
  /listing_status[\s\S]*item_status/,
  'Qoo10 create-listing response must include hydrated listing_status and item_status',
);
assert.match(
  executeCreate,
  /mapQoo10ListingStatus\(result\.json\.listing_status \|\| result\.json\.item_status/,
  'Qoo10 adapter create result must preserve the hydrated Qoo10 listing status instead of forcing listed',
);
assert.match(
  executeCreate,
  /option_products:\s*buildQoo10OptionProducts\(options,\s*result\.json\)/,
  'Qoo10 adapter must build option_products from bridge-enriched mapping identifiers',
);
assert.match(
  adapter,
  /function buildQoo10OptionProducts[\s\S]*variant_id[\s\S]*variant_source[\s\S]*option_code/,
  'Qoo10 adapter option_products must include remote variant identity fields for platform_listings',
);
assert.match(
  dispatcher,
  /p_external_variant_id:\s*option\?\.variant_id \?\? option\?\.option_code \?\? option\?\.offer_id \?\? optionSku/,
  'platform-publish grouped create absorption must prefer Qoo10 option_code before falling back to SKU',
);

console.log('v2 Qoo10 registration platform mapping checks passed');
