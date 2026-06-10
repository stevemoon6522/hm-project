import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2/index.html'), 'utf8');
const migration = readFileSync(join(root, 'supabase/migrations/202606100001_wms_inventory_master_import.sql'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const token of [
  'data-register-workbench-target="wms"',
  'data-register-workbench-panel="wms"',
  'id="wms-master-search"',
  'id="wms-master-lifecycle"',
  'id="wms-master-release-date"',
  'WMS_SUPABASE_URL',
  'WMS_SUPABASE_ANON',
  'WMS_INVENTORY_SELECT',
  'mrWmsSearchInventoryRows',
  'mrWmsFetchExactGroupRows',
  'mrWmsGroupInventoryRows',
  'mrWmsSearchGroups',
  'mrWmsStageGroup',
  "db.rpc('stage_wms_inventory_payload'",
  '_skuLocked',
  'mrSetLifecycleValue',
  'mrGroupLifecycle',
  '_qoo10_available_date_type',
  'qoo10_release_date',
  'inventory: Number(row._inventory_quantity',
]) {
  assert(html.includes(token), `WMS master import UI/flow missing token: ${token}`);
}

assert(
  html.includes('if (row?._skuLocked && row?._sku) return row._sku;'),
  'WMS import must preserve WMS SKU instead of regenerating it',
);
assert(
  html.includes("groupLifecycle === 'pre_order'") && html.includes('p_lifecycle_state:        groupLifecycle'),
  'registration must publish using group lifecycle, not stale form default',
);
assert(
  html.includes("PRE ORDER requires a Qoo10 release date."),
  'WMS PRE ORDER import must require manual Qoo10 release date',
);

for (const token of [
  "'wms_inventory'",
  'create or replace function public.search_wms_inventory_groups',
  'create or replace function public.stage_wms_inventory_group',
  'create or replace function public.stage_wms_inventory_payload',
  'idx_inventory_wms_master_search_trgm',
  'source_records_source_type_check',
  'source_type, source_external_id, parser_version',
  'grant execute on function public.search_wms_inventory_groups',
  'grant execute on function public.stage_wms_inventory_group',
  'grant execute on function public.stage_wms_inventory_payload',
]) {
  assert(migration.includes(token), `WMS master import migration missing token: ${token}`);
}

assert(
  migration.includes('length(v_query) < 2') && migration.includes('limit $2'),
  'WMS group search must be query-gated and limited',
);
assert(
  migration.includes('information_schema.columns') && migration.includes('v_has_weight') && migration.includes('v_has_stock_kr'),
  'WMS staging RPC must tolerate optional inventory columns',
);
assert(
  migration.includes('wms_payload_single_group_required') && migration.includes('wms_rows_max_200'),
  'WMS payload staging must validate selected payload shape',
);

console.log('v2 WMS master import static checks passed');
