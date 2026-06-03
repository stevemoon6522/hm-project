import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '202606020002_price_snapshot_dry_run_rpc.sql'),
  'utf8',
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const token of [
  'create or replace function public.record_price_dry_run_batch',
  'security definer',
  "p_snapshots must be a JSON array",
  'too many price snapshots in one batch',
  "batch_type,\n    status,\n    trigger_source",
  "'dry_run',\n    'completed',\n    'manual'",
  "v_platform not in ('shopee', 'joom', 'qoo10', 'ebay')",
  'insert into public.price_snapshots',
  'computed_platform_price',
  'final_platform_price',
  'guardrail_reasons',
  'insert into public.audit_log',
  "'price_snapshot'",
  'price_snapshot_id',
  'revoke all on function public.record_price_dry_run_batch',
  'grant execute on function public.record_price_dry_run_batch',
  'to authenticated',
]) {
  assert(migration.includes(token), `price snapshot RPC migration must include: ${token}`);
}

assert(!migration.includes("'alibaba'"), 'dry-run snapshot RPC must not accept Alibaba');
assert(!migration.includes('grant insert on public.price_snapshots'), 'RPC migration must not grant direct table inserts');
assert(!migration.includes('create policy') || !/for\s+insert/i.test(migration), 'RPC migration must not create browser insert policies');

console.log('v2 price snapshot RPC checks passed');
