import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '202606150001_custom_master_payload_stage.sql'),
  'utf8',
);

function sliceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `missing start token: ${start}`);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(endIndex > startIndex, `missing end token after ${start}`);
  return source.slice(startIndex, endIndex);
}

const registerView = sliceBetween(html, '<div id="view-register"', '</div><!-- /view-register -->');
const masterRegister = sliceBetween(
  html,
  '// MASTER REGISTER (view-register, 2-stage bulk URL+weight)',
  '// FEE / EXCHANGE-RATE SETTINGS',
);

assert.match(registerView, /data-register-workbench-target="custom"/, 'register method list must expose Custom Master');
assert.match(registerView, /data-register-workbench-panel="custom"/, 'register workbench must include the custom panel');
assert.match(registerView, /id="custom-master-cover-file"/, 'custom panel must require a representative image file');
assert.match(registerView, /id="custom-master-detail-files"[^>]*multiple/, 'custom panel must accept multiple detail images');
assert.match(registerView, /옵션 이미지 파일은 선택 사항입니다/, 'custom UI must say option images are optional');

assert.match(html, /data-master-register-open="custom"/, 'product list action bar must open custom registration');
assert.match(html, /target === 'custom' \? '커스텀 마스터 등록'/, 'master register panel title must handle custom');
assert.match(html, /window\.sdRegisterWorkbenchActivate\(\['url', 'custom', 'wms', 'retry'\]\.includes\(target\) \? target : 'global'\)/, 'panel opener must route custom target');

assert.match(masterRegister, /async function mrStageCustomMaster\(\)/, 'custom stage handler must exist');
assert.match(masterRegister, /dataset: \{ customOptionFile: '1' \}/, 'custom option rows must support option image files');
assert.match(masterRegister, /db\.rpc\('stage_custom_master_payload', \{ p_payload: payload \}\)/, 'custom stage must call the staging RPC');
assert.match(masterRegister, /source: 'custom_master'/, 'custom preview rows must be marked as custom source');
assert.match(masterRegister, /_staronemall_url: ''/, 'custom preview rows must not carry a StarOneMall URL');
assert.match(masterRegister, /_custom_option_image_url/, 'custom option images must be tracked separately');
assert.match(masterRegister, /row\._custom_option_image_url \|\| null/, 'custom option image URL must persist when present and clear when absent');
assert.match(masterRegister, /비우면 대표 이미지 사용/, 'custom option image fallback must use the representative image');
assert.match(masterRegister, /function mrIsCustomGroup\(group\)/, 'custom groups must be distinguishable');
assert.match(masterRegister, /if \(mrIsCustomGroup\(group\)\) return '';/, 'custom groups must not trigger StarOneMall image recrawl');

assert.match(migration, /create or replace function public\.stage_custom_master_payload/, 'migration must create custom staging RPC');
assert.match(migration, /'manual'/, 'custom source_records must use the existing manual source type');
assert.match(migration, /custom:\/\/master\//, 'custom source_records must use a synthetic non-StarOneMall URL');
assert.doesNotMatch(migration, /source_records_source_type_check/, 'migration must not rewrite the source_type constraint');
assert.doesNotMatch(migration, /check\s*\(\s*source_type\s+in[\s\S]*custom_master/i, 'migration must not require a new source_type constraint value');
assert.match(migration, /grant execute on function public\.stage_custom_master_payload\(jsonb\) to authenticated/, 'authenticated operators need execute grant');

console.log('v2 custom master register checks passed');
