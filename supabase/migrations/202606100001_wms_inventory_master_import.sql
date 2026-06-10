-- SD master import from existing WMS inventory.
-- WMS remains read-only: SD stages selected inventory groups as source_records,
-- then reuses the existing V2 promote flow to create master products.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

do $$
declare
  v_constraint_name text;
begin
  for v_constraint_name in
    select c.conname
    from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public'
      and r.relname = 'source_records'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%source_type%'
  loop
    execute format('alter table public.source_records drop constraint %I', v_constraint_name);
  end loop;
end $$;

alter table public.source_records
  add constraint source_records_source_type_check
  check (source_type in (
    'yes24', 'weverse', 'staronemall', 'manual', 'csv_import', 'wms_inventory'
  ));

create index if not exists idx_inventory_wms_master_group_lower
  on public.inventory (lower(coalesce(idol, '')), lower(coalesce(album, '')));

create index if not exists idx_inventory_wms_master_search_trgm
  on public.inventory using gin ((
    lower(
      coalesce(idol, '') || ' ' ||
      coalesce(album, '') || ' ' ||
      coalesce(version, '') || ' ' ||
      coalesce(member, '') || ' ' ||
      coalesce(sku, '') || ' ' ||
      coalesce(barcode, '')
    )
  ) gin_trgm_ops);

create or replace function public.search_wms_inventory_groups(
  p_query text,
  p_limit integer default 20
) returns table (
  idol text,
  album text,
  variant_count integer,
  sample_sku text,
  sample_location text,
  sample_image_url text,
  total_stock_kr numeric,
  matched_skus text[]
) language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_has_location boolean;
  v_has_image_url boolean;
  v_has_main_image boolean;
  v_has_stock_kr boolean;
  v_location_expr text;
  v_image_expr text;
  v_stock_expr text;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;

  if length(v_query) < 2 then
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'inventory' and column_name = 'location'
  ) into v_has_location;
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'inventory' and column_name = 'image_url'
  ) into v_has_image_url;
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'inventory' and column_name = 'main_image'
  ) into v_has_main_image;
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'inventory' and column_name = 'stock_kr'
  ) into v_has_stock_kr;

  v_location_expr := case when v_has_location then 'nullif(btrim(i.location::text), '''')' else 'null::text' end;
  v_image_expr := case
    when v_has_image_url then 'nullif(btrim(i.image_url::text), '''')'
    when v_has_main_image then 'nullif(btrim(i.main_image::text), '''')'
    else 'null::text'
  end;
  v_stock_expr := case
    when v_has_stock_kr then 'case when nullif(i.stock_kr::text, '''') ~ ''^-?[0-9]+$'' then i.stock_kr::numeric else null::numeric end'
    else 'null::numeric'
  end;

  return query execute format($sql$
    with matched as (
      select
        nullif(btrim(i.idol), '') as idol,
        nullif(btrim(i.album), '') as album,
        nullif(btrim(i.sku), '') as sku,
        lower(
          coalesce(i.idol, '') || ' ' ||
          coalesce(i.album, '') || ' ' ||
          coalesce(i.version, '') || ' ' ||
          coalesce(i.member, '') || ' ' ||
          coalesce(i.sku, '') || ' ' ||
          coalesce(i.barcode, '')
        ) as haystack,
        %s as location,
        %s as image_url,
        coalesce(%s, 0)::numeric as stock_kr
      from public.inventory i
      where nullif(btrim(i.sku), '') is not null
    )
    select
      m.idol,
      m.album,
      count(*)::integer as variant_count,
      min(m.sku) as sample_sku,
      (array_agg(m.location order by m.sku) filter (where m.location is not null))[1] as sample_location,
      (array_agg(m.image_url order by m.sku) filter (where m.image_url is not null))[1] as sample_image_url,
      sum(m.stock_kr)::numeric as total_stock_kr,
      (array_agg(m.sku order by m.sku) filter (where m.sku is not null))[1:8] as matched_skus
    from matched m
    where m.idol is not null
      and m.album is not null
      and m.haystack like '%%' || $1 || '%%'
    group by m.idol, m.album
    order by
      case when lower(m.idol) = $1 then 0 else 1 end,
      case when lower(m.album) = $1 then 0 else 1 end,
      count(*) desc,
      m.idol asc,
      m.album asc
    limit $2
  $sql$, v_location_expr, v_image_expr, v_stock_expr)
  using v_query, v_limit;
end;
$$;

create or replace function public.stage_wms_inventory_group(
  p_idol text,
  p_album text
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
  stock_kr integer
) language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_idol text := nullif(btrim(coalesce(p_idol, '')), '');
  v_album text := nullif(btrim(coalesce(p_album, '')), '');
  v_source_external_id text;
  v_source_record_id uuid;
  v_rows jsonb;
  v_images jsonb;
  v_observed jsonb;
  v_select_sql text;
  v_has_location boolean;
  v_has_image_url boolean;
  v_has_main_image boolean;
  v_has_weight_g boolean;
  v_has_weight boolean;
  v_has_cost_krw boolean;
  v_has_sourcing_price boolean;
  v_has_supply_price boolean;
  v_has_purchase_price boolean;
  v_has_stock_kr boolean;
  v_location_expr text;
  v_image_expr text;
  v_weight_expr text;
  v_cost_expr text;
  v_stock_expr text;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;
  if v_idol is null or v_album is null then
    raise exception 'idol_album_required' using errcode = 'P0001';
  end if;

  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'location') into v_has_location;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'image_url') into v_has_image_url;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'main_image') into v_has_main_image;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'weight_g') into v_has_weight_g;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'weight') into v_has_weight;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'cost_krw') into v_has_cost_krw;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'sourcing_price') into v_has_sourcing_price;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'supply_price') into v_has_supply_price;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'purchase_price') into v_has_purchase_price;
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory' and column_name = 'stock_kr') into v_has_stock_kr;

  v_location_expr := case when v_has_location then 'nullif(btrim(i.location::text), '''')' else 'null::text' end;
  v_image_expr := case
    when v_has_image_url then 'nullif(btrim(i.image_url::text), '''')'
    when v_has_main_image then 'nullif(btrim(i.main_image::text), '''')'
    else 'null::text'
  end;
  v_weight_expr := case
    when v_has_weight_g then 'case when nullif(i.weight_g::text, '''') ~ ''^-?[0-9]+(\.[0-9]+)?$'' then i.weight_g::numeric else null::numeric end'
    when v_has_weight then 'case when nullif(i.weight::text, '''') ~ ''^-?[0-9]+(\.[0-9]+)?$'' then i.weight::numeric else null::numeric end'
    else 'null::numeric'
  end;
  v_cost_expr := case
    when v_has_cost_krw then 'case when nullif(i.cost_krw::text, '''') ~ ''^-?[0-9]+(\.[0-9]+)?$'' then i.cost_krw::numeric else null::numeric end'
    when v_has_sourcing_price then 'case when nullif(i.sourcing_price::text, '''') ~ ''^-?[0-9]+(\.[0-9]+)?$'' then i.sourcing_price::numeric else null::numeric end'
    when v_has_supply_price then 'case when nullif(i.supply_price::text, '''') ~ ''^-?[0-9]+(\.[0-9]+)?$'' then i.supply_price::numeric else null::numeric end'
    when v_has_purchase_price then 'case when nullif(i.purchase_price::text, '''') ~ ''^-?[0-9]+(\.[0-9]+)?$'' then i.purchase_price::numeric else null::numeric end'
    else 'null::numeric'
  end;
  v_stock_expr := case
    when v_has_stock_kr then 'case when nullif(i.stock_kr::text, '''') ~ ''^-?[0-9]+$'' then i.stock_kr::integer else null::integer end'
    else 'null::integer'
  end;

  v_select_sql := format($sql$
    select
      i.id::text as inventory_id,
      nullif(btrim(i.sku), '') as sku,
      nullif(btrim(i.barcode), '') as barcode,
      nullif(btrim(i.idol), '') as idol,
      nullif(btrim(i.album), '') as album,
      coalesce(nullif(btrim(i.version), ''), '') as version,
      coalesce(nullif(btrim(i.member), ''), '') as member,
      %s as location,
      %s as image_url,
      coalesce(%s, 0)::numeric as weight_g,
      coalesce(%s, 0)::numeric as cost_krw,
      coalesce(%s, 0)::integer as stock_kr
    from public.inventory i
    where lower(coalesce(i.idol, '')) = lower($1)
      and lower(coalesce(i.album, '')) = lower($2)
      and nullif(btrim(i.sku), '') is not null
    order by lower(coalesce(i.version, '')), lower(coalesce(i.member, '')), lower(coalesce(i.sku, ''))
  $sql$, v_location_expr, v_image_expr, v_weight_expr, v_cost_expr, v_stock_expr);

  execute format('select coalesce(jsonb_agg(to_jsonb(r)), ''[]''::jsonb) from (%s) r', v_select_sql)
    into v_rows
    using v_idol, v_album;

  if jsonb_array_length(v_rows) = 0 then
    raise exception 'wms_inventory_group_not_found' using errcode = 'P0001';
  end if;

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
    'variant_count', jsonb_array_length(v_rows),
    'main_image_urls', v_images,
    'detail_image_urls', '[]'::jsonb
  );
  v_source_external_id := 'wms_inventory:' || md5(lower(v_idol || '|' || v_album));

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
    'wms://inventory/' || v_source_external_id,
    gen_random_uuid(),
    'wms_inventory_v1',
    v_rows,
    md5(v_rows::text),
    v_observed,
    90,
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
  returning id into v_source_record_id;

  return query execute format('select $3::uuid as source_record_id, r.* from (%s) r', v_select_sql)
    using v_idol, v_album, v_source_record_id;
end;
$$;

create or replace function public.stage_wms_inventory_payload(
  p_rows jsonb
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
  stock_kr integer
) language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_idol text;
  v_album text;
  v_source_external_id text;
  v_source_record_id uuid;
  v_rows jsonb;
  v_images jsonb;
  v_observed jsonb;
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
      coalesce(x.stock_kr, '') as raw_stock_kr
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
      stock_kr text
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
      case when nullif(i.raw_stock_kr, '') ~ '^-?[0-9]+$' then i.raw_stock_kr::integer else 0::integer end as stock_kr
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
    'variant_count', jsonb_array_length(v_rows),
    'main_image_urls', v_images,
    'detail_image_urls', '[]'::jsonb
  );
  v_source_external_id := 'wms_inventory:' || md5(lower(v_idol || '|' || v_album));

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
    'wms://inventory/' || v_source_external_id,
    gen_random_uuid(),
    'wms_inventory_v1',
    v_rows,
    md5(v_rows::text),
    v_observed,
    90,
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
  returning id into v_source_record_id;

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
      r.stock_kr
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
      stock_kr integer
    );
end;
$$;

grant execute on function public.search_wms_inventory_groups(text, integer) to authenticated;
grant execute on function public.stage_wms_inventory_group(text, text) to authenticated;
grant execute on function public.stage_wms_inventory_payload(jsonb) to authenticated;
