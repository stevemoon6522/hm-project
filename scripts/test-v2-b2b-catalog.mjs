import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const migration = readFileSync(join(root, 'supabase', 'migrations', '202606200001_b2b_catalog_items.sql'), 'utf8');
const deleteMigration = readFileSync(join(root, 'supabase', 'migrations', '202606210001_catalog_items_delete_policy.sql'), 'utf8');
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
  "const PUBLIC_TABS = ['Catalog', 'Restock Watch', 'Inquiry Only']",
  "const INTERNAL_TAB = 'Internal Coverage'",
  'const MANAGED_TABS = new Set([...PUBLIC_TABS, INTERNAL_TAB])',
  'hidden: title === INTERNAL_TAB',
  'updateSheetProperties',
  '!MANAGED_TABS.has(title) && properties.hidden !== true',
  '=IMAGE("',
  'Staronemall PNO',
  'Staronemall URL',
  'requireUser(req)',
  'Authorization: `Bearer ${userToken}`',
]) {
  assert(api.includes(token), `B2B sheet sync API missing token: ${token}`);
}

const publicHeadersLine = api.match(/const PUBLIC_HEADERS = \[[^\n]+\]/)?.[0] || '';
assert(!publicHeadersLine.includes('Staronemall'), 'public buyer headers must not expose StarOneMall URL or pno');

for (const token of [
  "showView('view-b2b-catalog')",
  'id="view-b2b-catalog"',
  'id="b2b-artist-keyword"',
  'id="b2b-crawl-staronemall"',
  'id="b2b-save-selected"',
  'id="b2b-sync-sheet"',
  'id="b2b-sync-selected-master"',
  'id="b2b-bulk-edit"',
  'id="b2b-bulk-delete"',
  'id="b2b-conflict-modal"',
  'id="b2b-catalog-edit-modal"',
  'id="b2b-catalog-bulk-modal"',
  'id="b2b-catalog-check-all"',
  'data-b2b-edit',
  'data-b2b-delete',
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
  "if (viewId === 'view-b2b-catalog') renderB2bCatalogView(false)",
]) {
  assert(html.includes(token), `V2 B2B catalog UI missing token: ${token}`);
}

console.log('v2 B2B catalog static checks passed');
