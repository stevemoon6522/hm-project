-- Fix WMS preview Staronemall enrichment RPC: avoid ambiguous references to
-- the returned table column named status, which blocked preview enrichment.

create or replace function public.update_wms_source_observed(
  p_source_record_id uuid,
  p_observed jsonb
) returns table (
  source_record_id uuid,
  status text,
  observed_values jsonb
) language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_actor text;
  v_source public.source_records%rowtype;
  v_next jsonb;
  v_main jsonb;
  v_detail jsonb;
  v_staronemall_url text;
begin
  v_actor := coalesce(auth.jwt() ->> 'email', 'unknown');
  if v_actor = 'unknown' or auth.role() <> 'authenticated' then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;

  if p_source_record_id is null then
    raise exception 'source_record_id_required' using errcode = 'P0001';
  end if;
  if p_observed is null or jsonb_typeof(p_observed) <> 'object' then
    raise exception 'wms_observed_object_required' using errcode = 'P0001';
  end if;

  select *
    into v_source
    from public.source_records
   where id = p_source_record_id
   for update;
  if not found then
    raise exception 'source_record_not_found' using errcode = 'P0001';
  end if;
  if v_source.source_type <> 'wms_inventory' then
    raise exception 'source_record_not_wms_inventory' using errcode = 'P0001';
  end if;

  v_staronemall_url := nullif(btrim(coalesce(
    p_observed ->> 'staronemall_url',
    p_observed ->> 'source_url',
    p_observed ->> 'url',
    ''
  )), '');
  if v_staronemall_url is not null
     and v_staronemall_url !~* '^https?://([^/]+\.)?staronemall\.com(/|$)' then
    raise exception 'invalid_staronemall_url' using errcode = 'P0001';
  end if;

  v_main := coalesce(v_source.observed_values -> 'main_image_urls', '[]'::jsonb);
  if jsonb_typeof(p_observed -> 'main_image_urls') = 'array'
     and jsonb_array_length(p_observed -> 'main_image_urls') > 0 then
    v_main := p_observed -> 'main_image_urls';
  end if;

  v_detail := coalesce(v_source.observed_values -> 'detail_image_urls', '[]'::jsonb);
  if jsonb_typeof(p_observed -> 'detail_image_urls') = 'array' then
    v_detail := p_observed -> 'detail_image_urls';
  end if;

  v_next := coalesce(v_source.observed_values, '{}'::jsonb)
    || jsonb_strip_nulls(jsonb_build_object(
      'title', nullif(btrim(coalesce(p_observed ->> 'title', '')), ''),
      'artist_name', nullif(btrim(coalesce(p_observed ->> 'artist_name', '')), ''),
      'price_krw', case
        when nullif(btrim(coalesce(p_observed ->> 'price_krw', '')), '') ~ '^[0-9]+(\.[0-9]+)?$'
          then (p_observed ->> 'price_krw')::numeric
        else null
      end,
      'release_date', nullif(btrim(coalesce(p_observed ->> 'release_date', '')), ''),
      'description_html', nullif(coalesce(p_observed ->> 'description_html', ''), ''),
      'pno', nullif(btrim(coalesce(p_observed ->> 'pno', '')), ''),
      'staronemall_url', v_staronemall_url,
      'source_url', v_staronemall_url,
      'source_detail', case when v_staronemall_url is not null then 'staronemall' else null end,
      'source', 'wms_inventory'
    ));
  v_next := jsonb_set(v_next, '{main_image_urls}', coalesce(v_main, '[]'::jsonb), true);
  v_next := jsonb_set(v_next, '{detail_image_urls}', coalesce(v_detail, '[]'::jsonb), true);
  v_next := jsonb_set(v_next, '{source}', to_jsonb('wms_inventory'::text), true);

  update public.source_records
     set observed_values = v_next,
         confidence = greatest(coalesce(v_source.confidence, 0), 95),
         fetched_at = now(),
         status = case
           when v_source.status in ('rejected', 'superseded') then 'pending_review'
           else v_source.status
         end
   where id = p_source_record_id
   returning public.source_records.id,
             public.source_records.status,
             public.source_records.observed_values
      into source_record_id, status, observed_values;

  insert into public.audit_log (
    entity_type, entity_uuid, source_record_id, actor, action, after_json, reason, batch_id
  ) values (
    'source_record',
    p_source_record_id,
    p_source_record_id,
    'user:' || v_actor,
    'update',
    jsonb_build_object('staronemall_url', v_staronemall_url, 'source_type', 'wms_inventory'),
    'wms_preview_staronemall_enrichment',
    v_source.crawl_run_id
  );

  return next;
end;
$$;

grant execute on function public.update_wms_source_observed(uuid, jsonb) to authenticated;
