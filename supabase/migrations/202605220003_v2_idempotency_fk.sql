-- P2 #1 fix: add FK from v2_register_idempotency.source_record_id → source_records(id).
-- product_group_id FK is deferred (row is inserted before group is formed) — skipped per plan.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'v2_register_idempotency_source_record_fk'
      and conrelid = 'public.v2_register_idempotency'::regclass
  ) then
    alter table public.v2_register_idempotency
      add constraint v2_register_idempotency_source_record_fk
        foreign key (source_record_id)
        references public.source_records(id)
        on delete cascade
        deferrable initially deferred;
  end if;
end $$;
