import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const scriptPath = join(root, 'scripts/shopee-batch-add-item-probe-dry-run.mjs');
const bridgePath = join(root, 'supabase/functions/shopee-bridge/index.ts');
const planPath = join(root, 'plans/shopee-batch-add-item-dry-probe-plan.md');
const matrixPath = join(root, 'plans/shopee-api-update-impact-matrix-2026-06-24.md');
const apiDocPath = 'C:/dev/api-refs/marketplaces/shopee/docs_ai/apis/product/v2.product.batch_add_item.json';

function runJson(args) {
  return JSON.parse(execFileSync('node', [scriptPath, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

const sample = runJson(['--sample', '--json']);
assert.equal(sample.ok, true, 'sample dry-run should pass request-shape validation');
assert.equal(sample.will_call_shopee, false, 'sample dry-run must not call Shopee');
assert.equal(sample.will_call_shopee_add_item_api, false, 'sample dry-run must not call batch_add_item');
assert.equal(sample.will_mutate_listing, false, 'sample dry-run must not create an item');
assert.equal(sample.future_batch_add_item.path, '/api/v2/product/batch_add_item');
assert.equal(sample.future_get_batch_task_result.query.task_type, 4);
assert.equal(sample.compatibility.current_v2_replacement_ready, false);
assert.equal(sample.compatibility.status, 'shape_ready_but_not_cbsc_replacement');
assert.equal(sample.current_v2_flow.auth_scope, 'merchant');
assert.equal(sample.candidate_batch_add_item_flow.auth_scope, 'shop');
assert.ok(sample.future_batch_add_item.body.item_list[0].logistic_info.length >= 1, 'sample should include explicit logistic_info');

const noLogisticsFixture = join(tmpdir(), 'shopee-batch-add-no-logistics.json');
writeFileSync(noLogisticsFixture, `\uFEFF${JSON.stringify({
  rawResponse: {
    computed_payload: {
      account_key: 'starphotocard',
      region: 'SG',
      name: 'Missing logistics item',
      sku: 'NO-LOGISTICS',
      category_id: 100740,
      image_id_list: ['sg_image_id'],
      weight_g: 100,
      price: 20,
      stock: 1,
      description: 'Missing logistics fixture',
      targets: [{ region: 'SG', shop_id: 1001961186, price: 20, days_to_ship: 2 }],
    },
  },
})}`);
const noLogistics = runJson(['--input', noLogisticsFixture, '--json']);
assert.equal(noLogistics.ok, false, 'missing logistics dry-run should not be submit-ready');
assert.equal(noLogistics.compatibility.status, 'blocked_missing_required_fields');
assert.ok(
  noLogistics.payload_validation.missing_required_paths.includes('item_list[0].logistic_info'),
  'missing logistics should be explicit',
);

const optionFixture = join(tmpdir(), 'shopee-batch-add-option-fixture.json');
writeFileSync(optionFixture, JSON.stringify({
  computed_payload: {
    account_key: 'starphotocard',
    region: 'SG',
    name: 'Option group fixture',
    sku: 'OPTION-PARENT',
    category_id: 100740,
    image_id_list: ['sg_image_id'],
    weight_g: 100,
    price: 20,
    stock: 2,
    description: 'Option group fixture',
    targets: [{ region: 'SG', shop_id: 1001961186, price: 20, days_to_ship: 2 }],
    variation: {
      tier_variation: [{ name: 'Version', option_list: [{ option: 'A' }, { option: 'B' }] }],
      model: [
        { tier_index: [0], global_model_sku: 'OPTION-A', original_price: 20, seller_stock: [{ stock: 1 }] },
        { tier_index: [1], global_model_sku: 'OPTION-B', original_price: 20, seller_stock: [{ stock: 1 }] },
      ],
    },
  },
}));
const optionDryRun = runJson(['--input', optionFixture, '--logistic-id', '80007', '--json']);
assert.equal(optionDryRun.ok, false, 'option group mapping should remain blocked even with a placeholder logistics channel');
assert.equal(optionDryRun.compatibility.status, 'blocked_option_group_unmapped');
assert.ok(optionDryRun.unmapped_current_v2_fields.includes('variation'), 'variation must be listed as unmapped');
assert.ok(
  optionDryRun.payload_validation.warnings.some((warning) => warning.includes('no tier_variation/model fields')),
  'option warning should cite captured doc limitation',
);

const script = readFileSync(scriptPath, 'utf8');
for (const token of [
  'will_call_shopee_add_item_api: false',
  'current_v2_replacement_ready: false',
  'v2.global_product.add_global_item.json',
  '/api/v2/product/batch_add_item',
  'task_type: 4',
  'option_group_mapping_unverified',
  'operator_cli_placeholder',
]) {
  assert.ok(script.includes(token), `dry-run script missing safety token: ${token}`);
}

const bridge = readFileSync(bridgePath, 'utf8');
assert.ok(bridge.includes("if (action === 'register_cbsc' && req.method === 'POST')"), 'current register_cbsc route must remain present');
assert.ok(bridge.includes("'/api/v2/global_product/add_global_item'"), 'current V2 registration must remain Global Product based');
assert.ok(bridge.includes("'/api/v2/global_product/create_publish_task'"), 'current V2 registration must still publish per region');
assert.ok(!bridge.includes("'/api/v2/product/batch_add_item'"), 'dry probe must not add a live batch_add_item bridge route');

const plan = readFileSync(planPath, 'utf8');
for (const token of [
  'batch_add_item dry/probe',
  'will_call_shopee_add_item_api=false',
  'current_v2_replacement_ready=false',
  'logistic_info',
  'option-group mapping',
]) {
  assert.ok(plan.includes(token), `batch_add_item plan missing token: ${token}`);
}

const matrix = readFileSync(matrixPath, 'utf8');
assert.ok(matrix.includes('batch_add_item dry/probe script is now available'), 'impact matrix should record dry/probe availability');

const apiDoc = JSON.parse(readFileSync(apiDocPath, 'utf8'));
assert.equal(apiDoc.project_decision.status, 'dry_probe_available_no_live_call');
assert.ok(
  apiDoc.project_decision.evidence.some((entry) => entry.includes('current_v2_replacement_ready=false')),
  'API doc should record dry/probe replacement decision',
);

console.log('Shopee batch_add_item dry/probe checks passed');
