import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2/index.html'), 'utf8');
const migrationsDir = join(root, 'supabase/migrations');
const migration = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql') && name.includes('wms_inventory'))
  .map((name) => readFileSync(join(migrationsDir, name), 'utf8'))
  .join('\n');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const token of [
  'data-register-workbench-target="wms"',
  'data-register-workbench-panel="wms"',
  'id="wms-master-search"',
  'id="wms-master-lifecycle"',
  'id="wms-master-release-date"',
  'id="wms-master-staronemall-url"',
  'WMS_SUPABASE_URL',
  'WMS_SUPABASE_ANON',
  'WMS_INVENTORY_SELECT',
  'mrWmsSearchInventoryRows',
  'mrWmsFetchExactGroupRows',
  'mrWmsGroupInventoryRows',
  'mrWmsSearchGroups',
  'mrWmsStageGroup',
  'mrWmsFetchStaronemallObserved',
  'mrWmsDuplicateSignals',
  'mrRenderWmsPreflight',
  "db.rpc('stage_wms_inventory_payload'",
  'p_observed: staroneObserved',
  '_skuLocked',
  'mrSetLifecycleValue',
  'mrGroupLifecycle',
  '_qoo10_available_date_type',
  'qoo10_release_date',
  '_staronemall_url',
  'Duplicate warning must be confirmed before registration.',
  'Platform preflight blockers',
  'Staronemall URL is already used by master SKU',
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
assert(
  html.includes("const orFilter = [") && html.includes("params.set('or', `(${orFilter})`);"),
  'WMS search must wrap PostgREST OR filters in parentheses to avoid inventory.oridol errors',
);

for (const token of [
  "'wms_inventory'",
  'create or replace function public.search_wms_inventory_groups',
  'create or replace function public.stage_wms_inventory_group',
  'create or replace function public.stage_wms_inventory_payload',
  'p_observed jsonb default null',
  'wms_observed_object_required',
  'staronemall_url',
  'source_detail',
  'linked_master_product_id uuid',
  'idx_inventory_wms_master_search_trgm',
  'source_records_source_type_check',
  'source_type, source_external_id, parser_version',
  'grant execute on function public.search_wms_inventory_groups',
  'grant execute on function public.stage_wms_inventory_group',
  'grant execute on function public.stage_wms_inventory_payload(jsonb, jsonb)',
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
