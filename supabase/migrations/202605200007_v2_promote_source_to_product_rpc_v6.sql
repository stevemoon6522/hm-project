-- v6: add p_cost_krw_override + p_overwrite parameters to support operator
-- editing matched cost in stage 2 and explicit "overwrite existing master"
-- behavior when SKU collides (operator decision 2026-05-20 msg #493).
--
-- Drops the older 5-arg signature so PostgREST doesn't pick the wrong overload.

drop function if exists public.promote_source_to_product(uuid, text, numeric, text, text);

create or replace function public.promote_source_to_product(
  p_source_record_id uuid,
  p_sku text,
  p_weight_g numeric,
  p_lifecycle_state text default 'pre_order',
  p_option_name text default null,
  p_cost_krw_override numeric default null,
  p_overwrite boolean default false
) returns table (product_id uuid, sku text) language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_source source_records%rowtype;
  v_observed jsonb;
  v_product_id uuid;
  v_existing_id uuid;
  v_actor text;
  v_cost_krw numeric;
  v_title text;
  v_option text;
  v_main_image text;
  v_extra_images text[];
  v_description text;
begin
  v_actor := coalesce(auth.jwt() ->> 'email', 'unknown');
  if v_actor = 'unknown' or auth.role() <> 'authenticated' then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;

  if p_sku is null or btrim(p_sku) = '' then
    raise exception 'sku_required' using errcode = 'P0001';
  end if;
  if p_weight_g is null or p_weight_g <= 0 then
    raise exception 'invalid_weight_g' using errcode = 'P0001';
  end if;
  if p_lifecycle_state not in ('pre_order', 'ready_stock') then
    raise exception 'invalid_lifecycle_state' using errcode = 'P0001';
  end if;
  if p_cost_krw_override is not null and p_cost_krw_override <= 0 then
    raise exception 'invalid_cost_krw' using errcode = 'P0001';
  end if;

  select * into v_source
  from public.source_records
  where id = p_source_record_id
  for update;
  if not found then
    raise exception 'source_record_not_found' using errcode = 'P0001';
  end if;

  v_observed := v_source.observed_values;

  v_cost_krw := coalesce(p_cost_krw_override, (v_observed ->> 'price_krw')::numeric, 0);
  v_title := nullif(btrim(coalesce(v_observed ->> 'title', '')), '');
  v_option := nullif(btrim(coalesce(p_option_name, '')), '');
  v_main_image := nullif(coalesce(v_observed -> 'main_image_urls' ->> 0, ''), '');
  v_extra_images := case
    when jsonb_typeof(v_observed -> 'detail_image_urls') = 'array'
    then array(select jsonb_array_elements_text(v_observed -> 'detail_image_urls'))
    else null
  end;
  v_description := nullif(coalesce(v_observed ->> 'description_html', ''), '');

  select id into v_existing_id
  from public.products
  where public.products.sku = btrim(p_sku);
  if v_existing_id is not null then
    if p_overwrite then
      update public.products
      set product_name = v_title,
          option_name = v_option,
          cost_krw = v_cost_krw,
          weight_g = p_weight_g,
          weight_measured_at = now(),
          cost_updated_at = now(),
          main_image = v_main_image,
          extra_images = v_extra_images,
          description = v_description,
          staronemall_url = case when v_source.source_type = 'staronemall' then v_source.source_url else staronemall_url end,
          lifecycle_state = p_lifecycle_state,
          updated_at = now()
      where id = v_existing_id;
    end if;
    update public.source_records
    set status = 'published',
        linked_master_product_id = v_existing_id,
        reviewed_at = now(),
        reviewed_by = v_actor
    where id = p_source_record_id;
    insert into public.audit_log (
      entity_type, entity_uuid, source_record_id, product_id,
      actor, action, after_json, reason, batch_id
    ) values (
      'product', v_existing_id, p_source_record_id, v_existing_id,
      'user:' || v_actor,
      case when p_overwrite then 'update' else 'approve' end,
      jsonb_build_object('sku', p_sku, 'cost_krw', v_cost_krw, 'weight_g', p_weight_g, 'overwrite', p_overwrite),
      case when p_overwrite then 'bulk_register_overwrite' else 'bulk_register_resume_existing_sku' end,
      v_source.crawl_run_id
    );
    return query select v_existing_id, btrim(p_sku);
    return;
  end if;

  insert into public.products (
    sku, product_name, option_name, cost_krw, weight_g,
    weight_measured_at, cost_updated_at,
    main_image, extra_images, description,
    staronemall_url, lifecycle_state, inventory, purpose
  ) values (
    btrim(p_sku),
    v_title,
    v_option,
    v_cost_krw,
    p_weight_g,
    now(),
    now(),
    v_main_image,
    v_extra_images,
    v_description,
    case when v_source.source_type = 'staronemall' then v_source.source_url else null end,
    p_lifecycle_state,
    0,
    'registration'
  )
  returning id into v_product_id;

  update public.source_records
  set status = 'published',
      linked_master_product_id = v_product_id,
      reviewed_at = now(),
      reviewed_by = v_actor
  where id = p_source_record_id;

  insert into public.audit_log (
    entity_type, entity_uuid, source_record_id, product_id,
    actor, action,
    after_json, reason, batch_id
  ) values (
    'product', v_product_id, p_source_record_id, v_product_id,
    'user:' || v_actor, 'approve',
    jsonb_build_object('sku', p_sku, 'lifecycle_state', p_lifecycle_state, 'weight_g', p_weight_g, 'cost_krw', v_cost_krw),
    'bulk_register_auto_promote',
    v_source.crawl_run_id
  );

  return query select v_product_id, btrim(p_sku);
end;
$$;

grant execute on function public.promote_source_to_product(uuid, text, numeric, text, text, numeric, boolean) to authenticated;
