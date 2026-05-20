-- Delete a master product + reset its source_records back to pending_review.
-- Operator-facing: 상품 목록 tab "🗑 삭제" button (2026-05-20 msg #487).
-- Cascade behavior:
--   - product_shopee_listings → ON DELETE CASCADE (FK)
--   - source_records.linked_master_product_id → ON DELETE SET NULL (FK)
--   - audit_log.product_id → ON DELETE SET NULL (FK)
-- We additionally flip linked source_records back to status='pending_review'
-- so the operator can immediately re-register the same URL with fresh data.

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

  -- Reset linked source_records back to pending_review so they can be
  -- re-registered. Capture how many rows we touched for the audit entry.
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
