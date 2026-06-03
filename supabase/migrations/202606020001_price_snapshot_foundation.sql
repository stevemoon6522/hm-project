-- Price snapshot foundation.
--
-- Current price cache columns are kept for UI speed, but every important price
-- calculation/update now has a place to leave append-only evidence.

create table if not exists public.price_batches (
  id uuid primary key default gen_random_uuid(),
  batch_type text not null check (batch_type in ('dry_run', 'apply', 'rollback')),
  status text not null default 'draft'
    check (status in ('draft', 'ready', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  trigger_source text not null default 'manual'
    check (trigger_source in ('manual', 'cost_change', 'fx_change', 'fee_change', 'scheduled', 'rollback')),
  actor text not null default 'operator',
  reason text,
  dry_run boolean not null default true,
  platform_filter text[] not null default array[]::text[],
  summary_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

comment on table public.price_batches is
  'Groups dry-run, live apply, and rollback price operations.';

create table if not exists public.price_snapshots (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.price_batches(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  platform_listing_id uuid references public.platform_listings(id) on delete set null,
  rollback_source_snapshot_id uuid references public.price_snapshots(id) on delete set null,

  platform text not null check (platform in ('shopee', 'joom', 'qoo10', 'ebay')),
  region text,
  country text,
  shop_id text,
  sku text not null,

  currency text not null,
  cost_krw numeric,
  weight_g numeric,
  exchange_rate numeric,
  fee_model jsonb not null default '{}'::jsonb,
  formula_key text,
  rule_version text,
  rounding_rule text,

  previous_platform_price numeric,
  computed_platform_price numeric not null,
  final_platform_price numeric not null,
  margin_krw numeric,
  margin_pct numeric,

  guardrail_status text not null default 'pass'
    check (guardrail_status in ('pass', 'ignore_log', 'approval_required', 'blocked', 'error')),
  guardrail_reasons text[] not null default array[]::text[],

  snapshot_status text not null default 'computed'
    check (snapshot_status in ('computed', 'approved', 'sent', 'applied', 'failed', 'rolled_back', 'skipped')),
  remote_before jsonb not null default '{}'::jsonb,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  error_code text,
  error_msg text,

  created_at timestamptz not null default now(),
  approved_at timestamptz,
  sent_at timestamptz,
  applied_at timestamptz
);

comment on table public.price_snapshots is
  'Append-only per-SKU/platform price calculation and platform update evidence.';

create index if not exists price_snapshots_product_created_idx
  on public.price_snapshots (product_id, created_at desc);

create index if not exists price_snapshots_platform_sku_idx
  on public.price_snapshots (platform, sku, created_at desc);

create index if not exists price_snapshots_batch_idx
  on public.price_snapshots (batch_id, snapshot_status);

create index if not exists price_snapshots_platform_listing_idx
  on public.price_snapshots (platform_listing_id, created_at desc)
  where platform_listing_id is not null;

alter table public.price_batches enable row level security;
alter table public.price_snapshots enable row level security;

drop policy if exists "price_batches readable by authenticated" on public.price_batches;
create policy "price_batches readable by authenticated"
  on public.price_batches for select
  to public
  using (auth.role() = 'authenticated');

drop policy if exists "price_snapshots readable by authenticated" on public.price_snapshots;
create policy "price_snapshots readable by authenticated"
  on public.price_snapshots for select
  to public
  using (auth.role() = 'authenticated');

grant select on public.price_batches to authenticated;
grant select on public.price_snapshots to authenticated;

alter table public.audit_log
  add column if not exists price_snapshot_id uuid references public.price_snapshots(id) on delete set null;

create index if not exists audit_log_price_snapshot_idx
  on public.audit_log (price_snapshot_id, created_at desc)
  where price_snapshot_id is not null;
