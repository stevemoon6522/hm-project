import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const bridge = readFileSync(join(root, 'supabase', 'functions', 'shopee-bridge', 'index.ts'), 'utf8');
const plan = readFileSync(join(root, 'docs', 'superpowers', 'plans', '2026-06-30-shopee-registration-latency-review.md'), 'utf8');
const migrationPath = join(root, 'supabase', 'migrations', '202607010001_shopee_registration_read_cache.sql');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `missing function ${name}`);
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
  assert.ok(start >= 0, `missing start token: ${startToken}`);
  const end = source.indexOf(endToken, start);
  assert.ok(end > start, `missing end token after ${startToken}`);
  return source.slice(start, end);
}

assert.match(
  plan,
  /Verification order note:[\s\S]*Do not serialize production registration by region[\s\S]*bounded batch\/concurrency fast path/,
  'plan must state that staged verification does not serialize production registration',
);

assert.ok(existsSync(migrationPath), 'Shopee registration read-cache migration must exist');
const migration = readFileSync(migrationPath, 'utf8');
for (const token of [
  'create table if not exists public.shopee_registration_read_cache',
  'cache_key text primary key',
  'payload jsonb not null',
  'expires_at timestamptz not null',
  'idx_shopee_registration_read_cache_expires_at',
]) {
  assert.ok(migration.includes(token), `read-cache migration missing token: ${token}`);
}

for (const token of [
  'SHOPEE_ATTRIBUTE_TREE_CACHE_TTL_MS = 24 * 60 * 60 * 1000',
  'SHOPEE_LOGISTICS_CHANNEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000',
  'readShopeeRegistrationCache',
  'writeShopeeRegistrationCache',
  'cachedGlobalAttributeTree',
  'cachedLogisticsChannelList',
  'force_logistics_refresh',
]) {
  assert.ok(bridge.includes(token), `bridge missing cache token: ${token}`);
}

const registerBlock = sliceBetween(
  bridge,
  "if (action === 'register_cbsc' && req.method === 'POST')",
  "if (action === 'item_info')",
);
const publishToRegionBlock = sliceBetween(
  bridge,
  "if (action === 'publish_to_region' && req.method === 'POST')",
  "if (action === 'oauth_exchange')",
);
const buildPublishItemPayload = extractFunction(bridge, 'buildPublishItemPayload');
const getPublishLogistics = extractFunction(bridge, 'getPublishLogistics');
const buildCategoryAttributeListForRegions = extractFunction(bridge, 'buildCategoryAttributeListForRegions');

assert.match(
  registerBlock,
  /shop_id_list:\s*targetShopIds\.join\(','\)/,
  'register_cbsc must scope get_publishable_shop with target shop IDs',
);
assert.doesNotMatch(
  registerBlock.slice(
    0,
    registerBlock.indexOf('await mapWithConcurrency(targetInputs, 2'),
  ),
  /get_shop_publishable_status/,
  'register_cbsc fast path must not call get_shop_publishable_status before publishing',
);
assert.match(
  registerBlock,
  /loadShopPublishableStatusForDiagnostics/,
  'register_cbsc must keep shop_publishable_status available for failure diagnostics',
);
assert.match(
  `${registerBlock}\n${publishToRegionBlock}`,
  /isLogisticsChannelPublishFailure[\s\S]*force_logistics_refresh/,
  'publish flows must retry logistics/channel failures after forced logistics refresh',
);
assert.match(
  buildCategoryAttributeListForRegions,
  /forceAttributeRefresh/,
  'attribute tree builder must accept force refresh',
);
assert.match(
  getPublishLogistics,
  /cachedLogisticsChannelList[\s\S]*deliveryOnly/,
  'getPublishLogistics must cache raw channel list but still apply delivery-only filtering in code',
);

for (const token of [
  'function buildTwEnglishShortName',
  'READY STOCK',
  'PRE ORDER',
  'structuredVersionTermsForTwShortName',
  'TW English Short Name still exceeds 60 characters',
]) {
  assert.ok(bridge.includes(token), `bridge missing TW short-name token: ${token}`);
}
assert.match(
  buildPublishItemPayload,
  /targetRegion === 'TW'[\s\S]*buildTwEnglishShortName[\s\S]*item_name/,
  'buildPublishItemPayload must send TW English Short Name for TW item_name',
);
assert.doesNotMatch(
  buildPublishItemPayload,
  /item_name:\s*body\.name/,
  'buildPublishItemPayload must not blindly use body.name for every region item_name',
);

console.log('v2 Shopee registration latency optimization checks passed');
