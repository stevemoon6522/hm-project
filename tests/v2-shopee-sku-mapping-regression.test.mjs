import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(process.cwd(), 'v2', 'index.html'), 'utf8');

function extractFunctionBlock(source, functionName) {
  let start = source.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `${functionName} must exist`);
  const asyncStart = start - 'async '.length;
  if (asyncStart >= 0 && source.slice(asyncStart, start) === 'async ') start = asyncStart;
  const open = source.indexOf('{', start);
  assert.ok(open > start, `${functionName} must have a body`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${functionName} body must close`);
}

test('Shopee SKU mapping normalization keeps shop ids when Global hits are also present', () => {
  const normalizeFactory = new Function(
    `${extractFunctionBlock(html, 'coverageNormalizeShopeeSkuLookupHit')}; return coverageNormalizeShopeeSkuLookupHit;`,
  );
  const normalize = normalizeFactory();

  const hit = normalize({
    ok: true,
    region_hits: [{
      region: 'SG',
      shop_id: 123,
      shop_item_id: 987654321,
      shop_model_id: 444555666,
      item_status: 'NORMAL',
      lookup_source: 'search_item_name',
    }],
    global_region_hits: [{
      region: 'SG',
      global_item_id: 54504712282,
      global_model_id: 400436990942,
      global_model_sku: 'O1-ATE-4GOLD-PHO-A',
      item_status: 'NORMAL',
      lookup_source: 'global_item_id',
    }],
  }, 'O1-ATE-4GOLD-PHO-A');

  assert.equal(hit.found, true);
  assert.equal(hit.regionHits.length, 1);
  assert.equal(hit.regionHits[0].shop_item_id, 987654321);
  assert.equal(hit.regionHits[0].shop_model_id, 444555666);
  assert.equal(hit.regionHits[0].global_item_id, 54504712282);
  assert.equal(hit.regionHits[0].global_model_id, 400436990942);
});

test('Shopee price sync lookup parser merges Global ids into shop hits', () => {
  const parserFactory = new Function(
    `${extractFunctionBlock(html, 'catShopeePublishedStatusRank')}
     ${extractFunctionBlock(html, 'catShopeeListingIsPriceSyncable')}
     ${extractFunctionBlock(html, 'catShopeeSkuLookupHitsFromResponse')}
     return catShopeeSkuLookupHitsFromResponse;`,
  );
  const parseHits = parserFactory();

  const hits = parseHits({
    ok: true,
    region_hits: [{
      region: 'SG',
      shop_id: 123,
      shop_item_id: 111222333,
      shop_model_id: 444555666,
      item_status: 'NORMAL',
      lookup_source: 'search_item_name',
    }],
    global_region_hits: [{
      region: 'SG',
      global_item_id: 54504712282,
      global_model_id: 400436990945,
      global_model_sku: 'O1-ATE-4GOLD-PHO-SET',
      item_status: 'NORMAL',
      lookup_source: 'global_item_id',
    }],
  });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].shop_item_id, 111222333);
  assert.equal(hits[0].shop_model_id, 444555666);
  assert.equal(hits[0].global_item_id, 54504712282);
  assert.equal(hits[0].global_model_id, 400436990945);
});

test('Shopee price sync lookup sends sibling Global Product context', async () => {
  const lookupFactory = new Function(
    'fetch',
    'SHOPEE_BRIDGE',
    'AUTH_HEADERS',
    'catShopeeLookupNameTerms',
    'catShopeeSkuLookupHitsFromResponse',
    'shopeeLookupContextForProduct',
    `const SHOPEE_DEFAULT_ACCOUNT_KEY = 'starphotocard';
     ${extractFunctionBlock(html, 'catFetchShopeeSkuLookupHits')}
     return catFetchShopeeSkuLookupHits;`,
  );

  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () => ({ ok: true, region_hits: [] }),
    };
  };
  const lookup = lookupFactory(
    fetch,
    'https://example.test/shopee-bridge',
    { Authorization: 'Bearer test', apikey: 'test' },
    () => ['BOYNEXTDOOR HOME SWEET HOME RANDOM'],
    () => [],
    () => ({
      globalItemIds: [54504712282],
      itemNameTerms: ['BOYNEXTDOOR HOME SWEET HOME'],
      siblingProductIds: ['random', 'set'],
    }),
  );

  await lookup('O1-BOYNEXTD-HOME-SWEETHOME-RANDOM', ['SG', 'TW'], {
    id: 'random',
    product_group_id: 'home-sweet',
    product_name: '[READY STOCK] BOYNEXTDOOR 1st Studio Album [HOME] (SWEET HOME ver.)',
    option_name: 'RANDOM',
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('sku'), 'O1-BOYNEXTD-HOME-SWEETHOME-RANDOM');
  assert.equal(url.searchParams.get('regions'), 'SG,TW');
  assert.deepEqual(url.searchParams.getAll('global_item_id'), ['54504712282']);
  assert.ok(url.searchParams.getAll('item_name').includes('BOYNEXTDOOR HOME SWEET HOME'));
});
