import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../supabase/migrations/202605300002_absorb_lookup_clears_errors.sql', import.meta.url), 'utf8');

assert.match(migration, /create or replace function public\.absorb_platform_sku_lookup/, 'migration must replace absorb_platform_sku_lookup');
assert.match(migration, /error_msg = null/, 'successful absorb update must clear stale error_msg');
assert.match(migration, /error_code = null/, 'successful absorb update must clear stale error_code');
assert.match(migration, /error_msg,\s*\n\s*error_code/, 'insert path must include error fields');
assert.match(migration, /null,\s*\n\s*null\s*\n\s*\) returning id into v_id/, 'insert path must initialize error fields to null');

console.log('absorb lookup clear-error migration checks passed');
