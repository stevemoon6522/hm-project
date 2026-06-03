create table if not exists public.sd_automation_retry_log (
  id bigserial primary key,
  source_log_id bigint not null,
  action text not null,
  run_id text,
  attempt_no integer not null default 1,
  status text not null check (status in ('ok', 'error', 'skipped')),
  response jsonb,
  error_msg text,
  created_at timestamptz not null default now()
);

create index if not exists sd_automation_retry_log_source_idx
  on public.sd_automation_retry_log (source_log_id, created_at desc);

create index if not exists sd_automation_retry_log_created_idx
  on public.sd_automation_retry_log (created_at desc);

alter table public.sd_automation_retry_log enable row level security;

drop policy if exists "sd_automation_retry_log readable by authenticated" on public.sd_automation_retry_log;
create policy "sd_automation_retry_log readable by authenticated"
  on public.sd_automation_retry_log for select
  to public
  using (auth.role() = 'authenticated');
