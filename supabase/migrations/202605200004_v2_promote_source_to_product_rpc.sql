-- Step 1b/1c hybrid (per operator decision 2026-05-20 msg #476):
-- bulk URL+weight registration auto-promotes each crawl result to a
-- products row in one operator click. This RPC handles the atomic
-- "source_record + operator inputs → products row" transition.

create or replace function public.promote_source_to_product(
  p_source_record_id uuid,
  p_sku text,
  p_weight_g numeric,
  p_lifecycle_state text default 'pre_order',
  p_option_name text default null
) returns table (product_id uuid, sku text) language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_source source_records%rowtype;
  v_observed jsonb;
  v_product_id uuid;
  v_existing_id uuid;
  v_actor text;
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

  -- Codex P0 (review 2026-05-20): take row-level lock on source_records BEFORE
  -- the published-check so concurrent promote_source_to_product calls on the
  -- same source_record_id can't both pass the gate and race two products
  -- inserts (which would either fail on sku unique or leave orphaned rows).
  select * into v_source
  from public.source_records
  where id = p_source_record_id
  for update;
  if not found then
    raise exception 'source_record_not_found' using errcode = 'P0001';
  end if;
  if v_source.status = 'published' and v_source.linked_master_product_id is not null then
    select id, products.sku into v_product_id, p_sku
    from public.products
    where products.id = v_source.linked_master_product_id;
    return query select v_product_id, p_sku;
    return;
  end if;

  v_observed := v_source.observed_values;

  -- Codex P1 (second-pass review 2026-05-20): if a previous attempt on this
  -- same source_record already inserted the products row but crashed before
  -- flipping source_records.status='published', a naive retry hits the SKU
  -- unique constraint and dead-ends. Look up by SKU first so the retry can
  -- safely adopt the existing products row and complete the status flip.
  -- products.sku must be qualified — bare `sku` collides with the RETURNS
  -- TABLE column of the same name (ambiguous column reference, raised 2026-05-20).
  select id into v_existing_id
  from public.products
  where public.products.sku = btrim(p_sku);
  if v_existing_id is not null then
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
      'user:' || v_actor, 'approve',
      jsonb_build_object('sku', p_sku, 'resumed', true),
      'bulk_register_resume_existing_sku',
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
    nullif(btrim(coalesce(v_observed ->> 'title', '')), ''),
    nullif(btrim(coalesce(p_option_name, '')), ''),
    coalesce((v_observed ->> 'price_krw')::numeric, 0),
    p_weight_g,
    case when p_weight_g > 0 then now() else null end,
    case when coalesce((v_observed ->> 'price_krw')::numeric, 0) > 0 then now() else null end,
    nullif(coalesce(v_observed -> 'main_image_urls' ->> 0, ''), ''),
    case
      when jsonb_typeof(v_observed -> 'detail_image_urls') = 'array'
      then array(select jsonb_array_elements_text(v_observed -> 'detail_image_urls'))
      else null
    end,
    nullif(coalesce(v_observed ->> 'description_html', ''), ''),
    case when v_source.source_type = 'staronemall' then v_source.source_url else null end,
    p_lifecycle_state,
    0,
    'master_register'
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
    jsonb_build_object('sku', p_sku, 'lifecycle_state', p_lifecycle_state, 'weight_g', p_weight_g),
    'bulk_register_auto_promote',
    v_source.crawl_run_id
  );

  return query select v_product_id, btrim(p_sku);
end;
$$;

grant execute on function public.promote_source_to_product(uuid, text, numeric, text, text) to authenticated;
