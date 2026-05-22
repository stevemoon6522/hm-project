-- P0 #1 fix: atomic idempotency claim via INSERT-ON-CONFLICT-DO-UPDATE RETURNING.
-- Codex review 2026-05-22: SELECT → INSERT-ON-CONFLICT-WHERE pattern has a race window.
-- Two concurrent calls can both see empty SELECT, both attempt INSERT, one wins the
-- conflict but the WHERE state='failed' guard silently drops its update — the loser
-- proceeds past the check anyway.
-- Fix: collapse the check into a single atomic CTE. RETURNING tells us if we claimed
-- the row (fresh INSERT or failed→in_progress) vs found an existing non-claimable row.

-- ─────────────────────────────────────────────────────────
-- promote_source_group_to_products: replace with atomic claim
-- ─────────────────────────────────────────────────────────

drop function if exists public.promote_source_group_to_products(uuid, text[], jsonb, text, jsonb, uuid);

create or replace function public.promote_source_group_to_products(
  p_source_record_id      uuid,
  p_variation_tier_names  text[],             -- e.g. ['멤버'] or ['멤버','버전']
  p_variation_options     jsonb,              -- array of option row objects (§4-2)
  p_lifecycle_state       text  default 'pre_order',
  p_card_header_overrides jsonb default null, -- prefill defaults (not authoritative)
  p_idempotency_token     uuid  default null  -- §6-2 card-level token
) returns table (
  product_id   uuid,
  sku          text,
  group_id     uuid,
  row_status   text
) language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_actor          text;
  v_source         source_records%rowtype;
  v_observed       jsonb;
  v_title          text;
  v_description    text;
  v_staronemall_url text;
  v_group_id       uuid;
  v_first          boolean := true;
  v_opt            jsonb;
  v_product_id     uuid;
  v_sku            text;
  v_cost_krw       numeric;
  v_weight_g       numeric;
  v_main_image     text;
  v_extra_images   text[];
  v_option_names   text[];
  v_tier_index     integer[];
  v_collision_mode text;
  v_existing_id    uuid;
  v_n              int;
  v_idm_state      text;
  v_idm_result     jsonb;
  i                int;
begin
  -- Auth check
  v_actor := coalesce(auth.jwt() ->> 'email', 'unknown');
  if v_actor = 'unknown' or auth.role() <> 'authenticated' then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;

  -- Basic param validation
  if p_variation_tier_names is null or array_length(p_variation_tier_names, 1) < 1 then
    raise exception 'variation_tier_names_required' using errcode = 'P0001';
  end if;
  if array_length(p_variation_tier_names, 1) > 2 then
    raise exception 'variation_tier_names_max_2' using errcode = 'P0001';
  end if;
  if p_variation_options is null or jsonb_array_length(p_variation_options) < 1 then
    raise exception 'variation_options_required' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_variation_options) > 50 then
    raise exception 'variation_options_max_50' using errcode = 'P0001';
  end if;
  if p_lifecycle_state not in ('pre_order','ready_stock') then
    raise exception 'invalid_lifecycle_state' using errcode = 'P0001';
  end if;

  -- §6-2 idempotency: atomic claim via INSERT-ON-CONFLICT RETURNING (P0 #1 fix)
  if p_idempotency_token is not null then
    with claim as (
      insert into public.v2_register_idempotency
        (idempotency_token, source_record_id, state)
      values
        (p_idempotency_token, p_source_record_id, 'in_progress')
      on conflict (idempotency_token) do update
        set state      = 'in_progress',
            updated_at = now()
        where v2_register_idempotency.state = 'failed'
      returning state, result
    )
    select state, result into v_idm_state, v_idm_result from claim;

    if not found then
      -- Claim failed → existing row is 'in_progress' or 'completed'.
      select state, result
        into v_idm_state, v_idm_result
        from public.v2_register_idempotency
       where idempotency_token = p_idempotency_token;

      if v_idm_state = 'in_progress' then
        raise exception 'idempotency_in_progress: concurrent call with same token' using errcode = 'P0001';
      end if;

      if v_idm_state = 'completed' and v_idm_result is not null then
        return query
          select
            (r ->> 'product_id')::uuid,
            (r ->> 'sku')::text,
            (r ->> 'group_id')::uuid,
            (r ->> 'row_status')::text
          from jsonb_array_elements(v_idm_result) as r;
        return;
      end if;

      raise exception 'idempotency_claim_failed: state=%', coalesce(v_idm_state, 'null') using errcode = 'P0001';
    end if;
    -- Claimed successfully (fresh INSERT gave state='in_progress'; RETURNING state is always 'in_progress' here).
  end if;

  -- Lock source_record
  select * into v_source
    from public.source_records
   where id = p_source_record_id
   for update;
  if not found then
    raise exception 'source_record_not_found' using errcode = 'P0001';
  end if;

  v_observed        := v_source.observed_values;
  v_title           := nullif(btrim(coalesce(v_observed ->> 'title', '')), '');
  v_description     := nullif(coalesce(v_observed ->> 'description_html', ''), '');
  v_staronemall_url := case when v_source.source_type = 'staronemall' then v_source.source_url else null end;

  v_n := jsonb_array_length(p_variation_options);

  -- Validate SKU uniqueness within this batch
  declare
    sku_set text[];
    sku_i   text;
  begin
    sku_set := array[]::text[];
    for i in 0 .. v_n - 1 loop
      sku_i := btrim(coalesce((p_variation_options -> i) ->> 'sku', ''));
      if sku_i = '' then
        raise exception 'sku_required_for_option_%', i using errcode = 'P0001';
      end if;
      if sku_i = any(sku_set) then
        raise exception 'duplicate_sku_in_batch: %', sku_i using errcode = 'P0001';
      end if;
      sku_set := array_append(sku_set, sku_i);
    end loop;
  end;

  -- Process each option row in a single transaction
  v_group_id := null;

  for i in 0 .. v_n - 1 loop
    v_opt          := p_variation_options -> i;
    v_sku          := btrim(coalesce(v_opt ->> 'sku', ''));
    v_cost_krw     := coalesce((v_opt ->> 'cost_krw')::numeric, (p_card_header_overrides ->> 'cost_krw')::numeric, 0);
    v_weight_g     := coalesce((v_opt ->> 'weight_g')::numeric, (p_card_header_overrides ->> 'weight_g')::numeric, 0);
    v_main_image   := nullif(btrim(coalesce(v_opt ->> 'main_image', '')), '');
    v_extra_images := case
      when jsonb_typeof(v_opt -> 'extra_images') = 'array'
        then array(select jsonb_array_elements_text(v_opt -> 'extra_images'))
      else null
    end;

    -- option_names: array of strings (1 per axis)
    v_option_names := case
      when jsonb_typeof(v_opt -> 'option_names') = 'array'
        then array(select jsonb_array_elements_text(v_opt -> 'option_names'))
      else null
    end;

    -- tier_index: integer array
    v_tier_index := case
      when jsonb_typeof(v_opt -> 'tier_index') = 'array'
        then array(select (jsonb_array_elements(v_opt -> 'tier_index'))::int)
      else null
    end;

    v_collision_mode := coalesce(v_opt ->> 'collision_mode', 'reuse');

    -- Weight validation
    if v_weight_g is null or v_weight_g <= 0 then
      raise exception 'invalid_weight_g for option %', i using errcode = 'P0001';
    end if;

    -- Check existing SKU collision
    select id into v_existing_id
      from public.products
     where products.sku = v_sku;

    if v_existing_id is not null then
      if v_collision_mode = 'overwrite' then
        update public.products
           set product_name           = v_title,
               cost_krw               = v_cost_krw,
               weight_g               = v_weight_g,
               weight_measured_at     = now(),
               cost_updated_at        = now(),
               main_image             = v_main_image,
               extra_images           = v_extra_images,
               description            = v_description,
               staronemall_url        = coalesce(v_staronemall_url, products.staronemall_url),
               lifecycle_state        = p_lifecycle_state,
               variation_tier_names   = p_variation_tier_names,
               variation_option_names = v_option_names,
               variation_tier_index   = v_tier_index,
               updated_at             = now()
         where id = v_existing_id;
        v_product_id := v_existing_id;
      else
        -- reuse: set group_id from existing row if group not yet set
        v_product_id := v_existing_id;
      end if;
    else
      insert into public.products (
        sku, product_name, cost_krw, weight_g,
        weight_measured_at, cost_updated_at,
        main_image, extra_images, description,
        staronemall_url, lifecycle_state,
        variation_tier_names, variation_option_names, variation_tier_index,
        shopee_publish_state,
        inventory, purpose
      ) values (
        v_sku,
        v_title,
        v_cost_krw,
        v_weight_g,
        now(),
        now(),
        v_main_image,
        v_extra_images,
        v_description,
        v_staronemall_url,
        p_lifecycle_state,
        p_variation_tier_names,
        v_option_names,
        v_tier_index,
        'unpublished',
        0,
        'registration'
      )
      returning id into v_product_id;
    end if;

    -- Capture group_id from first row
    if v_first then
      v_group_id := v_product_id;
      v_first    := false;
    end if;
  end loop;

  -- Back-fill product_group_id for all inserted/updated rows in this batch
  for i in 0 .. v_n - 1 loop
    v_sku := btrim(coalesce((p_variation_options -> i) ->> 'sku', ''));
    update public.products
       set product_group_id = v_group_id
     where products.sku = v_sku
       and (product_group_id is null or product_group_id <> v_group_id);
  end loop;

  -- Update source_record status
  update public.source_records
     set status                  = 'published',
         linked_master_product_id = v_group_id,
         reviewed_at              = now(),
         reviewed_by              = v_actor
   where id = p_source_record_id;

  -- Audit log
  insert into public.audit_log (
    entity_type, entity_uuid, source_record_id, product_id,
    actor, action, after_json, reason, batch_id
  ) values (
    'product', v_group_id, p_source_record_id, v_group_id,
    'user:' || v_actor,
    'approve_group',
    jsonb_build_object(
      'group_id',             v_group_id,
      'variation_tier_names', to_json(p_variation_tier_names),
      'option_count',         v_n,
      'lifecycle_state',      p_lifecycle_state
    ),
    'v2_register_variants_group',
    v_source.crawl_run_id
  );

  -- Update idempotency record to completed
  if p_idempotency_token is not null then
    update public.v2_register_idempotency
       set state            = 'completed',
           product_group_id = v_group_id,
           result           = (
             select jsonb_agg(jsonb_build_object(
               'product_id', p2.id,
               'sku',        p2.sku,
               'group_id',   p2.product_group_id,
               'row_status', 'ok'
             ))
             from public.products p2
             where p2.product_group_id = v_group_id
               and p2.sku = any(
                 array(select btrim((p_variation_options -> s) ->> 'sku') from generate_series(0, v_n-1) as s)
               )
           ),
           updated_at       = now()
     where idempotency_token = p_idempotency_token;
  end if;

  -- Return result rows
  return query
    select
      p2.id,
      p2.sku,
      p2.product_group_id,
      'ok'::text
    from public.products p2
    where p2.product_group_id = v_group_id
      and p2.sku = any(
        array(select btrim((p_variation_options -> s) ->> 'sku') from generate_series(0, v_n-1) as s)
      )
    order by p2.variation_tier_index;

exception when others then
  if p_idempotency_token is not null then
    update public.v2_register_idempotency
       set state      = 'failed',
           result     = jsonb_build_object('error', sqlerrm),
           updated_at = now()
     where idempotency_token = p_idempotency_token;
  end if;
  raise;
end;
$$;

grant execute on function public.promote_source_group_to_products(
  uuid, text[], jsonb, text, jsonb, uuid
) to authenticated;

-- ─────────────────────────────────────────────────────────
-- promote_source_to_product: replace with atomic claim (solo RPC)
-- ─────────────────────────────────────────────────────────

drop function if exists public.promote_source_to_product(uuid, text, numeric, text, text, numeric, boolean, uuid);

create or replace function public.promote_source_to_product(
  p_source_record_id  uuid,
  p_sku               text,
  p_weight_g          numeric,
  p_lifecycle_state   text    default 'pre_order',
  p_option_name       text    default null,
  p_cost_krw_override numeric default null,
  p_overwrite         boolean default false,
  p_idempotency_token uuid    default null
) returns table (product_id uuid, sku text)
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_source     source_records%rowtype;
  v_observed   jsonb;
  v_product_id uuid;
  v_existing_id uuid;
  v_actor      text;
  v_cost_krw   numeric;
  v_title      text;
  v_option     text;
  v_main_image text;
  v_extra_images text[];
  v_description  text;
  v_idm_state  text;
  v_idm_result jsonb;
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

  -- §6-2: idempotency — atomic claim (P0 #1 fix; null token = legacy path, no check)
  if p_idempotency_token is not null then
    with claim as (
      insert into public.v2_register_idempotency
        (idempotency_token, source_record_id, state)
      values
        (p_idempotency_token, p_source_record_id, 'in_progress')
      on conflict (idempotency_token) do update
        set state      = 'in_progress',
            updated_at = now()
        where v2_register_idempotency.state = 'failed'
      returning state, result
    )
    select state, result into v_idm_state, v_idm_result from claim;

    if not found then
      -- Claim failed → existing row is 'in_progress' or 'completed'.
      select state, result
        into v_idm_state, v_idm_result
        from public.v2_register_idempotency
       where idempotency_token = p_idempotency_token;

      if v_idm_state = 'in_progress' then
        raise exception 'idempotency_in_progress' using errcode = 'P0001';
      end if;

      if v_idm_state = 'completed' and v_idm_result is not null then
        return query
          select (v_idm_result ->> 'product_id')::uuid, (v_idm_result ->> 'sku')::text;
        return;
      end if;

      raise exception 'idempotency_claim_failed: state=%', coalesce(v_idm_state, 'null') using errcode = 'P0001';
    end if;
  end if;

  select * into v_source
    from public.source_records
   where id = p_source_record_id
   for update;
  if not found then
    raise exception 'source_record_not_found' using errcode = 'P0001';
  end if;

  v_observed     := v_source.observed_values;
  v_cost_krw     := coalesce(p_cost_krw_override, (v_observed ->> 'price_krw')::numeric, 0);
  v_title        := nullif(btrim(coalesce(v_observed ->> 'title', '')), '');
  v_option       := nullif(btrim(coalesce(p_option_name, '')), '');
  v_main_image   := nullif(coalesce(v_observed -> 'main_image_urls' ->> 0, ''), '');
  v_extra_images := case
    when jsonb_typeof(v_observed -> 'detail_image_urls') = 'array'
      then array(select jsonb_array_elements_text(v_observed -> 'detail_image_urls'))
    else null
  end;
  v_description  := nullif(coalesce(v_observed ->> 'description_html', ''), '');

  select id into v_existing_id
    from public.products
   where products.sku = btrim(p_sku);

  if v_existing_id is not null then
    if p_overwrite then
      update public.products
         set product_name    = v_title,
             option_name     = v_option,
             cost_krw        = v_cost_krw,
             weight_g        = p_weight_g,
             weight_measured_at = now(),
             cost_updated_at = now(),
             main_image      = v_main_image,
             extra_images    = v_extra_images,
             description     = v_description,
             staronemall_url = case when v_source.source_type = 'staronemall' then v_source.source_url else staronemall_url end,
             lifecycle_state = p_lifecycle_state,
             updated_at      = now()
       where id = v_existing_id;
    end if;
    update public.source_records
       set status                   = 'published',
           linked_master_product_id = v_existing_id,
           reviewed_at              = now(),
           reviewed_by              = v_actor
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
    if p_idempotency_token is not null then
      update public.v2_register_idempotency
         set state = 'completed',
             product_group_id = v_existing_id,
             result = jsonb_build_object('product_id', v_existing_id, 'sku', btrim(p_sku)),
             updated_at = now()
       where idempotency_token = p_idempotency_token;
    end if;
    return query select v_existing_id, btrim(p_sku);
    return;
  end if;

  insert into public.products (
    sku, product_name, option_name, cost_krw, weight_g,
    weight_measured_at, cost_updated_at,
    main_image, extra_images, description,
    staronemall_url, lifecycle_state,
    shopee_publish_state,
    inventory, purpose
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
    'unpublished',
    0,
    'registration'
  )
  returning id into v_product_id;

  -- self-reference product_group_id for solo products
  update public.products
     set product_group_id = v_product_id
   where id = v_product_id;

  update public.source_records
     set status                   = 'published',
         linked_master_product_id = v_product_id,
         reviewed_at              = now(),
         reviewed_by              = v_actor
   where id = p_source_record_id;

  insert into public.audit_log (
    entity_type, entity_uuid, source_record_id, product_id,
    actor, action, after_json, reason, batch_id
  ) values (
    'product', v_product_id, p_source_record_id, v_product_id,
    'user:' || v_actor, 'approve',
    jsonb_build_object('sku', p_sku, 'lifecycle_state', p_lifecycle_state, 'weight_g', p_weight_g, 'cost_krw', v_cost_krw),
    'bulk_register_auto_promote',
    v_source.crawl_run_id
  );

  if p_idempotency_token is not null then
    update public.v2_register_idempotency
       set state = 'completed',
           product_group_id = v_product_id,
           result = jsonb_build_object('product_id', v_product_id, 'sku', btrim(p_sku)),
           updated_at = now()
     where idempotency_token = p_idempotency_token;
  end if;

  return query select v_product_id, btrim(p_sku);

exception when others then
  if p_idempotency_token is not null then
    update public.v2_register_idempotency
       set state = 'failed',
           result = jsonb_build_object('error', sqlerrm),
           updated_at = now()
     where idempotency_token = p_idempotency_token;
  end if;
  raise;
end;
$$;

grant execute on function public.promote_source_to_product(
  uuid, text, numeric, text, text, numeric, boolean, uuid
) to authenticated;

-- 5-arg shim (backward compat for any older callers): re-create pointing to new 8-arg
drop function if exists public.promote_source_to_product(uuid, text, numeric, text, text);

create or replace function public.promote_source_to_product(
  p_source_record_id  uuid,
  p_sku               text,
  p_weight_g          numeric,
  p_lifecycle_state   text default 'pre_order',
  p_option_name       text default null
) returns table (product_id uuid, sku text)
language sql security definer
set search_path = public, pg_temp as $$
  select * from public.promote_source_to_product(
    p_source_record_id,
    p_sku,
    p_weight_g,
    p_lifecycle_state,
    p_option_name,
    null,   -- p_cost_krw_override
    false,  -- p_overwrite
    null    -- p_idempotency_token
  );
$$;

grant execute on function public.promote_source_to_product(uuid, text, numeric, text, text) to authenticated;
