create extension if not exists pgcrypto with schema extensions;

create table if not exists public.shopee_sku_change_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  idempotency_key text not null,
  status text not null default 'preparing',
  source text not null default 'api',
  created_by text,
  requested_regions text[] not null default '{}',
  requested_shop_ids text[] not null default '{}',
  mapping_hash text,
  mapping_payload jsonb not null default '{}'::jsonb,
  dry_run_report jsonb not null default '{}'::jsonb,
  commit_summary jsonb not null default '{}'::jsonb,
  verify_summary jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  prepared_at timestamptz,
  commit_started_at timestamptz,
  committed_at timestamptz,
  verify_started_at timestamptz,
  verified_at timestamptz,
  constraint shopee_sku_change_jobs_status_chk check (
    status in (
      'preparing',
      'prepared',
      'invalid',
      'committing',
      'committed',
      'partial_failed',
      'verifying',
      'verified',
      'verify_failed',
      'cancelled'
    )
  ),
  constraint shopee_sku_change_jobs_idempotency_key_nonempty_chk check (btrim(idempotency_key) <> '')
);

create unique index if not exists shopee_sku_change_jobs_idempotency_key_uidx
  on public.shopee_sku_change_jobs (idempotency_key);

create index if not exists shopee_sku_change_jobs_status_idx
  on public.shopee_sku_change_jobs (status, created_at desc);

create index if not exists shopee_sku_change_jobs_mapping_hash_idx
  on public.shopee_sku_change_jobs (mapping_hash);

create table if not exists public.shopee_sku_change_items (
  id bigserial primary key,
  job_id uuid not null references public.shopee_sku_change_jobs(id) on delete cascade,
  client_ref text,
  region text not null,
  shop_id text not null,
  item_id bigint not null,
  model_id bigint,
  has_model boolean not null default false,
  sku_level text not null,
  item_status text,
  item_name text,
  old_sku text,
  new_sku text not null,
  status text not null default 'pending',
  validation_error text,
  api_path text,
  api_payload jsonb,
  api_response jsonb,
  request_id text,
  warning text,
  error_code text,
  error_message text,
  attempt_count integer not null default 0,
  committed_at timestamptz,
  verified_at timestamptz,
  verify_sku text,
  verify_match boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopee_sku_change_items_sku_level_chk check (sku_level in ('item', 'model')),
  constraint shopee_sku_change_items_status_chk check (
    status in (
      'pending',
      'committing',
      'committed',
      'failed',
      'verify_pending',
      'verified',
      'verify_failed',
      'skipped'
    )
  ),
  constraint shopee_sku_change_items_new_sku_chk check (char_length(btrim(new_sku)) between 1 and 100),
  constraint shopee_sku_change_items_model_shape_chk check (
    (sku_level = 'item' and model_id is null and has_model = false)
    or
    (sku_level = 'model' and model_id is not null and has_model = true)
  )
);

create unique index if not exists shopee_sku_change_items_target_uidx
  on public.shopee_sku_change_items (job_id, shop_id, item_id, coalesce(model_id, 0));

create index if not exists shopee_sku_change_items_job_status_idx
  on public.shopee_sku_change_items (job_id, status);

create index if not exists shopee_sku_change_items_shop_item_idx
  on public.shopee_sku_change_items (shop_id, item_id);

create index if not exists shopee_sku_change_items_request_id_idx
  on public.shopee_sku_change_items (request_id);

create table if not exists public.shopee_sku_snapshots (
  id bigserial primary key,
  job_id uuid not null references public.shopee_sku_change_jobs(id) on delete cascade,
  item_row_id bigint references public.shopee_sku_change_items(id) on delete set null,
  snapshot_phase text not null,
  region text not null,
  shop_id text not null,
  item_id bigint not null,
  model_id bigint,
  has_model boolean not null default false,
  sku_level text not null,
  sku text,
  target_sku text,
  item_status text,
  item_name text,
  raw jsonb not null default '{}'::jsonb,
  request_id text,
  captured_at timestamptz not null default now(),
  constraint shopee_sku_snapshots_phase_chk check (snapshot_phase in ('prepare', 'commit', 'verify')),
  constraint shopee_sku_snapshots_sku_level_chk check (sku_level in ('item', 'model'))
);

create index if not exists shopee_sku_snapshots_target_phase_idx
  on public.shopee_sku_snapshots (job_id, snapshot_phase, shop_id, item_id, coalesce(model_id, 0));

create index if not exists shopee_sku_snapshots_job_phase_idx
  on public.shopee_sku_snapshots (job_id, snapshot_phase, captured_at desc);

create index if not exists shopee_sku_snapshots_shop_item_idx
  on public.shopee_sku_snapshots (shop_id, item_id);

create or replace function public.shopee_sku_change_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists shopee_sku_change_jobs_touch_updated_at on public.shopee_sku_change_jobs;
create trigger shopee_sku_change_jobs_touch_updated_at
before update on public.shopee_sku_change_jobs
for each row execute function public.shopee_sku_change_touch_updated_at();

drop trigger if exists shopee_sku_change_items_touch_updated_at on public.shopee_sku_change_items;
create trigger shopee_sku_change_items_touch_updated_at
before update on public.shopee_sku_change_items
for each row execute function public.shopee_sku_change_touch_updated_at();
