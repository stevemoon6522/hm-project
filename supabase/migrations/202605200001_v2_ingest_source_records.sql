-- Step 1a (plan v2.2 §B.1): source_records — raw ingest layer.
--
-- Every successful crawl (Yes24 / Weverse / StarOneMall / manual / csv_import)
-- lands ONE row here BEFORE it can be promoted to the master `products` table.
-- The promotion (status='pending_review' → 'approved' → 'published') is the
-- operator approval flow built in Step 1c.
--
-- Codex review fix #4 (plan v2.2 review): no global unique on raw_payload_hash
-- (would block legitimate re-crawls when site returns identical bytes). Dedupe
-- is by (source_type, source_external_id, parser_version) instead, plus a
-- crawl_run_id column groups records from one crawl invocation.

create table if not exists public.source_records (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in (
    'yes24', 'weverse', 'staronemall', 'manual', 'csv_import'
  )),
  source_external_id text,
  source_url text not null,
  crawl_run_id uuid not null,
  fetched_at timestamptz not null default now(),
  parser_version text not null,
  raw_payload jsonb not null,
  raw_payload_hash text not null,
  observed_values jsonb not null,
  confidence smallint not null default 50 check (confidence between 0 and 100),
  tier smallint not null default 2 check (tier in (1, 2, 3)),
  status text not null default 'pending_review' check (status in (
    'pending_review', 'approved', 'rejected', 'published', 'superseded'
  )),
  linked_master_product_id uuid references public.products(id) on delete set null,
  review_notes text,
  reviewed_at timestamptz,
  reviewed_by text,
  created_at timestamptz not null default now()
);

create unique index if not exists source_records_external_uniq
  on public.source_records (source_type, source_external_id, parser_version)
  where source_external_id is not null;

create index if not exists source_records_status_fetched_idx
  on public.source_records (status, fetched_at desc);

create index if not exists source_records_linked_master_idx
  on public.source_records (linked_master_product_id)
  where linked_master_product_id is not null;

create index if not exists source_records_crawl_run_idx
  on public.source_records (crawl_run_id);

-- RLS: any insert/update goes through service-role keyed Edge Functions (ingest,
-- starone-crawl, yes24-crawl). Direct anon access is blocked. Authenticated
-- operators can read (so the V2 SPA "수집 검토" tab works under JWT auth).
alter table public.source_records enable row level security;

create policy "source_records readable by authenticated"
  on public.source_records for select
  to public
  using (auth.role() = 'authenticated');

-- No INSERT / UPDATE / DELETE policies → only service_role bypasses RLS.
