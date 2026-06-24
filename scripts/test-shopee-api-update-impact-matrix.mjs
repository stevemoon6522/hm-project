import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const matrixPath = join(root, 'plans/shopee-api-update-impact-matrix-2026-06-24.md');
const v2Path = join(root, 'v2/index.html');
const wikiPath = 'C:/Users/STEVE/Documents/MVPICK/00_Inbox/Shopee Product Batch API update - 2026-06-24.md';
const apiRoot = 'C:/dev/api-refs/marketplaces/shopee/docs_ai/apis/product';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertIncludes(source, token, label) {
  assert.ok(source.includes(token), `${label} missing token: ${token}`);
}

const matrix = readFileSync(matrixPath, 'utf8');
const wiki = readFileSync(wikiPath, 'utf8');
const v2 = readFileSync(v2Path, 'utf8');

for (const token of [
  'parameter invalid : not a mart shop',
  'is_mart_shop=false',
  'is_outlet_shop=false',
  'Keep V2 price sync on shop-level `v2.product.update_price`',
  'v2.product.batch_update_outlet_stock',
  'v2.product.batch_publish_item_to_outlet_shop',
  'v2.product.batch_add_item',
  'v2.product.get_batch_task_result',
  'v2.product.get_ssp_list',
  'buyer_payment_info.ads_voucher_discount',
  'error_in_fetching_is_prescription_item',
  'prescription_check_status',
  'batch_add_item dry/probe script is now available',
  'current_v2_replacement_ready=false',
]) {
  assertIncludes(matrix, token, 'impact matrix');
}

assertIncludes(
  v2,
  "bridgeUrl: SHOPEE_BRIDGE + '/update_price'",
  'V2 price sync implementation',
);
assert.ok(
  !v2.includes("bridgeUrl: SHOPEE_BRIDGE + '/batch_update_outlet_price'"),
  'V2 normal price sync must not use the Mart/Outlet batch price endpoint',
);

for (const token of [
  'Impact matrix',
  'v2.product.batch_update_outlet_stock',
  'v2.product.batch_publish_item_to_outlet_shop',
  'buyer_payment_info.ads_voucher_discount',
  'prescription_check_status',
]) {
  assertIncludes(wiki, token, 'wiki review draft');
}

const priceDoc = readJson(join(apiRoot, 'v2.product.batch_update_outlet_price.json'));
const stockDoc = readJson(join(apiRoot, 'v2.product.batch_update_outlet_stock.json'));
const publishDoc = readJson(join(apiRoot, 'v2.product.batch_publish_item_to_outlet_shop.json'));
const addDoc = readJson(join(apiRoot, 'v2.product.batch_add_item.json'));
const taskDoc = readJson(join(apiRoot, 'v2.product.get_batch_task_result.json'));

assert.equal(
  priceDoc.project_decision.status,
  'do_not_adopt_for_current_starphotocard_v2_price_sync',
);
assert.equal(
  stockDoc.project_decision.status,
  'do_not_adopt_for_current_starphotocard_v2_or_wms_stock_sync',
);
assert.equal(
  publishDoc.project_decision.status,
  'do_not_adopt_for_current_starphotocard_v2_registration',
);
assert.equal(addDoc.project_decision.status, 'dry_probe_available_no_live_call');
assert.equal(taskDoc.project_decision.status, 'supporting_endpoint_only');

for (const doc of [stockDoc, publishDoc]) {
  assert.ok(
    doc.project_decision.evidence.some((entry) => entry.includes('is_mart_shop=false')),
    `${doc.api.name} must record current shop evidence`,
  );
  assert.ok(
    doc.project_decision.evidence.some((entry) => entry.includes('not a mart shop')),
    `${doc.api.name} must reference the live probe rejection`,
  );
}

assert.ok(
  addDoc.project_decision.evidence.some((entry) => entry.includes('does not use outlet_shop_id')),
  'batch_add_item must be treated separately from Outlet-only API rejection',
);
assert.ok(
  addDoc.project_decision.evidence.some((entry) => entry.includes('current_v2_replacement_ready=false')),
  'batch_add_item must record the current V2 replacement decision',
);
assert.ok(
  taskDoc.project_decision.evidence.some((entry) => entry.includes('valid task_id')),
  'get_batch_task_result must be tied to successful task creation',
);

console.log('Shopee API update impact matrix checks passed');
