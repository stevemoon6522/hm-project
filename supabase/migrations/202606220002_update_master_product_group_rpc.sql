-- Atomic master edit save for V2.
-- Applies group-level fields and per-option fields in one transaction so a
-- later SKU/option failure cannot leave the master partially saved.

create or replace function public.update_master_product_group(
  p_product_ids uuid[],
  p_group_patch jsonb default '{}'::jsonb,
  p_option_patches jsonb default '[]'::jsonb
) returns table (product_id uuid)
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_actor text;
  v_input_count int;
  v_locked_count int;
  v_group_count int;
  v_option_count int;
  v_distinct_option_count int;
  v_unknown_option_id uuid;
  v_conflict_sku text;
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

  select count(*), count(distinct coalesce(p.product_group_id, p.id))
    into v_locked_count, v_group_count
    from public.products p
   where p.id = any(p_product_ids);

  if v_locked_count <> v_input_count then
    raise exception 'product_ids_missing' using errcode = 'P0001';
  end if;
  if v_group_count <> 1 then
    raise exception 'products_not_same_group' using errcode = 'P0001';
  end if;

  with option_items as (
    select (item ->> 'id')::uuid as id
      from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
     where nullif(item ->> 'id', '') is not null
  )
  select count(*), count(distinct id)
    into v_option_count, v_distinct_option_count
    from option_items;

  if v_option_count <> v_distinct_option_count then
    raise exception 'duplicate_option_patch_id' using errcode = 'P0001';
  end if;

  with option_items as (
    select (item ->> 'id')::uuid as id
      from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
     where nullif(item ->> 'id', '') is not null
  )
  select oi.id
    into v_unknown_option_id
    from option_items oi
   where not (oi.id = any(p_product_ids))
   limit 1;

  if v_unknown_option_id is not null then
    raise exception 'option_patch_outside_group: %', v_unknown_option_id using errcode = 'P0001';
  end if;

  with option_items as (
    select
      (item ->> 'id')::uuid as id,
      coalesce(item -> 'patch', '{}'::jsonb) as patch
    from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
    where nullif(item ->> 'id', '') is not null
  ),
  target_skus as (
    select
      p.id,
      btrim(coalesce(case when oi.patch ? 'sku' then oi.patch ->> 'sku' else p.sku end, '')) as sku
    from public.products p
    left join option_items oi on oi.id = p.id
    where p.id = any(p_product_ids)
  )
  select ts.sku
    into v_conflict_sku
    from target_skus ts
   where ts.sku <> ''
   group by ts.sku
  having count(*) > 1
   limit 1;

  if v_conflict_sku is not null then
    raise exception 'duplicate_sku_in_master: %', v_conflict_sku using errcode = 'P0001';
  end if;

  with option_items as (
    select
      (item ->> 'id')::uuid as id,
      coalesce(item -> 'patch', '{}'::jsonb) as patch
    from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
    where nullif(item ->> 'id', '') is not null
  ),
  target_skus as (
    select
      p.id,
      btrim(coalesce(case when oi.patch ? 'sku' then oi.patch ->> 'sku' else p.sku end, '')) as sku
    from public.products p
    left join option_items oi on oi.id = p.id
    where p.id = any(p_product_ids)
  )
  select ts.sku
    into v_conflict_sku
    from target_skus ts
    join public.products other
      on other.id <> ts.id
     and btrim(coalesce(other.sku, '')) = ts.sku
   where ts.sku <> ''
   limit 1;

  if v_conflict_sku is not null then
    raise exception 'duplicate_sku_existing_product: %', v_conflict_sku using errcode = '23505';
  end if;

  update public.products p
     set product_kind = case when p_group_patch ? 'product_kind' then coalesce(p_group_patch ->> 'product_kind', 'album') else p.product_kind end,
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
   where p.id = any(p_product_ids);

  with option_items as (
    select
      (item ->> 'id')::uuid as id,
      coalesce(item -> 'patch', '{}'::jsonb) as patch
    from jsonb_array_elements(coalesce(p_option_patches, '[]'::jsonb)) as item
    where nullif(item ->> 'id', '') is not null
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
         cost_krw = case when oi.patch ? 'cost_krw' then coalesce(nullif(oi.patch ->> 'cost_krw', '')::numeric, 0) else p.cost_krw end,
         weight_g = case when oi.patch ? 'weight_g' then coalesce(nullif(oi.patch ->> 'weight_g', '')::numeric, 0) else p.weight_g end,
         shopee_option_image_url = case when oi.patch ? 'shopee_option_image_url' then nullif(oi.patch ->> 'shopee_option_image_url', '') else p.shopee_option_image_url end
    from option_items oi
   where p.id = oi.id;

  return query
    select p.id
      from public.products p
     where p.id = any(p_product_ids)
     order by p.sku, p.id;
end;
$$;

grant execute on function public.update_master_product_group(uuid[], jsonb, jsonb) to authenticated;
