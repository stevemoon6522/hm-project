import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const bridge = readFileSync(join(root, 'supabase', 'functions', 'shopee-bridge', 'index.ts'), 'utf8');
const mirror = readFileSync(join(root, 'edge-functions', 'shopee-bridge', 'index.ts'), 'utf8');

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function extractFunction(source, name) {
  const asyncStart = source.indexOf(`async function ${name}`);
  const regularStart = source.indexOf(`function ${name}`);
  const start = asyncStart >= 0 ? asyncStart : regularStart;
  assert(start >= 0, `missing function ${name}`);
  const paramsEnd = source.indexOf(')', start);
  const signatureEnd = source.indexOf('\n', paramsEnd);
  const open = source.lastIndexOf('{', signatureEnd);
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

assert.equal(hash(bridge), hash(mirror), 'Shopee bridge mirror must match deploy source');

for (const token of [
  'function isMissingAccountKeyColumn',
  'async function getShopeeTokenRow',
  'async function getShopeeTokenRows',
  'async function updateShopeeTokenRow',
  'async function getShopeeShopRowByShopId',
  'async function updateShopeeShopTokenByShopId',
]) {
  assert(bridge.includes(token), `missing legacy account-key fallback helper: ${token}`);
}

const tokenRow = extractFunction(bridge, 'getShopeeTokenRow');
assert.match(tokenRow, /\.eq\('account_key', accountKey\)[\s\S]*isMissingAccountKeyColumn[\s\S]*\.eq\('region', region\)/, 'token row lookup must fall back to legacy region-only schema');

const tokenRows = extractFunction(bridge, 'getShopeeTokenRows');
assert.match(tokenRows, /scopedColumns[\s\S]*legacyColumns[\s\S]*isMissingAccountKeyColumn[\s\S]*account_key: accountKey/, 'token list lookup must inject default account_key for legacy rows');

const tokenUpdate = extractFunction(bridge, 'updateShopeeTokenRow');
assert.match(tokenUpdate, /\.eq\('account_key', accountKey\)[\s\S]*isMissingAccountKeyColumn[\s\S]*\.eq\('region', region\)/, 'token update must fall back to legacy region-only schema');

const shopLookup = extractFunction(bridge, 'getShopeeShopRowByShopId');
assert.match(shopLookup, /\.eq\('account_key', accountKey\)[\s\S]*isMissingAccountKeyColumn[\s\S]*\.eq\('shop_id', String\(shopId\)\)/, 'shop row lookup must fall back to legacy shop_id-only schema');

for (const fnName of [
  'refreshMerchantToken',
  'forceRefreshShopToken',
  'issueMerchantToken',
  'getValidToken',
  'refreshMerchantRowTokenStrict',
  'getValidMerchantToken',
  'getRegionShopId',
]) {
  const body = extractFunction(bridge, fnName);
  assert(body.includes('getShopeeTokenRow('), `${fnName} must use schema-compatible token lookup`);
  assert(!body.includes(".from('shopee_tokens')"), `${fnName} must not read shopee_tokens directly`);
}

const getRegionShopRow = extractFunction(bridge, 'getRegionShopRow');
assert(getRegionShopRow.includes('getShopeeShopRowByShopId'), 'shop principal validation must use schema-compatible shop lookup');

const persistShopToken = extractFunction(bridge, 'persistShopToken');
assert(persistShopToken.includes('updateShopeeTokenRow'), 'shop token persistence must use schema-compatible token update');
assert(persistShopToken.includes('updateShopeeShopTokenByShopId'), 'shop token persistence must use schema-compatible shop update');

assert(bridge.includes('const data = await getShopeeTokenRows(accountKey);'), 'tokens debug action must list tokens through fallback helper');
assert(bridge.includes('const data = await getShopeeTokenRows(accountKey, { regions: targetRegions, includeAccessToken: true });'), 'token_health must list tokens through fallback helper');
assert(bridge.includes("const merchantRow = await getShopeeTokenRow('_MERCHANT', accountKey);"), 'token_health merchant probe must use fallback helper');

console.log('Shopee bridge legacy token fallback checks passed');
