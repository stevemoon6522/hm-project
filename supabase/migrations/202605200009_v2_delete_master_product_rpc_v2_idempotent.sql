-- delete_master_product v2 (operator screenshot msg #497).
-- The v1 version inserted into audit_log BEFORE deleting the product,
-- which violated audit_log_product_id_fkey when the operator clicked
-- delete on a stale UI row whose product had already been removed.
-- Now we SELECT FOR UPDATE first and treat 'row already gone' as a
-- successful idempotent no-op.

create or replace function public.delete_master_product(p_product_id uuid)
returns table (deleted_product_id uuid, reset_source_record_count int)
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_actor text;
  v_reset_count int;
begin
  v_actor := coalesce(auth.jwt() ->> 'email', 'unknown');
  if v_actor = 'unknown' or auth.role() <> 'authenticated' then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;
  if p_product_id is null then
    raise exception 'product_id_required' using errcode = 'P0001';
  end if;

  perform 1 from public.products where id = p_product_id for update;
  if not found then
    return query select p_product_id, 0;
    return;
  end if;

  with reset as (
    update public.source_records
    set status = 'pending_review',
        linked_master_product_id = null,
        reviewed_at = null,
        reviewed_by = null
    where linked_master_product_id = p_product_id
    returning id
  )
  select count(*) into v_reset_count from reset;

  insert into public.audit_log (
    entity_type, entity_uuid, product_id,
    actor, action, after_json, reason
  ) values (
    'product', p_product_id, p_product_id,
    'user:' || v_actor, 'delete',
    jsonb_build_object('reset_source_record_count', v_reset_count),
    'master_product_delete'
  );

  delete from public.products where id = p_product_id;

  return query select p_product_id, coalesce(v_reset_count, 0);
end;
$$;

grant execute on function public.delete_master_product(uuid) to authenticated;
