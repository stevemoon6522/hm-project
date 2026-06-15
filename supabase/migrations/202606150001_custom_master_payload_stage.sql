-- Stage operator-created custom master products without any StarOneMall URL.
-- The source_records.source_type stays "manual" so promote RPCs never copy
-- source_url into products.staronemall_url.

create extension if not exists pgcrypto;

create or replace function public.stage_custom_master_payload(
  p_payload jsonb
) returns table (
  source_record_id uuid,
  source_url text,
  status text,
  linked_master_product_id uuid
) language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_actor text;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_title text;
  v_external_id text;
  v_source_url text;
  v_main_images jsonb;
  v_detail_images jsonb;
  v_options jsonb;
  v_observed jsonb;
begin
  v_actor := coalesce(auth.jwt() ->> 'email', 'unknown');
  if v_actor = 'unknown' or auth.role() <> 'authenticated' then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;

  v_title := nullif(btrim(coalesce(v_payload ->> 'product_title', v_payload ->> 'title', '')), '');
  if v_title is null then
    raise exception 'product_title_required' using errcode = 'P0001';
  end if;

  v_main_images := case
    when jsonb_typeof(v_payload -> 'main_image_urls') = 'array' then v_payload -> 'main_image_urls'
    else '[]'::jsonb
  end;
  if jsonb_array_length(v_main_images) < 1 then
    raise exception 'main_image_required' using errcode = 'P0001';
  end if;

  v_detail_images := case
    when jsonb_typeof(v_payload -> 'detail_image_urls') = 'array' then v_payload -> 'detail_image_urls'
    else '[]'::jsonb
  end;
  v_options := case
    when jsonb_typeof(v_payload -> 'options') = 'array' then v_payload -> 'options'
    else '[]'::jsonb
  end;

  v_external_id := nullif(btrim(coalesce(v_payload ->> 'external_id', '')), '');
  if v_external_id is null then
    v_external_id := 'custom_master:' || gen_random_uuid()::text;
  end if;
  v_source_url := 'custom://master/' || regexp_replace(v_external_id, '^custom_master:', '');

  v_observed := jsonb_strip_nulls(jsonb_build_object(
    'title', v_title,
    'artist', nullif(btrim(coalesce(v_payload ->> 'artist', '')), ''),
    'album', nullif(btrim(coalesce(v_payload ->> 'album', '')), ''),
    'version', nullif(btrim(coalesce(v_payload ->> 'version', '')), ''),
    'source', 'custom_master',
    'source_detail', 'operator_custom',
    'main_image_urls', v_main_images,
    'detail_image_urls', v_detail_images,
    'custom_options', v_options,
    'price_krw', nullif(btrim(coalesce(v_payload ->> 'sourcing_price', '')), ''),
    'cost_krw', nullif(btrim(coalesce(v_payload ->> 'cost_krw', '')), ''),
    'weight_g', nullif(btrim(coalesce(v_payload ->> 'weight_g', '')), ''),
    'description_html', nullif(coalesce(v_payload ->> 'description_html', ''), '')
  ));

  insert into public.source_records (
    source_type,
    source_external_id,
    source_url,
    crawl_run_id,
    parser_version,
    raw_payload,
    raw_payload_hash,
    observed_values,
    confidence,
    tier,
    status
  ) values (
    'manual',
    v_external_id,
    v_source_url,
    gen_random_uuid(),
    'custom_master_v1',
    v_payload,
    md5(v_payload::text),
    v_observed,
    95,
    1,
    'pending_review'
  )
  on conflict (source_type, source_external_id, parser_version)
  where source_external_id is not null
  do update
     set fetched_at = now(),
         crawl_run_id = excluded.crawl_run_id,
         source_url = excluded.source_url,
         raw_payload = excluded.raw_payload,
         raw_payload_hash = excluded.raw_payload_hash,
         observed_values = excluded.observed_values,
         confidence = excluded.confidence,
         tier = excluded.tier,
         status = case
           when public.source_records.status in ('rejected', 'superseded') then 'pending_review'
           else public.source_records.status
         end,
         linked_master_product_id = case
           when public.source_records.status in ('rejected', 'superseded') then null
           else public.source_records.linked_master_product_id
         end
  returning public.source_records.id,
            public.source_records.source_url,
            public.source_records.status,
            public.source_records.linked_master_product_id
    into source_record_id, source_url, status, linked_master_product_id;

  return next;
end;
$$;

grant execute on function public.stage_custom_master_payload(jsonb) to authenticated;
