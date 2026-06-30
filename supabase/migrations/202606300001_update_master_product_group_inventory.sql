-- Extend atomic V2 master edit save to support option insert/delete.
-- The browser sends one p_option_patches array containing action = update,
-- action = insert, and action = delete entries; this function applies all of
-- them in a single transaction with SKU validation.

drop function if exists public.update_master_product_group(uuid[], jsonb, jsonb);

create or replace function public.update_master_product_group(
  p_product_ids uuid[],
  p_group_patch jsonb default '{}'::jsonb,
  p_option_patches jsonb default '[]'::jsonb
) returns table (product_id uuid, client_id text, action text)
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_actor text;
  v_input_count int;
  v_locked_count int;
  v_group_count int;
  v_group_id uuid;
  v_option_count int;
  v_distinct_option_count int;
  v_unknown_option_id uuid;
  v_delete_count int;
  v_insert_count int;
  v_active_count int;
  v_blank_sku boolean;
  v_conflict_sku text;
  v_item jsonb;
  v_patch jsonb;
  v_action text;
  v_client_id text;
  v_new_product_id uuid;
begin
  v_actor := coalesce(auth.jwt() ->> 'email', 'unknown');
  if v_actor = 'unknown' or auth.role() <> 'authenticated' then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;

  if p_product_ids is null or array_length(p_product_ids, 1) is null then
    raise exception 'product_ids_required' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_group_patch, '{}'::jsonb)) <> 'object' then
    raise exception 'group_patch_must_be_object' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_option_patches, '[]'::jsonb)) <> 'array' then
    raise exception 'option_patches_must_be_array' using errcode = 'P0001';
  end if;

  select count(distinct id)
    into v_input_count
    from unnest(p_product_ids) as ids(id)
   where id is not null;

  if v_input_count = 0 then
    raise exception 'product_ids_required' using errcode = 'P0001';
  end if;

  perform 1
    from public.products p
   where p.id = any(p_product_ids)
   for update;

  select count(*),
         count(distinct coalesce(p.product_group_id, p.id))
    into v_locked_count, v_group_count
    from public.products p
   where p.id = any(p_product_ids);

  if v_locked_count <> v_input_count then
    raise exception 'product_ids_missing' using errcode = 'P0001';
  end if;
  if v_group_count <> 1 then
    raise exception 'products_not_same_group' using errcode = 'P0001';
  end if;

  select coalesce(p.product_group_id, p.id)
    into v_group_id
    from public.products p
   where p.id = any(p_product_ids)
   limit 1;

  with option_items as (
    select
      nullif(item ->> 'id', '')::uuid as id,
      coalesce(nullif(item ->> 'action', ''), case when nullif(item ->> 'id', '') is null then 'insert' else 'update' end) as action
      from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
  )
  select count(*) filter (where id is not null),
         count(distinct id) filter (where id is not null),
         count(*) filter (where oi.action = 'delete'),
         count(*) filter (where oi.action = 'insert')
    into v_option_count, v_distinct_option_count, v_delete_count, v_insert_count
    from option_items oi;

  if v_option_count <> v_distinct_option_count then
    raise exception 'duplicate_option_patch_id' using errcode = 'P0001';
  end if;

  with option_items as (
    select
      nullif(item ->> 'id', '')::uuid as id,
      coalesce(nullif(item ->> 'action', ''), case when nullif(item ->> 'id', '') is null then 'insert' else 'update' end) as action
      from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
  )
  select oi.id
    into v_unknown_option_id
    from option_items oi
   where oi.id is not null
     and not (oi.id = any(p_product_ids))
   limit 1;

  if v_unknown_option_id is not null then
    raise exception 'option_patch_outside_group: %', v_unknown_option_id using errcode = 'P0001';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
     where coalesce(nullif(item ->> 'action', ''), case when nullif(item ->> 'id', '') is null then 'insert' else 'update' end)
           not in ('insert', 'update', 'delete')
  ) then
    raise exception 'invalid_option_patch_action' using errcode = 'P0001';
  end if;

  v_active_count := v_locked_count - coalesce(v_delete_count, 0) + coalesce(v_insert_count, 0);
  if v_active_count < 1 then
    raise exception 'master_requires_one_option' using errcode = 'P0001';
  end if;
  if v_active_count > 50 then
    raise exception 'variation_options_max_50' using errcode = 'P0001';
  end if;

  with option_items as (
    select
      nullif(item ->> 'id', '')::uuid as id,
      coalesce(nullif(item ->> 'action', ''), case when nullif(item ->> 'id', '') is null then 'insert' else 'update' end) as action,
      coalesce(item -> 'patch', '{}'::jsonb) as patch
    from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
  ),
  delete_ids as (
    select oi.id from option_items oi where oi.action = 'delete' and oi.id is not null
  ),
  target_skus as (
    select
      p.id,
      btrim(coalesce(case when oi.patch ? 'sku' then oi.patch ->> 'sku' else p.sku end, '')) as sku
    from public.products p
    left join option_items oi on oi.id = p.id and oi.action <> 'delete'
    where p.id = any(p_product_ids)
      and not exists (select 1 from delete_ids d where d.id = p.id)
    union all
    select
      null::uuid as id,
      btrim(coalesce(oi.patch ->> 'sku', '')) as sku
    from option_items oi
    where oi.action = 'insert'
  )
  select exists(select 1 from target_skus where sku = '')
    into v_blank_sku;

  if v_blank_sku then
    raise exception 'sku_required_for_option' using errcode = 'P0001';
  end if;

  with option_items as (
    select
      nullif(item ->> 'id', '')::uuid as id,
      coalesce(nullif(item ->> 'action', ''), case when nullif(item ->> 'id', '') is null then 'insert' else 'update' end) as action,
      coalesce(item -> 'patch', '{}'::jsonb) as patch
    from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
  ),
  delete_ids as (
    select oi.id from option_items oi where oi.action = 'delete' and oi.id is not null
  ),
  target_skus as (
    select
      p.id,
      btrim(coalesce(case when oi.patch ? 'sku' then oi.patch ->> 'sku' else p.sku end, '')) as sku
    from public.products p
    left join option_items oi on oi.id = p.id and oi.action <> 'delete'
    where p.id = any(p_product_ids)
      and not exists (select 1 from delete_ids d where d.id = p.id)
    union all
    select
      null::uuid as id,
      btrim(coalesce(oi.patch ->> 'sku', '')) as sku
    from option_items oi
    where oi.action = 'insert'
  )
  select ts.sku
    into v_conflict_sku
    from target_skus ts
   group by ts.sku
  having count(*) > 1
   limit 1;

  if v_conflict_sku is not null then
    raise exception 'duplicate_sku_in_master: %', v_conflict_sku using errcode = 'P0001';
  end if;

  with option_items as (
    select
      nullif(item ->> 'id', '')::uuid as id,
      coalesce(nullif(item ->> 'action', ''), case when nullif(item ->> 'id', '') is null then 'insert' else 'update' end) as action,
      coalesce(item -> 'patch', '{}'::jsonb) as patch
    from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
  ),
  delete_ids as (
    select oi.id from option_items oi where oi.action = 'delete' and oi.id is not null
  ),
  target_skus as (
    select
      p.id,
      btrim(coalesce(case when oi.patch ? 'sku' then oi.patch ->> 'sku' else p.sku end, '')) as sku
    from public.products p
    left join option_items oi on oi.id = p.id and oi.action <> 'delete'
    where p.id = any(p_product_ids)
      and not exists (select 1 from delete_ids d where d.id = p.id)
    union all
    select
      null::uuid as id,
      btrim(coalesce(oi.patch ->> 'sku', '')) as sku
    from option_items oi
    where oi.action = 'insert'
  )
  select ts.sku
    into v_conflict_sku
    from target_skus ts
    join public.products other
      on btrim(coalesce(other.sku, '')) = ts.sku
     and coalesce(other.product_group_id, other.id) <> v_group_id
   where ts.sku <> ''
   limit 1;

  if v_conflict_sku is not null then
    raise exception 'duplicate_sku_existing_product: %', v_conflict_sku using errcode = '23505';
  end if;

  with option_items as (
    select
      nullif(item ->> 'id', '')::uuid as id,
      coalesce(nullif(item ->> 'action', ''), case when nullif(item ->> 'id', '') is null then 'insert' else 'update' end) as action
    from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
  ),
  delete_ids as (
    select oi.id from option_items oi where oi.action = 'delete' and oi.id is not null
  )
  update public.products p
     set product_group_id = v_group_id,
         product_kind = case when p_group_patch ? 'product_kind' then coalesce(p_group_patch ->> 'product_kind', 'album') else p.product_kind end,
         product_name = case when p_group_patch ? 'product_name' then nullif(p_group_patch ->> 'product_name', '') else p.product_name end,
         lifecycle_state = case when p_group_patch ? 'lifecycle_state' then coalesce(p_group_patch ->> 'lifecycle_state', p.lifecycle_state) else p.lifecycle_state end,
         staronemall_url = case when p_group_patch ? 'staronemall_url' then nullif(p_group_patch ->> 'staronemall_url', '') else p.staronemall_url end,
         main_image = case when p_group_patch ? 'main_image' then nullif(p_group_patch ->> 'main_image', '') else p.main_image end,
         extra_images = case
           when not (p_group_patch ? 'extra_images') then p.extra_images
           when jsonb_typeof(p_group_patch -> 'extra_images') = 'array' then array(
             select value
               from jsonb_array_elements_text(p_group_patch -> 'extra_images') with ordinality as x(value, ord)
              order by ord
           )
           else null
         end,
         shopee_category_id = case when p_group_patch ? 'shopee_category_id' then nullif(p_group_patch ->> 'shopee_category_id', '')::bigint else p.shopee_category_id end,
         joom_category_id = case when p_group_patch ? 'joom_category_id' then nullif(p_group_patch ->> 'joom_category_id', '') else p.joom_category_id end,
         qoo10_category_id = case when p_group_patch ? 'qoo10_category_id' then nullif(p_group_patch ->> 'qoo10_category_id', '') else p.qoo10_category_id end,
         ebay_category_id = case when p_group_patch ? 'ebay_category_id' then nullif(p_group_patch ->> 'ebay_category_id', '') else p.ebay_category_id end,
         shopee_brand_id = case when p_group_patch ? 'shopee_brand_id' then coalesce(nullif(p_group_patch ->> 'shopee_brand_id', '')::bigint, 0) else p.shopee_brand_id end,
         shopee_brand_name = case when p_group_patch ? 'shopee_brand_name' then coalesce(nullif(p_group_patch ->> 'shopee_brand_name', ''), 'No Brand') else p.shopee_brand_name end,
         shopee_days_to_ship = case when p_group_patch ? 'shopee_days_to_ship' then p_group_patch -> 'shopee_days_to_ship' else p.shopee_days_to_ship end,
         shopee_extra_attributes = case when p_group_patch ? 'shopee_extra_attributes' then p_group_patch -> 'shopee_extra_attributes' else p.shopee_extra_attributes end,
         components_extracted_en = case when p_group_patch ? 'components_extracted_en' then nullif(p_group_patch ->> 'components_extracted_en', '') else p.components_extracted_en end,
         components_extracted_at = case when p_group_patch ? 'components_extracted_at' then nullif(p_group_patch ->> 'components_extracted_at', '')::timestamptz else p.components_extracted_at end,
         components_approved = case when p_group_patch ? 'components_approved' then coalesce(nullif(p_group_patch ->> 'components_approved', '')::integer, 0) else p.components_approved end
   where p.id = any(p_product_ids)
     and not exists (select 1 from delete_ids d where d.id = p.id);

  with option_items as (
    select
      nullif(item ->> 'id', '')::uuid as id,
      item ->> 'client_id' as client_id,
      coalesce(nullif(item ->> 'action', ''), case when nullif(item ->> 'id', '') is null then 'insert' else 'update' end) as action,
      coalesce(item -> 'patch', '{}'::jsonb) as patch
    from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
  )
  update public.products p
     set sku = case when oi.patch ? 'sku' then coalesce(oi.patch ->> 'sku', '') else p.sku end,
         option_name = case when oi.patch ? 'option_name' then nullif(oi.patch ->> 'option_name', '') else p.option_name end,
         variation_tier_names = case
           when not (oi.patch ? 'variation_tier_names') then p.variation_tier_names
           when jsonb_typeof(oi.patch -> 'variation_tier_names') = 'array' then array(
             select value
               from jsonb_array_elements_text(oi.patch -> 'variation_tier_names') with ordinality as x(value, ord)
              order by ord
           )
           else null
         end,
         variation_option_names = case
           when not (oi.patch ? 'variation_option_names') then p.variation_option_names
           when jsonb_typeof(oi.patch -> 'variation_option_names') = 'array' then array(
             select value
               from jsonb_array_elements_text(oi.patch -> 'variation_option_names') with ordinality as x(value, ord)
              order by ord
           )
           else null
         end,
         variation_tier_index = case
           when not (oi.patch ? 'variation_tier_index') then p.variation_tier_index
           when jsonb_typeof(oi.patch -> 'variation_tier_index') = 'array' then array(
             select value::integer
               from jsonb_array_elements_text(oi.patch -> 'variation_tier_index') with ordinality as x(value, ord)
              order by ord
           )
           else null
         end,
         sourcing_price = case when oi.patch ? 'sourcing_price' then coalesce(nullif(oi.patch ->> 'sourcing_price', '')::numeric, 0) else p.sourcing_price end,
         cost_krw = case when oi.patch ? 'cost_krw' then coalesce(nullif(oi.patch ->> 'cost_krw', '')::numeric, 0) else p.cost_krw end,
         weight_g = case when oi.patch ? 'weight_g' then coalesce(nullif(oi.patch ->> 'weight_g', '')::numeric, 0) else p.weight_g end,
         inventory = case when oi.patch ? 'inventory' then coalesce(nullif(oi.patch ->> 'inventory', '')::integer, 0) else p.inventory end,
         shopee_option_image_url = case when oi.patch ? 'shopee_option_image_url' then nullif(oi.patch ->> 'shopee_option_image_url', '') else p.shopee_option_image_url end
    from option_items oi
   where p.id = oi.id
     and oi.action = 'update';

  return query
    select p.id, oi.client_id, 'update'::text
      from public.products p
      join (
        select
          nullif(item ->> 'id', '')::uuid as id,
          item ->> 'client_id' as client_id,
          coalesce(nullif(item ->> 'action', ''), case when nullif(item ->> 'id', '') is null then 'insert' else 'update' end) as action
        from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
      ) oi on oi.id = p.id
     where oi.action = 'update'
       and p.product_group_id = v_group_id;

  for v_item in
    select item
      from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
     where coalesce(nullif(item ->> 'action', ''), case when nullif(item ->> 'id', '') is null then 'insert' else 'update' end) = 'insert'
  loop
    v_patch := coalesce(v_item -> 'patch', '{}'::jsonb);
    v_action := coalesce(nullif(v_item ->> 'action', ''), 'insert');
    v_client_id := nullif(v_item ->> 'client_id', '');

    insert into public.products (
      product_group_id,
      product_kind,
      product_name,
      lifecycle_state,
      staronemall_url,
      main_image,
      extra_images,
      shopee_category_id,
      joom_category_id,
      qoo10_category_id,
      ebay_category_id,
      shopee_brand_id,
      shopee_brand_name,
      shopee_days_to_ship,
      shopee_extra_attributes,
      components_extracted_en,
      components_extracted_at,
      components_approved,
      sku,
      option_name,
      variation_tier_names,
      variation_option_names,
      variation_tier_index,
      sourcing_price,
      cost_krw,
      weight_g,
      shopee_option_image_url,
      shopee_publish_state,
      inventory,
      purpose
    ) values (
      v_group_id,
      coalesce(p_group_patch ->> 'product_kind', 'album'),
      nullif(p_group_patch ->> 'product_name', ''),
      coalesce(p_group_patch ->> 'lifecycle_state', 'ready_stock'),
      nullif(p_group_patch ->> 'staronemall_url', ''),
      nullif(p_group_patch ->> 'main_image', ''),
      case
        when jsonb_typeof(p_group_patch -> 'extra_images') = 'array' then array(
          select value
            from jsonb_array_elements_text(p_group_patch -> 'extra_images') with ordinality as x(value, ord)
           order by ord
        )
        else null
      end,
      nullif(p_group_patch ->> 'shopee_category_id', '')::bigint,
      nullif(p_group_patch ->> 'joom_category_id', ''),
      nullif(p_group_patch ->> 'qoo10_category_id', ''),
      nullif(p_group_patch ->> 'ebay_category_id', ''),
      coalesce(nullif(p_group_patch ->> 'shopee_brand_id', '')::bigint, 0),
      coalesce(nullif(p_group_patch ->> 'shopee_brand_name', ''), 'No Brand'),
      case when p_group_patch ? 'shopee_days_to_ship' then p_group_patch -> 'shopee_days_to_ship' else null end,
      case when p_group_patch ? 'shopee_extra_attributes' then p_group_patch -> 'shopee_extra_attributes' else null end,
      nullif(p_group_patch ->> 'components_extracted_en', ''),
      nullif(p_group_patch ->> 'components_extracted_at', '')::timestamptz,
      coalesce(nullif(p_group_patch ->> 'components_approved', '')::integer, 0),
      btrim(coalesce(v_patch ->> 'sku', '')),
      nullif(v_patch ->> 'option_name', ''),
      case
        when jsonb_typeof(v_patch -> 'variation_tier_names') = 'array' then array(
          select value
            from jsonb_array_elements_text(v_patch -> 'variation_tier_names') with ordinality as x(value, ord)
           order by ord
        )
        else null
      end,
      case
        when jsonb_typeof(v_patch -> 'variation_option_names') = 'array' then array(
          select value
            from jsonb_array_elements_text(v_patch -> 'variation_option_names') with ordinality as x(value, ord)
           order by ord
        )
        else null
      end,
      case
        when jsonb_typeof(v_patch -> 'variation_tier_index') = 'array' then array(
          select value::integer
            from jsonb_array_elements_text(v_patch -> 'variation_tier_index') with ordinality as x(value, ord)
           order by ord
        )
        else null
      end,
      coalesce(nullif(v_patch ->> 'sourcing_price', '')::numeric, 0),
      coalesce(nullif(v_patch ->> 'cost_krw', '')::numeric, 0),
      coalesce(nullif(v_patch ->> 'weight_g', '')::numeric, 0),
      nullif(v_patch ->> 'shopee_option_image_url', ''),
      'unpublished',
      coalesce(nullif(v_patch ->> 'inventory', '')::integer, 0),
      'registration'
    )
    returning id into v_new_product_id;

    return query select v_new_product_id, v_client_id, v_action;
  end loop;

  return query
    with option_items as (
      select
        nullif(item ->> 'id', '')::uuid as id,
        item ->> 'client_id' as client_id,
        coalesce(nullif(item ->> 'action', ''), case when nullif(item ->> 'id', '') is null then 'insert' else 'update' end) as action
      from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
    )
    delete from public.products p
     using option_items oi
     where p.id = oi.id
       and oi.action = 'delete'
    returning p.id, oi.client_id, 'delete'::text;
end;
$$;

grant execute on function public.update_master_product_group(uuid[], jsonb, jsonb) to authenticated;
