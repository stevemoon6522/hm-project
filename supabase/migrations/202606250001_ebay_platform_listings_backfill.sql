-- Backfill eBay legacy product mapping columns into platform_listings.
-- Source columns include products.ebay_item_id/products.ebay_offer_id from
-- ebay-bridge registrations that predate the standard platform_listings write.

insert into public.platform_listings (
  master_product_id,
  platform,
  shop_id,
  country,
  platform_item_id,
  external_variant_id,
  external_sku,
  title,
  currency,
  remote_price,
  listing_status,
  mapping_status,
  publish_origin,
  last_payload,
  last_sync_at,
  last_seen_at,
  error_msg,
  error_code
)
select
  p.id,
  'ebay',
  null,
  coalesce(nullif(p.ebay_marketplace_id, ''), 'EBAY_US'),
  p.ebay_item_id,
  coalesce(nullif(p.ebay_offer_id, ''), nullif(p.ebay_sku, ''), nullif(p.sku, '')),
  coalesce(nullif(p.ebay_sku, ''), nullif(p.sku, '')),
  p.product_name,
  'USD',
  p.ebay_last_synced_price,
  'listed',
  'mapped',
  'v2_created',
  jsonb_build_object(
    'legacy_source', 'products.ebay_columns',
    'ebay_status', p.ebay_status,
    'ebay_listing_mode', p.ebay_listing_mode,
    'ebay_inventory_group_key', p.ebay_inventory_group_key,
    'ebay_variation_axis', p.ebay_variation_axis,
    'ebay_variation_value', p.ebay_variation_value
  ),
  coalesce(p.ebay_last_synced_at, p.ebay_published_at, p.updated_at),
  coalesce(p.ebay_last_synced_at, p.ebay_published_at, p.updated_at),
  null,
  null
from public.products p
where p.ebay_item_id is not null
  and upper(coalesce(p.ebay_status, '')) in ('PUBLISHED', 'MAPPED', 'LISTED')
  and not exists (
    select 1
    from public.platform_listings pl
    where pl.master_product_id = p.id
      and pl.platform = 'ebay'
      and coalesce(pl.country, '') = coalesce(nullif(p.ebay_marketplace_id, ''), 'EBAY_US')
      and pl.deleted_at is null
  )
on conflict do nothing;

create or replace view public.platform_listing_rollups as
select
  psl.product_id as master_product_id,
  'shopee'::text as platform,
  count(*) filter (where psl.status in ('listed','mapped') and psl.shop_item_id is not null) as listed_count,
  count(*) filter (where psl.status in ('pending','draft')) as pending_count,
  count(*) filter (where psl.status = 'error') as error_count,
  count(*) as total_count,
  jsonb_object_agg(
    coalesce(psl.account_key, 'starphotocard') || ':' || coalesce(psl.region, ''),
    jsonb_build_object(
      'account_key', coalesce(psl.account_key, 'starphotocard'),
      'status', psl.status,
      'shop_id', psl.shop_id,
      'shop_item_id', psl.shop_item_id,
      'shop_model_id', psl.shop_model_id,
      'global_item_id', psl.global_item_id,
      'last_error', psl.last_error,
      'published_at', psl.published_at,
      'last_synced_price', psl.last_synced_price,
      'last_synced_at', psl.last_synced_at,
      'publish_origin', 'remote_imported'
    )
  ) as per_shop_detail
from public.product_shopee_listings psl
group by psl.product_id

union all

select
  ns.master_product_id,
  ns.platform,
  count(*) filter (where ns.listing_status in ('listed','paused')) as listed_count,
  count(*) filter (where ns.listing_status in ('pending','draft')) as pending_count,
  count(*) filter (where ns.listing_status in ('error','rejected')) as error_count,
  count(*) as total_count,
  jsonb_object_agg(
    coalesce(ns.shop_id, ns.country, ns.platform || '_default') || ':' || coalesce(ns.external_variant_id, ''),
    jsonb_build_object(
      'status', ns.listing_status,
      'mapping_status', ns.mapping_status,
      'publish_origin', ns.publish_origin,
      'platform_item_id', ns.platform_item_id,
      'external_variant_id', ns.external_variant_id,
      'external_sku', ns.external_sku,
      'shop_id', ns.shop_id,
      'country', ns.country,
      'currency', ns.currency,
      'remote_price', ns.remote_price,
      'remote_stock', ns.remote_stock,
      'last_error', ns.error_msg,
      'last_seen_at', ns.last_seen_at
    )
  ) as per_shop_detail
from (
  select
    pl.master_product_id,
    pl.platform,
    pl.shop_id,
    pl.country,
    pl.platform_item_id,
    pl.external_variant_id,
    pl.external_sku,
    pl.title,
    pl.currency,
    pl.remote_price,
    pl.remote_stock,
    pl.listing_status,
    pl.mapping_status,
    pl.publish_origin,
    pl.last_seen_at,
    pl.error_msg
  from public.platform_listings pl
  where pl.deleted_at is null and pl.platform <> 'shopee'

  union all

  select
    p.id as master_product_id,
    'joom'::text as platform,
    null::text as shop_id,
    'GLOBAL'::text as country,
    p.joom_product_id as platform_item_id,
    p.joom_variant_id as external_variant_id,
    p.sku as external_sku,
    p.product_name as title,
    p.joom_currency as currency,
    p.joom_last_synced_price as remote_price,
    null::numeric as remote_stock,
    case
      when lower(coalesce(p.joom_status, '')) = 'archived' then 'not_listed'
      when lower(coalesce(p.joom_mapping_status, '')) in ('mapping_failed', 'error') then 'error'
      when lower(coalesce(p.joom_status, '')) in ('rejected', 'banned') then 'rejected'
      when lower(coalesce(p.joom_status, '')) in ('disabledbyjoom', 'disabledbymerchant') then 'paused'
      when lower(coalesce(p.joom_mapping_status, '')) in ('pending', 'draft')
        or lower(coalesce(p.joom_status, '')) in ('pending', 'locked') then 'pending'
      else 'listed'
    end as listing_status,
    coalesce(nullif(p.joom_mapping_status, ''), 'mapped') as mapping_status,
    'remote_imported'::text as publish_origin,
    coalesce(p.joom_last_synced_at, p.joom_published_at, p.updated_at) as last_seen_at,
    p.joom_mapping_error as error_msg
  from public.products p
  where p.joom_product_id is not null
    and not exists (
      select 1
      from public.platform_listings pl
      where pl.master_product_id = p.id
        and pl.platform = 'joom'
        and pl.deleted_at is null
    )

  union all

  select
    p.id as master_product_id,
    'ebay'::text as platform,
    null::text as shop_id,
    coalesce(nullif(p.ebay_marketplace_id, ''), 'EBAY_US') as country,
    p.ebay_item_id as platform_item_id,
    coalesce(nullif(p.ebay_offer_id, ''), nullif(p.ebay_sku, ''), nullif(p.sku, '')) as external_variant_id,
    coalesce(nullif(p.ebay_sku, ''), nullif(p.sku, '')) as external_sku,
    p.product_name as title,
    'USD'::text as currency,
    p.ebay_last_synced_price as remote_price,
    null::numeric as remote_stock,
    'listed'::text as listing_status,
    'mapped'::text as mapping_status,
    'v2_created'::text as publish_origin,
    coalesce(p.ebay_last_synced_at, p.ebay_published_at, p.updated_at) as last_seen_at,
    null::text as error_msg
  from public.products p
  where p.ebay_item_id is not null
    and upper(coalesce(p.ebay_status, '')) in ('PUBLISHED', 'MAPPED', 'LISTED')
    and not exists (
      select 1
      from public.platform_listings pl
      where pl.master_product_id = p.id
        and pl.platform = 'ebay'
        and pl.deleted_at is null
    )
) ns
group by ns.master_product_id, ns.platform;

grant select on public.platform_listing_rollups to authenticated;

create or replace view public.platform_listing_coverage as
select
  c.master_product_id as product_id,
  p.sku,
  p.product_name,
  p.option_name,
  p.lifecycle_state,
  c.platform,
  (case when c.coverage_status in ('listed', 'mapped', 'mapped_global') then 1 else 0 end)::bigint as listed_count,
  (case when c.coverage_status in ('draft', 'pending') then 1 else 0 end)::bigint as pending_count,
  (case when c.coverage_status in ('error', 'rejected', 'banned') then 1 else 0 end)::bigint as error_count,
  (case when c.coverage_status <> 'not_listed' then 1 else 0 end)::bigint as total_count,
  case
    when c.coverage_status in ('listed', 'mapped', 'mapped_global') then 'mapped'
    when c.coverage_status in ('draft', 'pending') then 'pending'
    when c.coverage_status in ('error', 'rejected', 'banned') then 'error'
    else 'missing'
  end as coverage_status,
  case
    when c.coverage_status = 'not_listed' then '{}'::jsonb
    else jsonb_build_object(
      coalesce(c.country, c.shop_id, c.platform),
      jsonb_build_object(
        'status', c.coverage_status,
        'platform_item_id', c.platform_item_id,
        'external_variant_id', c.external_variant_id,
        'external_sku', c.external_sku,
        'shop_id', c.shop_id,
        'country', c.country
      )
    )
  end as per_shop_detail
from public.sku_platform_coverage c
join public.products p on p.id = c.master_product_id;

grant select on public.platform_listing_coverage to authenticated;
