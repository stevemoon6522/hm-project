import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assertModule from 'node:assert/strict';

const root = process.cwd();
const html = readFileSync(join(root, 'v2/index.html'), 'utf8');
const migrationsDir = join(root, 'supabase/migrations');
const migration = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql') && name.includes('wms_inventory'))
  .map((name) => readFileSync(join(migrationsDir, name), 'utf8'))
  .join('\n');
const statusFixMigration = readFileSync(join(migrationsDir, '202606120002_wms_inventory_observed_status_fix.sql'), 'utf8');
const arrayGuardMigration = readFileSync(join(migrationsDir, '202606160003_wms_jsonb_array_guards.sql'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not parse function ${name}`);
}

for (const token of [
  'data-register-workbench-target="wms"',
  'data-register-workbench-panel="wms"',
  'id="wms-master-search"',
  'id="wms-master-lifecycle"',
  'id="wms-master-release-date"',
  'WMS_SUPABASE_URL',
  'WMS_SUPABASE_ANON',
  'WMS_INVENTORY_SELECT_BASE',
  'WMS_INVENTORY_SELECT',
  'bundle_components',
  'bundle_components_updated_at',
  'cost_price',
  'mrWmsInventorySelect',
  'mrWmsBundleComponents',
  'mrWmsIsBundleRow',
  'mrWmsBundleComponentSkus',
  'mrWmsNormalizeStagePayloadRow',
  'mrWmsSearchInventoryRows',
  'mrWmsFetchExactGroupRows',
  'mrWmsFetchBundleRowsForBarcodeGroup',
  'mrWmsFetchBundleOnlyGroupRows',
  'mrWmsFetchExactInventoryGroupRows',
  'mrWmsMergeUniqueRows',
  'mrWmsGroupInventoryRows',
  'mrWmsSearchGroups',
  'mrWmsStageGroup',
  'mrWmsFetchStaronemallObserved',
  'mrWmsUpdateSourceObserved',
  'mrWmsLoadStaronemallForGroup',
  'mrRenderWmsStaronemallEnrichment',
  'mrWmsMergeObservedIntoGroup',
  'mrWmsDuplicateSignals',
  "db.rpc('stage_wms_inventory_payload'",
  'p_observed: null',
  '_skuLocked',
  'mrSetLifecycleValue',
  'mrGroupLifecycle',
  '_qoo10_available_date_type',
  'qoo10_release_date',
  '_staronemall_url',
  'Duplicate warning must be confirmed before registration.',
  'Staronemall URL is already used by master SKU',
  "group_mode: groupMode",
  "addRowToGroup(row, key, matchedGroup?.group_mode || 'barcode'",
  "row.bundle_count ? `${Number(row.bundle_count || 0).toLocaleString()} SET`",
  "params.set('barcode', `eq.${group.barcode}`)",
  'inventory: Number(row._inventory_quantity',
  '_wms_bundle_components',
  '_wms_is_bundle',
]) {
  assert(html.includes(token), `WMS master import UI/flow missing token: ${token}`);
}

for (const token of [
  'row._extra_images = detailImages.slice();',
  'row._detail_image_urls = detailImages;',
  'row.sourcing_price = observedPrice;',
  'row._sourcing_price = observedPrice;',
  'row.cost_krw = rshSettlementFromSourcing(observedPrice);',
  'row._cost_krw = row.cost_krw;',
]) {
  assert(html.includes(token), `WMS Staronemall enrichment merge missing token: ${token}`);
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
assert(
  html.includes("const groupMode = barcode ? 'barcode' : 'idol_album'")
    && html.includes("const key = barcode ? `barcode|${barcode}`"),
  'WMS search results must group inventory rows by barcode before falling back to idol+album',
);
assert(
  html.includes('const regularRows = (rows || []).filter(row => !mrWmsIsBundleRow(row));')
    && html.includes('const bundleRows = (rows || []).filter(row => mrWmsIsBundleRow(row));')
    && html.includes('mrWmsBundleComponentSkus(row)')
    && html.includes('skuToGroupKey.get(componentSku)'),
  'WMS search must merge WMS SET rows into their component barcode groups',
);
assert(
  html.includes('const bundleRows = await mrWmsFetchBundleRowsForBarcodeGroup(group, rows);')
    && html.includes('mrWmsMergeUniqueRows(rows.concat(bundleRows))'),
  'WMS preview loading must re-fetch SET rows linked to a barcode component group',
);
assert(
  !html.includes('Platform preflight blockers')
    && !html.includes('mrRenderWmsPreflight')
    && !html.includes('Joom: no shipping rule override needed.'),
  'WMS master preview should not show platform preflight notes as product data',
);
assert(
  html.includes('mrWmsSetAggregateForRow')
    && html.includes('mrWmsApplySetAggregates')
    && html.includes('mrWmsBundleComponentQuantity')
    && html.includes('_weightTouched'),
  'WMS SET preview must include explicit bundle aggregate helpers',
);
assert(
  !html.includes('disabled: isWmsSetRow'),
  'WMS SET purchase/settlement/weight inputs must stay editable after aggregate defaults are applied',
);

{
  const helperNames = [
    'mrWmsCostCandidate',
    'mrWmsBundleComponents',
    'mrWmsIsBundleRow',
    'mrWmsBundleComponentSkus',
    'mrWmsBundleComponentQuantity',
    'mrWmsBundleComponentQuantities',
    'mrWmsPositiveNumber',
    'mrWmsCurrentSourcing',
    'mrWmsCurrentCost',
    'mrWmsCurrentWeight',
    'mrWmsSetAggregateForRow',
    'mrWmsApplySetAggregates',
    'mrWmsInventorySort',
    'mrWmsMergeUniqueRows',
  ];
  const helperSource = helperNames.map((name) => extractFunction(html, name)).join('\n');
  const helpers = Function(`${helperSource}; return { ${helperNames.join(', ')} };`)();
  const rows = [
    { id: 'set', sku: 'M4-AAA-SET', version: '2 VER SET', member: '', cost_krw: 999, weight_g: 1, bundle_components: [{ sku: 'M4-AAA-A' }, { sku: 'M4-AAA-B', quantity: 2 }] },
    { id: 'a', sku: 'M4-AAA-A', version: 'A', member: '', _sourcing_price: 1000, _cost_krw: 1300, _weight_g: 100 },
    { id: 'b', sku: 'M4-AAA-B', version: 'B', member: '', _sourcing_price: 1500, _cost_krw: 1800, _weight_g: 120 },
  ];
  const sortedSkus = helpers.mrWmsMergeUniqueRows(rows).map((row) => row.sku);
  assertModule.deepEqual(sortedSkus, ['M4-AAA-A', 'M4-AAA-B', 'M4-AAA-SET'], 'WMS inventory sorting must keep SET rows last');
  const aggregate = helpers.mrWmsSetAggregateForRow(rows[0], rows);
  assertModule.deepEqual(
    {
      complete: aggregate.complete,
      component_count: aggregate.component_count,
      sourcing_price: aggregate.sourcing_price,
      cost_krw: aggregate.cost_krw,
      weight_g: aggregate.weight_g,
    },
    { complete: true, component_count: 3, sourcing_price: 4000, cost_krw: 4900, weight_g: 340 },
    'WMS SET aggregate must multiply component quantities and sum purchase price, settlement price, and weight',
  );
  helpers.mrWmsApplySetAggregates(rows);
  assertModule.equal(rows[0]._sourcing_price, 4000, 'SET purchase price must be written back to preview row');
  assertModule.equal(rows[0]._cost_krw, 4900, 'SET settlement price must be written back to preview row');
  assertModule.equal(rows[0]._weight_g, 340, 'SET weight must be written back to preview row');
  rows[0]._sourcingTouched = true;
  rows[0].sourcing_price = 4100;
  rows[0]._sourcing_price = 4100;
  rows[0]._costTouched = true;
  rows[0].cost_krw = 5200;
  rows[0]._cost_krw = 5200;
  rows[0]._weightTouched = true;
  rows[0].weight_g = 365;
  rows[0]._weight_g = 365;
  helpers.mrWmsApplySetAggregates(rows);
  assertModule.equal(rows[0]._sourcing_price, 4100, 'SET purchase price manual override must not be overwritten by aggregate refresh');
  assertModule.equal(rows[0]._cost_krw, 5200, 'SET settlement price manual override must not be overwritten by aggregate refresh');
  assertModule.equal(rows[0]._weight_g, 365, 'SET weight manual override must not be overwritten by aggregate refresh');
}

for (const token of [
  "'wms_inventory'",
  'create or replace function public.search_wms_inventory_groups',
  'create or replace function public.stage_wms_inventory_group',
  'create or replace function public.stage_wms_inventory_payload',
  'p_observed jsonb default null',
  'wms_observed_object_required',
  'staronemall_url',
  'source_detail',
  "'grouping_key'",
  "'wms_inventory:barcode:'",
  "'wms://inventory/barcode/'",
  'linked_master_product_id uuid',
  'idx_inventory_wms_master_search_trgm',
  'source_records_source_type_check',
  'source_type, source_external_id, parser_version',
  'create or replace function public.update_wms_source_observed',
  'source_record_not_wms_inventory',
  'wms_preview_staronemall_enrichment',
  'bundle_components jsonb',
  "'bundle_variant_count'",
  'grant execute on function public.search_wms_inventory_groups',
  'grant execute on function public.stage_wms_inventory_group',
  'grant execute on function public.stage_wms_inventory_payload(jsonb, jsonb)',
  'grant execute on function public.update_wms_source_observed(uuid, jsonb)',
]) {
  assert(migration.includes(token), `WMS master import migration missing token: ${token}`);
}

for (const token of [
  'create or replace function public.update_wms_source_observed',
  'confidence = greatest(coalesce(v_source.confidence, 0), 95)',
  "when v_source.status in ('rejected', 'superseded') then 'pending_review'",
  'else v_source.status',
  'public.source_records.status',
]) {
  assert(statusFixMigration.includes(token), `WMS observed status fix migration missing token: ${token}`);
}

for (const token of [
  "jsonb_typeof(i.raw_bundle_components) = 'array'",
  "else '[]'::jsonb",
  "jsonb_typeof(r -> 'bundle_components') = 'array'",
  "jsonb_typeof(p_observed -> 'main_image_urls') = 'array'",
  "jsonb_typeof(v_source.observed_values -> 'main_image_urls') = 'array'",
  "jsonb_typeof(v_source.observed_values -> 'detail_image_urls') = 'array'",
  'grant execute on function public.stage_wms_inventory_payload(jsonb, jsonb) to authenticated',
  'grant execute on function public.update_wms_source_observed(uuid, jsonb) to authenticated',
]) {
  assert(arrayGuardMigration.includes(token), `WMS JSONB array guard migration missing token: ${token}`);
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
