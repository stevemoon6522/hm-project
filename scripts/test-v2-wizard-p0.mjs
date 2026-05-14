import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const bridgePaths = [
  'supabase/functions/shopee-bridge/index.ts',
  'edge-functions/shopee-bridge/index.ts',
];
const migrationPath = 'supabase/migrations/202605120001_v2_wizard_p0_controls.sql';
const planPath = 'plans/v2-wizard-plan.md';

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const migration = read(migrationPath);
assert(/where\s+status\s*=\s*'ok'/i.test(migration), 'idempotency unique index must be scoped to status=ok');
assert(!/where\s+status\s+in\s*\(\s*'ok'\s*,\s*'dry_run'\s*\)/i.test(migration), 'dry_run must not be part of the unique idempotency predicate');
assert(/drop\s+index\s+if\s+exists\s+uidx_shopee_mutation_log_idempotent/i.test(migration), 'migration must replace the previous idempotency index');
assert(/rollback_policy/i.test(migration), 'mutation log must expose rollback policy');
assert(/run_id/i.test(migration), 'mutation log must expose run_id for failed-run visibility');

for (const path of bridgePaths) {
  const source = read(path);
  assert(source.includes("const V2_ROLLBACK_POLICY = 'no_auto_rollback_resume_only'"), `${path}: missing no-rollback resume policy`);
  assert(source.includes("const V2_DEGRADED_APPROVAL = 'APPROVE_V2_DEGRADED_MUTATION'"), `${path}: missing explicit degraded approval token`);
  assert(source.includes('forceRefreshForMutation(region, action)'), `${path}: real mutations must force-refresh token before execution`);
  assert(source.includes("status: 'dry_run'"), `${path}: dry-run must log without live execution`);
  assert(source.includes(".eq('status', 'ok')"), `${path}: idempotency lookup must only consider ok rows`);
  assert(source.includes("action === 'v2_failed_mutations'"), `${path}: missing failed mutation visibility endpoint`);
  assert(source.includes("action === 'v2_resume_failed'"), `${path}: missing failed mutation resume endpoint`);
  assert(source.includes("error: 'v2_probe_preflight_blocked'"), `${path}: missing hard-blocking preflight error`);
  assert(source.includes('approved_blocked_fields'), `${path}: missing explicit degraded approval field list`);
}

const plan = read(planPath);
assert(plan.includes('P0 implementation note'), 'plan must document P0 implementation choices');
assert(plan.includes('no_auto_rollback_resume_only'), 'plan must document selected rollback policy');

console.log('v2 wizard P0 static checks passed');
