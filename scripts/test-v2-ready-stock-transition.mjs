import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2/index.html'), 'utf8');
const bridge = readFileSync(join(root, 'supabase/functions/shopee-bridge/index.ts'), 'utf8');
const edgeBridge = readFileSync(join(root, 'edge-functions/shopee-bridge/index.ts'), 'utf8');
const migration = readFileSync(join(root, 'supabase/migrations/202605140001_v2_ready_stock_transition.sql'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const id of [
  'view-pre-order',
  'po-search',
  'po-region-filters',
  'po-body',
  'po-refresh',
  'view-ready-stock',
  'rsw-search',
  'rsw-product-list',
  'rsw-selection-summary',
  'rsw-weight-inputs',
  'rsw-matrix-wrap',
  'rsw-dry-btn',
  'rsw-live-btn',
  'rsw-result-body',
]) {
  assert(html.includes(`id="${id}"`), `${id} is missing from v2 UI`);
}

for (const token of [
  'renderPreOrderList',
  'openReadyStockWizard',
  'renderReadyStockView',
  'isPreOrderProduct',
  'buildReadyTransitionPlan',
  'showReadyPreviewModal',
  'applyReadyTransition',
  'update_global_item',
  'update_global_model',
  'global_item_name',
  'days_to_ship: 1',
  "lifecycle_state: 'ready_stock'",
  "title_state: 'READY_STOCK'",
  'row-error',
]) {
  assert(html.includes(token), `transition UI missing ${token}`);
}

const transitionSlice = html.slice(html.indexOf('function buildReadyTransitionPlan'), html.indexOf('function renderRegionFields'));
assert(!transitionSlice.includes('update_global_price'), 'P0-2 transition flow must not wire repricing/update_global_price');
assert(transitionSlice.includes('pre_order: { days_to_ship: 1 }'), 'transition must send global PRE ORDER DTS=1');
assert(transitionSlice.includes('weight: Math.round(row.weightG) / 1000'), 'transition must convert edited grams to KG for Shopee');

for (const source of [bridge, edgeBridge]) {
  assert(source.includes('global_item_name'), 'bridge must accept/send global_item_name for READY STOCK rename');
  assert(source.includes('requestPayload.pre_order = { days_to_ship }'), 'bridge must map days_to_ship to update_global_item pre_order.days_to_ship');
  assert(source.includes('requestPayload.weight = weight'), 'bridge must support item-level weight updates');
  assert(source.includes("action === 'update_global_model'"), 'bridge must keep update_global_model path for SKU/weight updates');
}

for (const token of [
  'lifecycle_state',
  'weight_measured_at',
  'days_to_ship',
  'title_state',
  'last_pushed_name',
  'last_pushed_at',
]) {
  assert(migration.includes(token), `migration missing ${token}`);
}

console.log('v2 READY STOCK transition static checks passed');
