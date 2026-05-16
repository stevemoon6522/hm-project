create or replace function public.v2_daily_close_summary(
  p_active_regions text[] default array['SG','TW','TH','MY','PH'],
  p_stale_sync_hours integer default 72,
  p_stale_cost_days integer default 14,
  p_price_delta_risk_pct numeric default 50
)
returns jsonb
language sql
security definer
set search_path = public
as $$
with
products_base as (
  select
    p.id,
    lower(coalesce(p.lifecycle_state, '')) as lifecycle_state,
    p.cost_krw,
    p.weight_g,
    p.cost_updated_at,
    p.created_at
  from products p
),
price_mult as (
  select * from (
    values
      ('SG'::text, 0.014::numeric),
      ('TW'::text, 0.30::numeric),
      ('TH'::text, 0.40::numeric),
      ('MY'::text, 0.04::numeric),
      ('PH'::text, 0.60::numeric),
      ('BR'::text, 0.07::numeric)
  ) as t(region, mult)
),
listings_base as (
  select
    l.product_id,
    upper(coalesce(l.region, '')) as region,
    l.shop_item_id,
    l.last_synced_price,
    l.last_synced_at
  from product_shopee_listings l
  where upper(coalesce(l.region, '')) = any (p_active_regions)
),
pricing_risk as (
  select count(distinct pb.id)::bigint as cnt
  from products_base pb
  left join listings_base lb on lb.product_id = pb.id
  left join price_mult pm on pm.region = lb.region
  where
    coalesce(pb.cost_krw, 0) <= 0
    or (
      pb.lifecycle_state = 'ready_stock'
      and coalesce(pb.cost_updated_at, pb.created_at) < now() - make_interval(days => p_stale_cost_days)
    )
    or (
      lb.last_synced_price is not null
      and lb.last_synced_price > 0
      and pm.mult is not null
      and abs((round((pb.cost_krw::numeric * pm.mult)::numeric, 2) - lb.last_synced_price::numeric) / lb.last_synced_price::numeric * 100.0) >= p_price_delta_risk_pct
    )
),
drift as (
  select
    count(*)::bigint as cnt,
    coalesce(
      jsonb_object_agg(region, region_count order by region),
      '{}'::jsonb
    ) as by_region
  from (
    select
      lb.region,
      count(*)::bigint as region_count
    from listings_base lb
    where
      lb.shop_item_id is null
      or lb.last_synced_at is null
      or lb.last_synced_at < now() - make_interval(hours => p_stale_sync_hours)
    group by lb.region
  ) s
),
failed_batch as (
  select count(*)::bigint as cnt
  from shopee_mutation_log ml
  where ml.actor = 'v2-wizard' and ml.status = 'error'
),
margin_flag as (
  select exists (
    select 1
    from country_settings cs
    where cs.margin_formula is not null and btrim(cs.margin_formula) <> ''
  ) as has_margin_formula
)
select jsonb_build_object(
  'failed_batch_remaining_count', coalesce((select cnt from failed_batch), 0),
  'approval_pending_count', 0,
  'products_total', coalesce((select count(*)::bigint from products_base), 0),
  'pre_order_count', coalesce((select count(*)::bigint from products_base where lifecycle_state = 'pre_order'), 0),
  'missing_cost_count', coalesce((select count(*)::bigint from products_base where coalesce(cost_krw, 0) <= 0), 0),
  'missing_weight_count', coalesce((select count(*)::bigint from products_base where coalesce(weight_g, 0) <= 0), 0),
  'stale_cost_count', coalesce((select count(*)::bigint from products_base where lifecycle_state = 'ready_stock' and coalesce(cost_updated_at, created_at) < now() - make_interval(days => p_stale_cost_days)), 0),
  'pricing_risk_count', coalesce((select cnt from pricing_risk), 0),
  'sync_drift_count', coalesce((select cnt from drift), 0),
  'sync_drift_by_region', coalesce((select by_region from drift), '{}'::jsonb),
  'has_margin_formula', coalesce((select has_margin_formula from margin_flag), false),
  'source_mode', 'rpc_security_definer',
  'source_note', 'Bypasses table RLS for read-only aggregate metrics only.'
);
$$;

revoke all on function public.v2_daily_close_summary(text[], integer, integer, numeric) from public;
grant execute on function public.v2_daily_close_summary(text[], integer, integer, numeric) to anon, authenticated;
