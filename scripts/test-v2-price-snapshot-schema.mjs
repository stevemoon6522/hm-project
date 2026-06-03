import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '202606020001_price_snapshot_foundation.sql'),
  'utf8',
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const token of [
  'create table if not exists public.price_batches',
  'create table if not exists public.price_snapshots',
  "batch_type in ('dry_run', 'apply', 'rollback')",
  "status in ('draft', 'ready', 'running', 'completed', 'partial', 'failed', 'cancelled')",
  "trigger_source in ('manual', 'cost_change', 'fx_change', 'fee_change', 'scheduled', 'rollback')",
  'batch_id uuid references public.price_batches(id) on delete set null',
  'product_id uuid references public.products(id) on delete set null',
  'platform_listing_id uuid references public.platform_listings(id) on delete set null',
  'rollback_source_snapshot_id uuid references public.price_snapshots(id) on delete set null',
  "platform in ('shopee', 'joom', 'qoo10', 'ebay')",
  "guardrail_status in ('pass', 'ignore_log', 'approval_required', 'blocked', 'error')",
  "snapshot_status in ('computed', 'approved', 'sent', 'applied', 'failed', 'rolled_back', 'skipped')",
  'price_snapshots_product_created_idx',
  'price_snapshots_platform_sku_idx',
  'price_snapshots_batch_idx',
  'alter table public.price_batches enable row level security',
  'alter table public.price_snapshots enable row level security',
  'price_batches readable by authenticated',
  'price_snapshots readable by authenticated',
  'grant select on public.price_batches to authenticated',
  'grant select on public.price_snapshots to authenticated',
  'add column if not exists price_snapshot_id uuid references public.price_snapshots(id) on delete set null',
  'audit_log_price_snapshot_idx',
]) {
  assert(migration.includes(token), `price snapshot migration must include: ${token}`);
}

assert(!migration.includes("'alibaba'"), 'price snapshots must not include unsupported Alibaba platform');
assert(!/for\s+(insert|update|delete)/i.test(migration), 'price snapshot tables must not expose browser write policies');

console.log('v2 price snapshot schema checks passed');
