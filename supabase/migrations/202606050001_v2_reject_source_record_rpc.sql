-- URL bulk registration: let an authenticated operator reject a pending
-- source_record so dismissed StarOneMall discoveries do not reappear.

create or replace function public.reject_source_record(
  p_source_record_id uuid,
  p_reason text default 'operator_dismissed'
) returns table (source_record_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source public.source_records%rowtype;
  v_actor text;
  v_reason text;
  v_status text;
begin
  v_actor := coalesce(auth.jwt() ->> 'email', 'unknown');
  if v_actor = 'unknown' or auth.role() <> 'authenticated' then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    v_reason := 'operator_dismissed';
  end if;

  select *
    into v_source
  from public.source_records
  where id = p_source_record_id
  for update;

  if not found then
    raise exception 'source_record_not_found' using errcode = 'P0001';
  end if;

  if v_source.status = 'published' then
    raise exception 'source_record_already_published' using errcode = 'P0001';
  end if;

  update public.source_records
  set status = 'rejected',
      review_notes = trim(both E'\n' from concat_ws(
        E'\n',
        nullif(review_notes, ''),
        '[' || to_char(now(), 'YYYY-MM-DD HH24:MI:SSOF') || '] ' || v_reason
      )),
      reviewed_at = now(),
      reviewed_by = v_actor
  where id = p_source_record_id
  returning public.source_records.status into v_status;

  insert into public.audit_log (
    entity_type, entity_uuid, source_record_id,
    actor, action, before_json, after_json, reason, batch_id
  ) values (
    'source_record', p_source_record_id, p_source_record_id,
    'user:' || v_actor,
    'reject',
    jsonb_build_object('status', v_source.status),
    jsonb_build_object('status', v_status),
    v_reason,
    v_source.crawl_run_id
  );

  return query select p_source_record_id, v_status;
end;
$$;

grant execute on function public.reject_source_record(uuid, text) to authenticated;
