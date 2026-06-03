-- Controlled write path for price dry-run snapshots.
--
-- Browser clients do not get table INSERT policies. They can only append
-- validated dry-run evidence through this SECURITY DEFINER RPC.

create or replace function public.record_price_dry_run_batch(
  p_actor text,
  p_reason text,
  p_platform_filter text[] default array[]::text[],
  p_summary_json jsonb default '{}'::jsonb,
  p_snapshots jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch_id uuid;
  v_snapshot jsonb;
  v_snapshot_id uuid;
  v_count int;
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'v2-catalog');
  v_platform text;
  v_sku text;
  v_currency text;
  v_computed_price numeric;
  v_final_price numeric;
begin
  if jsonb_typeof(coalesce(p_snapshots, '[]'::jsonb)) <> 'array' then
    raise exception 'p_snapshots must be a JSON array';
  end if;

  v_count := jsonb_array_length(coalesce(p_snapshots, '[]'::jsonb));
  if v_count = 0 then
    raise exception 'at least one price snapshot is required';
  end if;
  if v_count > 500 then
    raise exception 'too many price snapshots in one batch: %', v_count;
  end if;

  insert into public.price_batches (
    batch_type,
    status,
    trigger_source,
    actor,
    reason,
    dry_run,
    platform_filter,
    summary_json,
    started_at,
    completed_at
  ) values (
    'dry_run',
    'completed',
    'manual',
    v_actor,
    nullif(btrim(p_reason), ''),
    true,
    coalesce(p_platform_filter, array[]::text[]),
    coalesce(p_summary_json, '{}'::jsonb),
    now(),
    now()
  )
  returning id into v_batch_id;

  for v_snapshot in select value from jsonb_array_elements(p_snapshots)
  loop
    v_platform := lower(btrim(coalesce(v_snapshot ->> 'platform', '')));
    v_sku := btrim(coalesce(v_snapshot ->> 'sku', ''));
    v_currency := upper(btrim(coalesce(v_snapshot ->> 'currency', '')));
    v_computed_price := nullif(v_snapshot ->> 'computed_platform_price', '')::numeric;
    v_final_price := coalesce(nullif(v_snapshot ->> 'final_platform_price', '')::numeric, v_computed_price);

    if v_platform not in ('shopee', 'joom', 'qoo10', 'ebay') then
      raise exception 'unsupported price snapshot platform: %', v_platform;
    end if;
    if v_sku = '' then
      raise exception 'price snapshot sku is required';
    end if;
    if v_currency = '' then
      raise exception 'price snapshot currency is required';
    end if;
    if v_computed_price is null or v_final_price is null then
      raise exception 'computed/final price is required for sku %', v_sku;
    end if;

    insert into public.price_snapshots (
      batch_id,
      product_id,
      platform_listing_id,
      platform,
      region,
      country,
      shop_id,
      sku,
      currency,
      cost_krw,
      weight_g,
      exchange_rate,
      fee_model,
      formula_key,
      rule_version,
      rounding_rule,
      previous_platform_price,
      computed_platform_price,
      final_platform_price,
      margin_krw,
      margin_pct,
      guardrail_status,
      guardrail_reasons,
      snapshot_status,
      remote_before,
      request_payload,
      response_payload
    ) values (
      v_batch_id,
      nullif(v_snapshot ->> 'product_id', '')::uuid,
      nullif(v_snapshot ->> 'platform_listing_id', '')::uuid,
      v_platform,
      nullif(btrim(coalesce(v_snapshot ->> 'region', '')), ''),
      nullif(btrim(coalesce(v_snapshot ->> 'country', '')), ''),
      nullif(btrim(coalesce(v_snapshot ->> 'shop_id', '')), ''),
      v_sku,
      v_currency,
      nullif(v_snapshot ->> 'cost_krw', '')::numeric,
      nullif(v_snapshot ->> 'weight_g', '')::numeric,
      nullif(v_snapshot ->> 'exchange_rate', '')::numeric,
      case when jsonb_typeof(v_snapshot -> 'fee_model') = 'object' then v_snapshot -> 'fee_model' else '{}'::jsonb end,
      nullif(btrim(coalesce(v_snapshot ->> 'formula_key', '')), ''),
      nullif(btrim(coalesce(v_snapshot ->> 'rule_version', '')), ''),
      nullif(btrim(coalesce(v_snapshot ->> 'rounding_rule', '')), ''),
      nullif(v_snapshot ->> 'previous_platform_price', '')::numeric,
      v_computed_price,
      v_final_price,
      nullif(v_snapshot ->> 'margin_krw', '')::numeric,
      nullif(v_snapshot ->> 'margin_pct', '')::numeric,
      coalesce(nullif(btrim(v_snapshot ->> 'guardrail_status'), ''), 'pass'),
      coalesce(
        array(select jsonb_array_elements_text(v_snapshot -> 'guardrail_reasons')),
        array[]::text[]
      ),
      'computed',
      case when jsonb_typeof(v_snapshot -> 'remote_before') = 'object' then v_snapshot -> 'remote_before' else '{}'::jsonb end,
      case when jsonb_typeof(v_snapshot -> 'request_payload') = 'object' then v_snapshot -> 'request_payload' else '{}'::jsonb end,
      '{}'::jsonb
    )
    returning id into v_snapshot_id;

    insert into public.audit_log (
      entity_type,
      entity_uuid,
      product_id,
      price_snapshot_id,
      actor,
      action,
      after_json,
      reason,
      batch_id
    ) values (
      'price_snapshot',
      v_snapshot_id,
      nullif(v_snapshot ->> 'product_id', '')::uuid,
      v_snapshot_id,
      v_actor,
      'create',
      jsonb_build_object(
        'batch_id', v_batch_id,
        'platform', v_platform,
        'sku', v_sku,
        'dry_run', true,
        'final_platform_price', v_final_price
      ),
      nullif(btrim(p_reason), ''),
      v_batch_id
    );
  end loop;

  return v_batch_id;
end;
$$;

revoke all on function public.record_price_dry_run_batch(text, text, text[], jsonb, jsonb) from public;
grant execute on function public.record_price_dry_run_batch(text, text, text[], jsonb, jsonb) to authenticated;
