import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const migrationSql = readdirSync(join(root, 'supabase', 'migrations'))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(join(root, 'supabase', 'migrations', name), 'utf8'))
  .join('\n');

function sliceBetween(source, start, end) {
  const s = source.indexOf(start);
  assert.notEqual(s, -1, `missing start token: ${start}`);
  const e = source.indexOf(end, s);
  assert.ok(e > s, `missing end token after ${start}`);
  return source.slice(s, e);
}

const optionRender = sliceBetween(
  html,
  'function plMasterEditRenderOptions',
  'function plMasterEditRowsFromModal',
);
const optionBinding = sliceBetween(
  html,
  'function plMasterEditBindOptionMutationControls',
  'async function openProductMasterEditModal',
);
const optionPatchReader = sliceBetween(
  html,
  'function plMasterEditReadOptionPatches(rows)',
  'async function saveProductMasterEditModal',
);
const saveFlow = sliceBetween(
  html,
  'async function saveProductMasterEditModal',
  'function beginEditCell',
);

for (const token of [
  'data-master-option-add',
  'data-master-option-delete',
  'data-master-option-restore',
  'data-option-row-status',
  'data-client-id',
]) {
  assert.match(optionRender, new RegExp(token), `master edit option table must render ${token}`);
}

for (const token of [
  'plMasterEditAddDraftOption',
  'plMasterEditToggleDraftOptionDelete',
  'plMasterEditNextClientId',
  'plMasterEditOptionRowPayload',
]) {
  assert.match(html, new RegExp(token), `master edit option mutation helper missing: ${token}`);
}

for (const token of [
  "'insert'",
  "'update'",
  "action: 'delete'",
  'client_id',
  'deletedOptionIds',
  'returnedIds',
  ".in\\('id', returnedIds\\)",
]) {
  assert.match(optionPatchReader + saveFlow, new RegExp(token), `save payload must include ${token}`);
}

for (const token of [
  'plMasterEditBindOptionMutationControls',
  'data-master-option-add',
  'data-master-option-delete',
  'data-master-option-restore',
]) {
  assert.match(optionBinding + saveFlow, new RegExp(token), `option mutation binding missing: ${token}`);
}

for (const token of [
  "item ->> 'action'",
  "action = 'insert'",
  "action = 'delete'",
  'insert into public.products',
  'delete from public.products',
  "sourcing_price = case when oi.patch ? 'sourcing_price'",
  'client_id text',
]) {
  assert.match(migrationSql, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `RPC migration must support ${token}`);
}

console.log('v2 master edit option mutation checks passed');
