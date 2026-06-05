import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '202606050001_v2_reject_source_record_rpc.sql'),
  'utf8',
);

assert.match(html, /id="mr-input-select-all"/, 'URL bulk input table must expose a stage-1 select-all checkbox');
assert.match(html, /dataset:\s*\{\s*mrRowSelect:/, 'each URL bulk input row must render a selectable checkbox');
assert.match(html, /function mrStage1RowSelected\(/, 'URL bulk input rows must track selected state');
assert.match(html, /mrCollectStage1Rows\(\{\s*selectedOnly:\s*true\s*\}\)/, 'preview must use selected URL rows only');
assert.match(html, /선택된 URL이 없습니다/, 'preview must explain when all URL rows are unchecked');
assert.match(html, /MR_DISMISSED_URLS/, 'dismissal must also remember source URLs for pending prefill filtering');
assert.match(html, /function mrDismissGroup\(/, 'preview card exclusion must persist a dismissed source group');
assert.match(html, /db\.rpc\('reject_source_record'/, 'dismissal must call the reject_source_record RPC when available');
assert.match(html, /mrDropInputRowsForGroup\(group\)/, 'preview card exclusion must also remove matching stage-1 input rows');

assert.match(migration, /create or replace function public\.reject_source_record\(/, 'migration must create reject_source_record RPC');
assert.match(migration, /status = 'rejected'/, 'reject_source_record must move source_records out of pending_review');
assert.match(migration, /grant execute on function public\.reject_source_record\(uuid, text\) to authenticated/, 'authenticated operators must be allowed to reject source records');

console.log('V2 URL bulk selection/dismiss static checks passed');
