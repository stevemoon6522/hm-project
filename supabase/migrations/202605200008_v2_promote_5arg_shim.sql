-- Codex P1 (review 2026-05-20): older SPA bundles still on the 5-arg
-- promote_source_to_product hit PostgREST 404 after we dropped that
-- overload in v6. Restore the 5-arg form as a forwarding shim so cached
-- tabs keep working until they reload.

create or replace function public.promote_source_to_product(
  p_source_record_id uuid,
  p_sku text,
  p_weight_g numeric,
  p_lifecycle_state text,
  p_option_name text
) returns table (product_id uuid, sku text) language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  return query
    select * from public.promote_source_to_product(
      p_source_record_id,
      p_sku,
      p_weight_g,
      p_lifecycle_state,
      p_option_name,
      null::numeric,
      false
    );
end;
$$;

grant execute on function public.promote_source_to_product(uuid, text, numeric, text, text) to authenticated;
