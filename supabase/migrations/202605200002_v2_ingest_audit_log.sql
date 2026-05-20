-- Step 1a (plan v2.2 §B.4): audit_log — append-only trail of every mutation
-- across the V2 ingest + publish pipeline.
--
-- Codex review fix #6 (plan v2.2 review): typed FK columns instead of just
-- `entity_id text`. entity_uuid is the canonical pointer; the nullable typed
-- FKs (source_record_id / variant_id / platform_listing_id / product_id /
-- price_snapshot_id) make joins safe and let ON DELETE behave sensibly.
--
-- Tables variants / platform_listings / price_snapshots land in Step 1c, so
-- the FK constraints to them are added in a later migration (no forward
-- references for now). Same for shopee_mutation_log if needed.

create table if not exists public.audit_log (
  id bigserial primary key,
  entity_type text not null check (entity_type in (
    'source_record', 'variant', 'platform_listing', 'product',
    'price_snapshot'
  )),
  entity_uuid uuid not null,
  source_record_id uuid references public.source_records(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  -- variant_id / platform_listing_id / price_snapshot_id added in Step 1c
  actor text not null,
  action text not null check (action in (
    'create', 'update', 'approve', 'reject', 'publish', 'rollback',
    'sync', 'alert_sent'
  )),
  before_json jsonb,
  after_json jsonb,
  reason text,
  batch_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_entity_idx
  on public.audit_log (entity_type, entity_uuid, created_at desc);

create index if not exists audit_log_created_idx
  on public.audit_log (created_at desc);

alter table public.audit_log enable row level security;

-- Operators may read for transparency; mutating happens only via
-- service-role keyed Edge Functions.
create policy "audit_log readable by authenticated"
  on public.audit_log for select
  to public
  using (auth.role() = 'authenticated');
