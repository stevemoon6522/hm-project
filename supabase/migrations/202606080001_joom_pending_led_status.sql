-- Keep Joom LEDs from treating non-active legacy products.joom_* mappings as listed.
--
-- Joom API docs define state=archived as removed and hasActiveVersion=false as
-- not customer-available. The legacy products.joom_* fallback cannot store
-- hasActiveVersion directly, so it must at least respect joom_status and
-- joom_mapping_status when deciding rollup color.

create or replace view public.platform_listing_rollups as
select
  psl.product_id as master_product_id,
  'shopee'::text as platform,
  count(*) filter (where psl.status in ('listed','mapped') and psl.shop_item_id is not null) as listed_count,
  count(*) filter (where psl.status in ('pending','draft')) as pending_count,
  count(*) filter (where psl.status = 'error') as error_count,
  count(*) as total_count,
  jsonb_object_agg(
    coalesce(psl.region, ''),
    jsonb_build_object(
      'status', psl.status,
      'shop_id', (select ss.shop_id from public.shopee_shops ss where ss.region = psl.region limit 1),
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
) ns
group by ns.master_product_id, ns.platform;

grant select on public.platform_listing_rollups to authenticated;
