create table if not exists shopee_mutation_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  actor text not null,
  action text not null,
  region text,
  target_global_item_id bigint,
  target_global_model_id bigint,
  target_shop_item_id bigint,
  payload_hash text not null,
  before_payload jsonb,
  after_payload jsonb,
  request_payload jsonb,
  response jsonb,
  status text not null,
  error_msg text,
  request_id text,
  duration_ms integer
);

alter table shopee_mutation_log add column if not exists run_id text;
alter table shopee_mutation_log add column if not exists operator_id text;
alter table shopee_mutation_log add column if not exists rollback_policy text;
alter table shopee_mutation_log add column if not exists actor text;
alter table shopee_mutation_log add column if not exists payload_hash text;
alter table shopee_mutation_log add column if not exists request_payload jsonb;
alter table shopee_mutation_log add column if not exists duration_ms integer;

update shopee_mutation_log
set actor = 'system'
where actor is null;

update shopee_mutation_log
set payload_hash = 'legacy-' || id::text
where payload_hash is null;

update shopee_mutation_log
set status = 'unknown'
where status is null;

update shopee_mutation_log
set created_at = now()
where created_at is null;

alter table shopee_mutation_log alter column actor set default 'system';
alter table shopee_mutation_log alter column actor set not null;
alter table shopee_mutation_log alter column payload_hash set not null;
alter table shopee_mutation_log alter column status set not null;
alter table shopee_mutation_log alter column created_at set default now();
alter table shopee_mutation_log alter column created_at set not null;

create index if not exists idx_shopee_mutation_log_created_at
  on shopee_mutation_log (created_at desc);

create index if not exists idx_shopee_mutation_log_target_global_item
  on shopee_mutation_log (target_global_item_id);

create index if not exists idx_shopee_mutation_log_run_status
  on shopee_mutation_log (run_id, status, created_at desc);

drop index if exists uidx_shopee_mutation_log_idempotent;

create unique index if not exists uidx_shopee_mutation_log_idempotent
  on shopee_mutation_log (payload_hash)
  where status = 'ok';
