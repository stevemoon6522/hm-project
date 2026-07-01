import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const migration = readFileSync(join(root, 'supabase', 'migrations', '202606200001_b2b_catalog_items.sql'), 'utf8');
const deleteMigration = readFileSync(join(root, 'supabase', 'migrations', '202606210001_catalog_items_delete_policy.sql'), 'utf8');
const wmsMatchMigration = readFileSync(join(root, 'supabase', 'migrations', '202607010002_b2b_catalog_wms_match.sql'), 'utf8');
const crawler = readFileSync(join(root, 'supabase', 'functions', 'starone-crawl', 'index.ts'), 'utf8');
const api = readFileSync(join(root, 'api', 'b2b-catalog-sheet-sync.js'), 'utf8');

for (const token of [
  'create table if not exists public.catalog_items',
  'artist text not null',
  'release_title text not null',
  'edition text not null',
  "category in ('Album', 'Photocard', 'MD')",
  "availability_status in ('Available', 'Restock Watch', 'Inquiry Only')",
  'staronemall_url text not null',
  'staronemall_pno text not null',
  'catalog_items_source_option_uniq',
  'alter table public.catalog_items enable row level security',
  'catalog_items readable by authenticated',
  'catalog_items writable by authenticated',
  'catalog_items updatable by authenticated',
  'grant select, insert, update on public.catalog_items to authenticated',
]) {
  assert(migration.includes(token), `catalog_items migration missing token: ${token}`);
}

for (const token of [
  'catalog_items deletable by authenticated',
  'on public.catalog_items for delete',
  'grant delete on public.catalog_items to authenticated',
]) {
  assert(deleteMigration.includes(token), `catalog_items delete migration missing token: ${token}`);
}

for (const token of [
  'alter table public.catalog_items',
  'add column if not exists wms_inventory_id bigint',
  'add column if not exists wms_sku text',
  'add column if not exists wms_matched_at timestamptz',
  'catalog_items_wms_inventory_idx',
]) {
  assert(wmsMatchMigration.includes(token), `catalog_items WMS match migration missing token: ${token}`);
}

for (const token of [
  'keyword?: string',
  'function discoveryBaseUrl',
  '/shop/search_result.php',
  'search_str',
  'writeToSourceRecords',
  'preview_only: true',
  '{ writeToSourceRecords }',
]) {
  assert(crawler.includes(token), `StarOneMall keyword discovery missing token: ${token}`);
}

assert.match(
  crawler,
  /if \(!writeToSourceRecords\)[\s\S]*preview_only: true[\s\S]*continue;[\s\S]*const existingProduct = await supabase/,
  'preview-only discovery must return candidates before source_records/products dedupe',
);

for (const token of [
  "const PUBLIC_HEADERS = ['Image', 'Artist', 'Release Title', 'Edition', 'Category', 'Availability', 'Retail Price', 'Supply Note']",
  "const PUBLIC_TABS = ['Catalog']",
  "const DEPRECATED_PUBLIC_TABS = ['Restock Watch', 'Inquiry Only']",
  "const INTERNAL_TAB = 'Internal Coverage'",
  'const MANAGED_TABS = new Set([...PUBLIC_TABS, INTERNAL_TAB])',
  'hidden: title === INTERNAL_TAB',
  'updateSheetProperties',
  '(!MANAGED_TABS.has(title) || DEPRECATED_PUBLIC_TABS.includes(title)) && properties.hidden !== true',
  '=IMAGE("',
  'Staronemall PNO',
  'Staronemall URL',
  'WMS SKU',
  'WMS Inventory ID',
  'wms_inventory_id,wms_sku,wms_matched_at',
  "if (item.wms_sku || item.wms_inventory_id) return 'Linked';",
  'requireUser(req)',
  "const SHEET_SYNC_DIRECTION = 'DB_TO_GOOGLE_SHEET'",
  "const SHEET_AUTH_MODE = 'GOOGLE_SERVICE_ACCOUNT_JSON'",
  'function sheetSyncMetadata',
  'spreadsheet_url: spreadsheetUrl(spreadsheetId)',
  'column_mapping: COLUMN_MAPPING',
]) {
  assert(api.includes(token), `B2B sheet sync API missing token: ${token}`);
}

const publicHeadersLine = api.match(/const PUBLIC_HEADERS = \[[^\n]+\]/)?.[0] || '';
assert(!publicHeadersLine.includes('Staronemall'), 'public buyer headers must not expose StarOneMall URL or pno');
assert(
  /Catalog:\s*\[\s*PUBLIC_HEADERS,\s*\.\.\.coverageRows\.map\(publicRow\),\s*\]/.test(api),
  'Catalog tab must contain every B2B row and rely on the Availability column/filter instead of splitting public tabs',
);
assert(
  !api.includes("coverageRows.filter((row) => row.availability_status === 'Available').map(publicRow)"),
  'Catalog tab must not filter out Restock Watch or Inquiry Only rows',
);
assert(
  api.includes('DEPRECATED_PUBLIC_TABS') && api.includes('MANAGED_TABS.has(title) || DEPRECATED_PUBLIC_TABS.includes(title)'),
  'Deprecated public tabs should be hidden when syncing the fixed Sheet',
);

for (const token of [
  "showView('view-b2b-catalog')",
  'id="view-b2b-catalog"',
  'id="b2b-artist-keyword"',
  'id="b2b-crawl-staronemall"',
  'id="b2b-save-selected"',
  'id="b2b-sync-sheet"',
  'id="b2b-open-sheet"',
  'single Catalog sheet with Availability filter',
  'id="b2b-sync-selected-master"',
  'id="b2b-bulk-edit"',
  'id="b2b-bulk-delete"',
  'id="b2b-conflict-modal"',
  'id="b2b-catalog-edit-modal"',
  'id="b2b-catalog-bulk-modal"',
  'id="b2b-wms-match-modal"',
  'id="b2b-catalog-check-all"',
  'data-b2b-edit',
  'data-b2b-delete',
  'data-b2b-wms-match',
  'data-b2b-wms-match-select',
  'data-b2b-bulk-apply',
  'const B2B_CATEGORIES',
  'const B2B_AVAILABILITY',
  'function b2bCrawlStaronemall',
  'write_to_source_records: false',
  'function b2bSaveSelectedRows',
  ".from('catalog_items')",
  ".in('staronemall_pno', pnos)",
  'function b2bOpenCatalogEditModal',
  'function b2bSaveCatalogEdit',
  'function b2bOpenBulkEditModal',
  'function b2bApplyBulkEdit',
  'function b2bDeleteCatalogRows',
  'function b2bSyncSelectedMasterMatches',
  'function b2bProductPnoFilter',
  '.or(filters.join(\',\'))',
  'b2bFetchProductsPnos(b2bCatalogPnos(b2bCatalogState.catalogRows))',
  'function b2bConfirmConflictOverwrite',
  'function renderB2bCatalogView',
  'function b2bMasterStatus',
  'function b2bWmsStatus',
  'function b2bWmsCandidates',
  'function b2bOpenWmsMatchModal',
  'function b2bSaveWmsMatch',
  'function b2bClearWmsMatch',
  'wms_inventory_id,wms_sku,wms_matched_at',
  "row.wms_sku || row.wms_inventory_id",
  "if (viewId === 'view-b2b-catalog') renderB2bCatalogView(false)",
]) {
  assert(html.includes(token), `V2 B2B catalog UI missing token: ${token}`);
}

assert(
  html.includes("const tabs = Array.isArray(body.visible_tabs) ? body.visible_tabs.join(', ') : 'Catalog';"),
  'B2B sync status fallback should name only the single public Catalog tab',
);
assert(
  !html.includes("'Catalog, Restock Watch, Inquiry Only'"),
  'B2B UI must not present deprecated Restock Watch / Inquiry Only tabs as public tabs',
);

assert(
  !/b2bEl\('b2b-catalog-edit-modal'\)\?\.addEventListener\('click'/.test(html),
  'B2B catalog edit modal must not close when the backdrop is clicked',
);

for (const forbidden of [
  "b2bEl('b2b-catalog-bulk-modal')?.addEventListener('click'",
  "b2bEl('b2b-conflict-modal')?.addEventListener('click'",
]) {
  assert(!html.includes(forbidden), `B2B modal backdrop close handler must not exist: ${forbidden}`);
}

for (const token of [
  "b2bEl('b2b-catalog-edit-close')?.addEventListener('click', b2bCloseCatalogEditModal)",
  "b2bEl('b2b-catalog-edit-cancel')?.addEventListener('click', b2bCloseCatalogEditModal)",
  "b2bEl('b2b-catalog-bulk-close')?.addEventListener('click', b2bCloseBulkEditModal)",
  "b2bEl('b2b-catalog-bulk-cancel')?.addEventListener('click', b2bCloseBulkEditModal)",
  "b2bEl('b2b-conflict-close')?.addEventListener('click', b2bCloseConflictModal)",
  "b2bEl('b2b-conflict-cancel')?.addEventListener('click', b2bCloseConflictModal)",
  "b2bEl('b2b-wms-match-close')?.addEventListener('click', b2bCloseWmsMatchModal)",
  "b2bEl('b2b-wms-match-cancel')?.addEventListener('click', b2bCloseWmsMatchModal)",
  "b2bEl('b2b-wms-match-clear')?.addEventListener('click', b2bClearWmsMatch)",
]) {
  assert(html.includes(token), `B2B modal close behavior regression missing token: ${token}`);
}

console.log('v2 B2B catalog static checks passed');
