import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const scriptPath = join(root, 'scripts/shopee-batch-price-probe-dry-run.mjs');
const v2Path = join(root, 'v2/index.html');
const planPath = join(root, 'plans/shopee-batch-price-dry-probe-plan.md');
const supabaseBridgePath = join(root, 'supabase/functions/shopee-bridge/index.ts');
const edgeBridgePath = join(root, 'edge-functions/shopee-bridge/index.ts');

function runJson(args) {
  return JSON.parse(execFileSync('node', [scriptPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function sliceBetween(source, start, end) {
  const s = source.indexOf(start);
  assert.ok(s >= 0, `missing start token: ${start}`);
  const e = source.indexOf(end, s);
  assert.ok(e > s, `missing end token after ${start}: ${end}`);
  return source.slice(s, e);
}

const sample = runJson(['--sample', '--json']);
assert.equal(sample.ok, true, 'sample dry-run should pass');
assert.equal(sample.will_call_shopee_price_api, false, 'sample dry-run must not call Shopee price API');
assert.equal(sample.will_mutate_price, false, 'sample dry-run must not mutate price');
assert.equal(sample.future_batch_update_outlet_price.path, '/api/v2/product/batch_update_outlet_price');
assert.equal(sample.future_get_batch_task_result.query.task_type, 1);

const fixturePath = join(tmpdir(), 'shopee-batch-price-probe-bom-fixture.json');
writeFileSync(fixturePath, `\uFEFF${JSON.stringify({
  product: { sku: 'BOM-SKU', product_name: 'BOM fixture' },
  listing: {
    account_key: 'starphotocard',
    region: 'SG',
    shop_id: 1001961186,
    shop_item_id: 43322467262,
    shop_model_id: 228142123769,
    last_synced_price: 26.39,
  },
})}`);
const bomFixture = runJson(['--input', fixturePath, '--region', 'SG', '--json']);
assert.equal(bomFixture.ok, true, 'BOM JSON fixture should parse');
assert.equal(bomFixture.future_batch_update_outlet_price.body.item_list[0].outlet_shop_id, 1001961186);
assert.equal(bomFixture.future_batch_update_outlet_price.body.item_list[0].price_list[0].model_id, 228142123769);

const dryScript = readFileSync(scriptPath, 'utf8');
for (const token of [
  '--from-lookup',
  '/lookup-sku?',
  'bridge-lookup-readonly',
  'may_call_shopee_read_apis',
  'No local product_shopee_listings hit',
]) {
  assert.ok(dryScript.includes(token), `dry-run script missing lookup token: ${token}`);
}

const supabaseBridge = readFileSync(supabaseBridgePath, 'utf8');
const edgeBridge = readFileSync(edgeBridgePath, 'utf8');
const v2 = readFileSync(v2Path, 'utf8');
const plan = readFileSync(planPath, 'utf8');
assert.equal(sha256(edgeBridge), sha256(supabaseBridge), 'edge-functions and supabase/functions shopee-bridge copies must match');

assert.ok(!sliceBetween(supabaseBridge, 'const PUBLIC_ACTIONS', ']);').includes('batch_update_outlet_price'), 'batch update route must not be public');
assert.ok(!sliceBetween(supabaseBridge, 'const PUBLIC_ACTIONS', ']);').includes('batch_task_result'), 'batch task result route must not be public');

const batchBlock = sliceBetween(
  supabaseBridge,
  "if (action === 'batch_update_outlet_price' && req.method === 'POST')",
  "if (action === 'batch_task_result' && req.method === 'GET')",
);
for (const token of [
  'normalizeBatchOutletPriceItemList(body.item_list)',
  'SHOPEE_BATCH_PRICE_CONFIRMATION',
  'live_batch_price_confirmation_required',
  "'/api/v2/product/batch_update_outlet_price'",
  "body: { item_list: normalized.item_list }",
  "action: 'batch_update_outlet_price'",
  'docs_ai/apis/product/v2.product.batch_update_outlet_price.json',
]) {
  assert.ok(batchBlock.includes(token), `batch_update_outlet_price block missing token: ${token}`);
}

const taskBlock = sliceBetween(
  supabaseBridge,
  "if (action === 'batch_task_result' && req.method === 'GET')",
  "if (action === 'update_price' && req.method === 'POST')",
);
for (const token of [
  'task_type',
  'task_id',
  "'/api/v2/product/get_batch_task_result'",
  'docs_ai/apis/product/v2.product.get_batch_task_result.json',
]) {
  assert.ok(taskBlock.includes(token), `batch_task_result block missing token: ${token}`);
}

assert.ok(
  v2.includes("bridgeUrl: SHOPEE_BRIDGE + '/update_price'"),
  'V2 Shopee live price sync must remain on shop-level update_price for normal CBSC shops',
);
assert.ok(
  !v2.includes("bridgeUrl: SHOPEE_BRIDGE + '/batch_update_outlet_price'"),
  'V2 normal price sync must not use the Mart/Outlet-only batch_update_outlet_price endpoint',
);
const updatePriceBatchBlock = sliceBetween(
  supabaseBridge,
  "if (action === 'update_price_batch' && req.method === 'POST')",
  "if (action === 'update_item_logistics' && req.method === 'POST')",
);
const updatePriceHelperBlock = sliceBetween(
  supabaseBridge,
  'async function executeShopUpdatePriceMutation(',
  'async function runV2MutationAction(',
);
assert.ok(updatePriceBatchBlock.includes('executeShopUpdatePriceMutation'), 'update_price_batch must fan out through the shared shop-level update_price helper');
assert.ok(updatePriceHelperBlock.includes("'/api/v2/product/update_price'"), 'shared update_price helper must call shop-level v2.product.update_price');
const helperApiCallIndex = updatePriceHelperBlock.indexOf("'/api/v2/product/update_price'");
const helperPreCallSkipIndex = updatePriceHelperBlock.indexOf('findOkMutation(payloadHash)');
assert.ok(helperApiCallIndex >= 0, 'shared update_price helper must contain the Shopee update_price API call');
assert.ok(
  helperPreCallSkipIndex === -1 || helperPreCallSkipIndex > helperApiCallIndex,
  'shared update_price helper must not skip the Shopee API call solely because the same price payload succeeded before',
);
assert.ok(
  !updatePriceHelperBlock.includes('shop_update_price_idempotent_skip'),
  'shared update_price helper must not report a historical payload_hash hit as a fresh price update',
);
assert.ok(
  updatePriceHelperBlock.includes('previous_log_id: log.previous_log_id || null'),
  'shared update_price helper must return previous_log_id after a real API call hits a duplicate ok mutation log',
);
assert.ok(!updatePriceBatchBlock.includes("'/api/v2/product/batch_update_outlet_price'"), 'update_price_batch must not use the Outlet/Mart-only Shopee batch_update_outlet_price endpoint');
assert.ok(v2.includes("SHOPEE_BRIDGE + '/update_price_batch'"), 'V2 normal price sync should use the bridge-side update_price_batch wrapper');
assert.ok(!v2.includes("SHOPEE_BRIDGE + '/batch_update_outlet_price'"), 'V2 normal price sync must not call the Outlet/Mart-only bridge route');
for (const token of [
  'parameter invalid : not a mart shop',
  'is_mart_shop=false',
  'is_outlet_shop=false',
  'Keep V2 live price sync on shop-level `v2.product.update_price`',
]) {
  assert.ok(plan.includes(token), `batch price plan must record live non-applicability evidence: ${token}`);
}

console.log('Shopee batch price dry/probe checks passed');
