-- Preserve WMS SET/bundle definitions when staging WMS inventory into SD.
-- WMS SET rows have empty barcodes and store their component SKUs in
-- inventory.bundle_components, so the staged source payload must keep that
-- JSONB value to detect later SET composition changes.

drop function if exists public.stage_wms_inventory_payload(jsonb, jsonb);

create or replace function public.stage_wms_inventory_payload(
  p_rows jsonb,
  p_observed jsonb default null
) returns table (
  source_record_id uuid,
  inventory_id text,
  sku text,
  barcode text,
  idol text,
  album text,
  version text,
  member text,
  location text,
  image_url text,
  weight_g numeric,
  cost_krw numeric,
  stock_kr integer,
  bundle_components jsonb,
  source_status text,
  linked_master_product_id uuid
) language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_idol text;
  v_album text;
  v_barcode text;
  v_barcode_count integer;
  v_source_external_id text;
  v_source_url text;
  v_source_record_id uuid;
  v_source_status text;
  v_linked_master_product_id uuid;
  v_rows jsonb;
  v_images jsonb;
  v_observed jsonb;
  v_observed_main jsonb;
  v_observed_detail jsonb;
  v_staronemall_url text;
  v_raw_count integer;
  v_valid_count integer;
  v_group_count integer;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'wms_rows_array_required' using errcode = 'P0001';
  end if;
  if p_observed is not null and jsonb_typeof(p_observed) <> 'object' then
    raise exception 'wms_observed_object_required' using errcode = 'P0001';
  end if;

  v_raw_count := jsonb_array_length(p_rows);
  if v_raw_count < 1 then
    raise exception 'wms_rows_required' using errcode = 'P0001';
  end if;
  if v_raw_count > 200 then
    raise exception 'wms_rows_max_200' using errcode = 'P0001';
  end if;

  with input as (
    select
      nullif(btrim(coalesce(x.inventory_id, x.id, '')), '') as inventory_id,
      nullif(btrim(coalesce(x.sku, '')), '') as sku,
      nullif(btrim(coalesce(x.barcode, '')), '') as barcode,
      nullif(btrim(coalesce(x.idol, '')), '') as idol,
      nullif(btrim(coalesce(x.album, '')), '') as album,
      coalesce(nullif(btrim(coalesce(x.version, '')), ''), '') as version,
      coalesce(nullif(btrim(coalesce(x.member, '')), ''), '') as member,
      nullif(btrim(coalesce(x.location, '')), '') as location,
      nullif(btrim(coalesce(x.image_url, x.main_image, '')), '') as image_url,
      coalesce(x.weight_g, x.weight, '') as raw_weight_g,
      coalesce(x.cost_krw, x.sourcing_price, '') as raw_cost_krw,
      coalesce(x.stock_kr, '') as raw_stock_kr,
      x.bundle_components as raw_bundle_components
    from jsonb_to_recordset(p_rows) as x(
      inventory_id text,
      id text,
      sku text,
      barcode text,
      idol text,
      album text,
      version text,
      member text,
      location text,
      image_url text,
      main_image text,
      weight_g text,
      weight text,
      cost_krw text,
      sourcing_price text,
      stock_kr text,
      bundle_components jsonb
    )
  ),
  normalized as (
    select
      i.inventory_id,
      i.sku,
      i.barcode,
      i.idol,
      i.album,
      i.version,
      i.member,
      i.location,
      i.image_url,
      case when nullif(i.raw_weight_g, '') ~ '^-?[0-9]+(\.[0-9]+)?$' then i.raw_weight_g::numeric else 0::numeric end as weight_g,
      case when nullif(i.raw_cost_krw, '') ~ '^-?[0-9]+(\.[0-9]+)?$' then i.raw_cost_krw::numeric else 0::numeric end as cost_krw,
      case when nullif(i.raw_stock_kr, '') ~ '^-?[0-9]+$' then i.raw_stock_kr::integer else 0::integer end as stock_kr,
      case
        when jsonb_typeof(i.raw_bundle_components) = 'array'
         and jsonb_array_length(i.raw_bundle_components) > 0
          then i.raw_bundle_components
        else null::jsonb
      end as bundle_components
    from input i
  ),
  valid as (
    select n.*
      from normalized n
     where n.sku is not null
       and n.idol is not null
       and n.album is not null
  )
  select
    coalesce(jsonb_agg(to_jsonb(v) order by lower(v.version), lower(v.member), lower(v.sku)), '[]'::jsonb),
    count(*)::integer
    into v_rows, v_valid_count
    from valid v;

  if v_valid_count <> v_raw_count then
    raise exception 'wms_payload_invalid_rows' using errcode = 'P0001';
  end if;

  select count(distinct lower(r ->> 'idol') || '|' || lower(r ->> 'album'))
    into v_group_count
    from jsonb_array_elements(v_rows) as r;
  if v_group_count <> 1 then
    raise exception 'wms_payload_single_group_required' using errcode = 'P0001';
  end if;

  v_idol := v_rows -> 0 ->> 'idol';
  v_album := v_rows -> 0 ->> 'album';

  select count(distinct nullif(btrim(r ->> 'barcode'), ''))::integer,
         max(nullif(btrim(r ->> 'barcode'), ''))
    into v_barcode_count, v_barcode
    from jsonb_array_elements(v_rows) as r
   where nullif(btrim(r ->> 'barcode'), '') is not null;

  select coalesce(jsonb_agg(distinct r ->> 'image_url'), '[]'::jsonb)
    into v_images
    from jsonb_array_elements(v_rows) as r
   where nullif(r ->> 'image_url', '') is not null;

  v_observed := jsonb_build_object(
    'title', btrim(v_idol || ' [' || v_album || ']'),
    'artist', v_idol,
    'idol', v_idol,
    'album', v_album,
    'description_html', '',
    'source', 'wms_inventory',
    'source_detail', 'wms_only',
    'barcode', v_barcode,
    'grouping_key', case when v_barcode_count = 1 then 'barcode' else 'idol_album' end,
    'variant_count', jsonb_array_length(v_rows),
    'bundle_variant_count', (
      select count(*)::integer
        from jsonb_array_elements(v_rows) as r
       where jsonb_typeof(r -> 'bundle_components') = 'array'
         and jsonb_array_length(r -> 'bundle_components') > 0
    ),
    'main_image_urls', v_images,
    'detail_image_urls', '[]'::jsonb
  );

  if p_observed is not null then
    v_staronemall_url := nullif(btrim(coalesce(
      p_observed ->> 'staronemall_url',
      p_observed ->> 'source_url',
      p_observed ->> 'url',
      ''
    )), '');

    v_observed_main := v_images;
    if jsonb_typeof(p_observed -> 'main_image_urls') = 'array'
       and jsonb_array_length(p_observed -> 'main_image_urls') > 0 then
      v_observed_main := p_observed -> 'main_image_urls';
    end if;

    v_observed_detail := '[]'::jsonb;
    if jsonb_typeof(p_observed -> 'detail_image_urls') = 'array' then
      v_observed_detail := p_observed -> 'detail_image_urls';
    end if;

    v_observed := v_observed || jsonb_strip_nulls(jsonb_build_object(
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
      'source_detail', case when v_staronemall_url is not null then 'staronemall' else null end
    ));
    v_observed := jsonb_set(v_observed, '{main_image_urls}', coalesce(v_observed_main, v_images), true);
    v_observed := jsonb_set(v_observed, '{detail_image_urls}', coalesce(v_observed_detail, '[]'::jsonb), true);
    v_observed := jsonb_set(v_observed, '{source}', to_jsonb('wms_inventory'::text), true);
  end if;

  if v_barcode_count = 1 and v_barcode is not null then
    v_source_external_id := 'wms_inventory:barcode:' || md5(lower(v_barcode));
    v_source_url := 'wms://inventory/barcode/' || v_barcode;
  else
    v_source_external_id := 'wms_inventory:idol_album:' || md5(lower(v_idol || '|' || v_album));
    v_source_url := 'wms://inventory/' || v_source_external_id;
  end if;

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
    'wms_inventory',
    v_source_external_id,
    v_source_url,
    gen_random_uuid(),
    'wms_inventory_v1',
    v_rows,
    md5(v_rows::text),
    v_observed,
    case when p_observed is not null then 95 else 90 end,
    1,
    'pending_review'
  )
  on conflict (source_type, source_external_id, parser_version)
  where source_external_id is not null
  do update
     set fetched_at = now(),
         crawl_run_id = excluded.crawl_run_id,
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
            public.source_records.status,
            public.source_records.linked_master_product_id
    into v_source_record_id, v_source_status, v_linked_master_product_id;

  return query
    select
      v_source_record_id,
      r.inventory_id,
      r.sku,
      r.barcode,
      r.idol,
      r.album,
      r.version,
      r.member,
      r.location,
      r.image_url,
      r.weight_g,
      r.cost_krw,
      r.stock_kr,
      r.bundle_components,
      v_source_status,
      v_linked_master_product_id
    from jsonb_to_recordset(v_rows) as r(
      inventory_id text,
      sku text,
      barcode text,
      idol text,
      album text,
      version text,
      member text,
      location text,
      image_url text,
      weight_g numeric,
      cost_krw numeric,
      stock_kr integer,
      bundle_components jsonb
    );
end;
$$;

grant execute on function public.stage_wms_inventory_payload(jsonb, jsonb) to authenticated;
