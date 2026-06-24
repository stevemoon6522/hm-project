import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const v2Path = join(repoRoot, 'v2', 'index.html');

const DEFAULT_DOC_ROOT = 'C:/dev/api-refs/marketplaces/shopee/docs_ai/apis/product';
const PRICE_DOC = 'v2.product.batch_update_outlet_price.json';
const RESULT_DOC = 'v2.product.get_batch_task_result.json';
const OPERATING_REGIONS = new Set(['SG', 'TW', 'TH', 'MY', 'PH', 'BR']);

function usage() {
  return `Usage:
  node scripts/shopee-batch-price-probe-dry-run.mjs --sample [--emit-curl]
  node scripts/shopee-batch-price-probe-dry-run.mjs --input path.json [--price 12.34] [--emit-curl]
  node scripts/shopee-batch-price-probe-dry-run.mjs --from-db --sku SKU --region SG [--price 12.34] [--emit-curl]
  node scripts/shopee-batch-price-probe-dry-run.mjs --from-lookup --sku SKU --region SG [--price 12.34] [--emit-curl]

This script is non-mutating. It never calls Shopee batch_update_outlet_price.`;
}

function parseArgs(argv) {
  const args = {
    sample: false,
    input: '',
    fromDb: false,
    fromLookup: false,
    sku: '',
    productId: '',
    region: 'SG',
    price: null,
    accountKey: '',
    emitCurl: false,
    json: false,
    lookupMaxItems: 1,
    lookupMaxGlobalItems: 1,
    docRoot: process.env.SHOPEE_API_REFS_PRODUCT_DIR || DEFAULT_DOC_ROOT,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${token}`);
      i += 1;
      return argv[i];
    };

    if (token === '--sample') args.sample = true;
    else if (token === '--input') args.input = next();
    else if (token === '--from-db') args.fromDb = true;
    else if (token === '--from-lookup') args.fromLookup = true;
    else if (token === '--sku') args.sku = next();
    else if (token === '--product-id') args.productId = next();
    else if (token === '--region') args.region = String(next()).toUpperCase();
    else if (token === '--price') args.price = Number(next());
    else if (token === '--account-key') args.accountKey = next();
    else if (token === '--emit-curl') args.emitCurl = true;
    else if (token === '--json') args.json = true;
    else if (token === '--lookup-max-items') args.lookupMaxItems = Number(next());
    else if (token === '--lookup-max-global-items') args.lookupMaxGlobalItems = Number(next());
    else if (token === '--doc-root') args.docRoot = next();
    else if (token === '--help' || token === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!OPERATING_REGIONS.has(args.region)) {
    throw new Error(`Unsupported region ${args.region}. Expected one of ${[...OPERATING_REGIONS].join(', ')}`);
  }
  if (args.price != null && (!Number.isFinite(args.price) || args.price <= 0)) {
    throw new Error('--price must be a positive number when provided');
  }
  if (args.lookupMaxItems != null && (!Number.isFinite(args.lookupMaxItems) || args.lookupMaxItems < 1)) {
    throw new Error('--lookup-max-items must be a positive number');
  }
  if (args.lookupMaxGlobalItems != null && (!Number.isFinite(args.lookupMaxGlobalItems) || args.lookupMaxGlobalItems < 1)) {
    throw new Error('--lookup-max-global-items must be a positive number');
  }
  const selectedModes = [args.sample, Boolean(args.input), args.fromDb, args.fromLookup].filter(Boolean).length;
  if (selectedModes > 1) throw new Error('Choose only one input mode: --sample, --input, --from-db, or --from-lookup');
  if (args.fromLookup && !args.sku) throw new Error('--from-lookup requires --sku');
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function readV2Env() {
  const html = readFileSync(v2Path, 'utf8');
  const pick = (name) => html.match(new RegExp(`const\\s+${name}\\s*=\\s*'([^']+)'`))?.[1] || '';
  const supabaseUrl = pick('SUPABASE_URL');
  const supabaseAnon = pick('SUPABASE_ANON');
  const defaultAccountKey = pick('SHOPEE_DEFAULT_ACCOUNT_KEY') || 'starphotocard';
  if (!supabaseUrl || !supabaseAnon) throw new Error('SUPABASE_URL or SUPABASE_ANON not found in v2/index.html');
  return {
    supabaseUrl,
    supabaseAnon,
    shopeeBridge: `${supabaseUrl.replace(/\/$/, '')}/functions/v1/shopee-bridge`,
    defaultAccountKey,
  };
}

function validateDocs(docRoot) {
  const priceDocPath = join(docRoot, PRICE_DOC);
  const resultDocPath = join(docRoot, RESULT_DOC);
  const priceDoc = readJson(priceDocPath);
  const resultDoc = readJson(resultDocPath);

  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(message);
  };

  expect(priceDoc.api?.path === '/api/v2/product/batch_update_outlet_price', 'price doc path mismatch');
  expect(priceDoc.api?.method === 'POST', 'price doc method must be POST');
  expect(priceDoc.api?.task_type === 1, 'price doc task_type must be 1');
  expect(priceDoc.request?.limits?.item_list_max === 100, 'price doc item_list_max must be 100');
  expect((priceDoc.request?.required_params || []).includes('item_list[].outlet_shop_id'), 'price doc missing outlet_shop_id requirement');
  expect((priceDoc.request?.required_params || []).includes('item_list[].item_id'), 'price doc missing item_id requirement');
  expect((priceDoc.request?.required_params || []).includes('item_list[].price_list[].original_price'), 'price doc missing original_price requirement');

  expect(resultDoc.api?.path === '/api/v2/product/get_batch_task_result', 'result doc path mismatch');
  expect(resultDoc.api?.method === 'GET', 'result doc method must be GET');
  const taskTypeParam = (resultDoc.request?.query_params || []).find((p) => p.name === 'task_type');
  expect(Boolean(taskTypeParam), 'result doc missing task_type query param');
  expect((taskTypeParam?.enum_values || []).some((row) => row.value === 1 && row.label === 'price'), 'result doc missing task_type=1 price enum');
  expect((resultDoc.response?.main_response_paths || []).includes('response.failed_list'), 'result doc missing failed_list response path');

  return {
    ok: failures.length === 0,
    failures,
    files: {
      price: priceDocPath,
      result: resultDocPath,
    },
  };
}

function sampleFixture() {
  return {
    product: {
      id: '00000000-0000-4000-8000-000000000001',
      sku: 'DRY-PROBE-SAMPLE',
      product_name: 'Dry probe sample product',
    },
    listing: {
      product_id: '00000000-0000-4000-8000-000000000001',
      account_key: 'starphotocard',
      region: 'SG',
      shop_id: 123456789,
      shop_item_id: 987654321,
      shop_model_id: 0,
      status: 'mapped',
      last_synced_price: 12.34,
      last_synced_at: '2026-06-24T00:00:00.000Z',
    },
    price: 12.34,
  };
}

function normalizeInput(raw, args, env) {
  const product = raw.product || raw.products?.[0] || {};
  const listing = raw.listing || raw.product_shopee_listing || raw.listings?.[0] || raw;
  const region = String(args.region || listing.region || 'SG').toUpperCase();
  const accountKey = args.accountKey || listing.account_key || env.defaultAccountKey;
  const price = args.price ?? Number(raw.price ?? raw.original_price ?? listing.last_synced_price);

  return {
    product,
    listing: {
      ...listing,
      region,
      account_key: accountKey,
    },
    price,
  };
}

async function restGet(env, table, query) {
  const url = `${env.supabaseUrl.replace(/\/$/, '')}/rest/v1/${table}?${query}`;
  const resp = await fetch(url, {
    headers: {
      apikey: env.supabaseAnon,
      Authorization: `Bearer ${env.supabaseAnon}`,
      Accept: 'application/json',
    },
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { parse_error: text };
  }
  if (!resp.ok) throw new Error(`${table} read failed HTTP ${resp.status}: ${text}`);
  return json;
}

async function loadFromDb(args, env) {
  if (!args.sku && !args.productId) throw new Error('--from-db requires --sku or --product-id');
  const productFilter = args.productId
    ? `id=eq.${encodeURIComponent(args.productId)}`
    : `sku=eq.${encodeURIComponent(args.sku)}`;
  const products = await restGet(
    env,
    'products',
    `select=id,sku,product_name,option_name,cost_krw,weight_g&${productFilter}&limit=2`,
  );
  if (!Array.isArray(products) || products.length === 0) throw new Error('No product found for requested selector');
  if (products.length > 1) throw new Error('Multiple products matched. Use --product-id for an exact dry probe.');
  const product = products[0];
  const accountKey = args.accountKey || env.defaultAccountKey;
  const listings = await restGet(
    env,
    'product_shopee_listings',
    [
      'select=product_id,account_key,region,shop_id,shop_item_id,shop_model_id,status,last_synced_price,last_synced_at',
      `product_id=eq.${encodeURIComponent(product.id)}`,
      `account_key=eq.${encodeURIComponent(accountKey)}`,
      `region=eq.${encodeURIComponent(args.region)}`,
      'limit=2',
    ].join('&'),
  );
  if (!Array.isArray(listings) || listings.length === 0) throw new Error('No product_shopee_listings row found for product/account/region');
  if (listings.length > 1) throw new Error('Multiple listing rows matched; expected account_key+region uniqueness');
  return normalizeInput({ product, listing: listings[0] }, args, env);
}

async function loadFromLookup(args, env) {
  if (!args.sku) throw new Error('--from-lookup requires --sku');
  const accountKey = args.accountKey || env.defaultAccountKey;
  const params = new URLSearchParams({
    sku: args.sku,
    regions: args.region,
    account_key: accountKey,
    max_items: String(Math.max(1, Math.min(5000, Math.floor(args.lookupMaxItems || 1)))),
    max_global_items: String(Math.max(1, Math.min(1000, Math.floor(args.lookupMaxGlobalItems || 1)))),
  });
  const resp = await fetch(`${env.shopeeBridge}/lookup-sku?${params}`, {
    headers: {
      apikey: env.supabaseAnon,
      Authorization: `Bearer ${env.supabaseAnon}`,
      Accept: 'application/json',
    },
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { parse_error: text };
  }
  if (!resp.ok || !json?.ok) {
    throw new Error(`lookup-sku failed HTTP ${resp.status}: ${text}`);
  }

  const wantedRegion = String(args.region || 'SG').toUpperCase();
  const regionRows = Array.isArray(json.region_results) ? json.region_results : [];
  const row = regionRows.find((entry) => String(entry?.region || '').toUpperCase() === wantedRegion) || null;
  const hit = row?.hit || (Array.isArray(json.region_hits)
    ? json.region_hits.find((entry) => String(entry?.region || '').toUpperCase() === wantedRegion)
    : null);
  if (!hit || hit.source !== 'product_shopee_listings') {
    throw new Error(`No local product_shopee_listings hit for sku=${args.sku} region=${wantedRegion}`);
  }

  return normalizeInput({
    product: {
      sku: args.sku,
      product_name: hit.item_name || '',
    },
    listing: {
      account_key: json.account_key || accountKey,
      region: wantedRegion,
      shop_id: hit.shop_id,
      shop_item_id: hit.shop_item_id || hit.item_id,
      shop_model_id: hit.shop_model_id || hit.model_id || 0,
      status: hit.status || hit.item_status || 'mapped',
      last_synced_price: hit.current_price ?? hit.original_price,
      last_synced_at: hit.last_synced_at || null,
    },
    price: args.price ?? hit.current_price ?? hit.original_price,
  }, args, env);
}

function loadInput(args, env) {
  if (args.sample || (!args.input && !args.fromDb && !args.fromLookup)) return normalizeInput(sampleFixture(), args, env);
  if (args.input) return normalizeInput(readJson(resolve(args.input)), args, env);
  throw new Error('No local input mode selected');
}

function buildBatchPricePayload(input) {
  const { product, listing, price } = input;
  const outletShopId = Number(listing.shop_id || listing.outlet_shop_id);
  const itemId = Number(listing.shop_item_id || listing.item_id);
  const rawModelId = listing.shop_model_id ?? listing.model_id ?? 0;
  const modelId = rawModelId === null || rawModelId === '' ? 0 : Number(rawModelId);
  const originalPrice = Number(price);

  const priceEntry = {
    original_price: originalPrice,
  };
  if (Number.isFinite(modelId) && modelId > 0) priceEntry.model_id = modelId;

  const row = {
    outlet_shop_id: outletShopId,
    item_id: itemId,
    price_list: [priceEntry],
  };

  return {
    request: {
      item_list: [row],
    },
    correlation: {
      product_id: product.id || listing.product_id || null,
      sku: product.sku || listing.sku || null,
      account_key: listing.account_key,
      region: listing.region,
      shop_id: outletShopId,
      item_id: itemId,
      model_id: Number.isFinite(modelId) && modelId > 0 ? modelId : 0,
      previous_price: listing.last_synced_price ?? null,
      requested_price: originalPrice,
    },
  };
}

function validatePayloadShape(batch) {
  const failures = [];
  const itemList = batch.request.item_list;
  if (!Array.isArray(itemList)) failures.push('item_list must be an array');
  if (!itemList.length || itemList.length > 100) failures.push('item_list length must be between 1 and 100');

  itemList.forEach((row, idx) => {
    if (!Number.isFinite(Number(row.outlet_shop_id)) || Number(row.outlet_shop_id) <= 0) failures.push(`item_list[${idx}].outlet_shop_id must be positive`);
    if (!Number.isFinite(Number(row.item_id)) || Number(row.item_id) <= 0) failures.push(`item_list[${idx}].item_id must be positive`);
    if (!Array.isArray(row.price_list) || row.price_list.length < 1) failures.push(`item_list[${idx}].price_list must have at least 1 row`);
    (row.price_list || []).forEach((priceRow, pidx) => {
      if (!Number.isFinite(Number(priceRow.original_price)) || Number(priceRow.original_price) <= 0) {
        failures.push(`item_list[${idx}].price_list[${pidx}].original_price must be greater than 0`);
      }
      if ('model_id' in priceRow && (!Number.isFinite(Number(priceRow.model_id)) || Number(priceRow.model_id) <= 0)) {
        failures.push(`item_list[${idx}].price_list[${pidx}].model_id must be positive when provided`);
      }
    });
  });

  return { ok: failures.length === 0, failures };
}

function buildFutureCurl(env, args, batch) {
  const endpoint = `${env.shopeeBridge}/batch_update_outlet_price`;
  const body = {
    account_key: batch.correlation.account_key,
    region: batch.correlation.region,
    ...batch.request,
  };
  return [
    'curl --request POST',
    `  --url ${JSON.stringify(endpoint)}`,
    '  --header "Content-Type: application/json"',
    '  --header "Authorization: Bearer $SUPABASE_SESSION_OR_ANON"',
    `  --data ${JSON.stringify(JSON.stringify(body))}`,
  ].join(' \\\n');
}

function toOutput({ args, env, docs, input, batch, payloadValidation }) {
  const resultQueryTemplate = {
    endpoint: `${env.shopeeBridge}/batch_task_result`,
    query: {
      account_key: batch.correlation.account_key,
      region: batch.correlation.region,
      task_type: 1,
      task_id: '<task_id returned by batch_update_outlet_price>',
    },
  };

  const out = {
    ok: docs.ok && payloadValidation.ok,
    mode: 'dry-run',
    will_call_shopee: false,
    will_call_shopee_price_api: false,
    will_mutate_price: false,
    docs,
    source: args.fromDb ? 'supabase-readonly' : (args.fromLookup ? 'bridge-lookup-readonly' : (args.input ? 'local-input' : 'sample-fixture')),
    selected: {
      product: {
        id: input.product.id || null,
        sku: input.product.sku || null,
        name: input.product.product_name || input.product.option_name || null,
      },
      listing: {
        account_key: batch.correlation.account_key,
        region: batch.correlation.region,
        shop_id: batch.correlation.shop_id,
        item_id: batch.correlation.item_id,
        model_id: batch.correlation.model_id,
        previous_price: batch.correlation.previous_price,
      },
    },
    future_batch_update_outlet_price: {
      method: 'POST',
      path: '/api/v2/product/batch_update_outlet_price',
      body: batch.request,
    },
    future_get_batch_task_result: resultQueryTemplate,
    correlation_key: batch.correlation,
    payload_validation: payloadValidation,
    safety_notes: [
      'This script did not call Shopee batch_update_outlet_price.',
      'A later live compatibility spike must be explicitly approved and should start with one SG item.',
      'Use current last_synced_price for the first live spike unless an operator chooses a different price.',
    ],
  };
  if (args.fromLookup) {
    out.lookup_bridge = {
      endpoint: `${env.shopeeBridge}/lookup-sku`,
      may_call_shopee_read_apis: true,
      will_call_shopee_price_api: false,
    };
  }
  if (args.emitCurl) out.future_manual_curl_not_executed = buildFutureCurl(env, args, batch);
  return out;
}

function printHuman(out) {
  console.log('Shopee batch price dry probe');
  console.log('============================');
  console.log(`ok: ${out.ok}`);
  console.log(`source: ${out.source}`);
  console.log(`will_call_shopee: ${out.will_call_shopee}`);
  console.log(`will_call_shopee_price_api: ${out.will_call_shopee_price_api}`);
  console.log(`docs_ok: ${out.docs.ok}`);
  if (!out.docs.ok) console.log(`docs_failures: ${out.docs.failures.join('; ')}`);
  console.log(`payload_ok: ${out.payload_validation.ok}`);
  if (!out.payload_validation.ok) console.log(`payload_failures: ${out.payload_validation.failures.join('; ')}`);
  console.log('');
  console.log('Selected target');
  console.log(JSON.stringify(out.selected, null, 2));
  console.log('');
  console.log('Future batch_update_outlet_price body (not sent)');
  console.log(JSON.stringify(out.future_batch_update_outlet_price.body, null, 2));
  console.log('');
  console.log('Future get_batch_task_result query template');
  console.log(JSON.stringify(out.future_get_batch_task_result, null, 2));
  if (out.future_manual_curl_not_executed) {
    console.log('');
    console.log('Manual curl template (not executed)');
    console.log(out.future_manual_curl_not_executed);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = readV2Env();
  const docs = validateDocs(args.docRoot);
  const input = args.fromDb ? await loadFromDb(args, env) : (args.fromLookup ? await loadFromLookup(args, env) : loadInput(args, env));
  const batch = buildBatchPricePayload(input);
  const payloadValidation = validatePayloadShape(batch);
  const out = toOutput({ args, env, docs, input, batch, payloadValidation });

  if (args.json) console.log(JSON.stringify(out, null, 2));
  else printHuman(out);

  if (!out.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`ERROR: ${err.message || err}`);
  console.error('');
  console.error(usage());
  process.exitCode = 1;
});
