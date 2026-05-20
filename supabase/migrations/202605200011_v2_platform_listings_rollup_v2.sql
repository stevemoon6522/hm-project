-- Codex P0 fixes (review 2026-05-20):
-- (1) Shopee jsonb_build_object now includes shop_id so the banned-shop
--     overlay can actually fire when product_shopee_listings.region maps
--     to legacy BR 1002269093.
-- (2) Non-Shopee jsonb_object_agg now keys by shop_id (with country as
--     payload field) so two shops in the same country can't silently
--     overwrite each other.

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
      'global_item_id', psl.global_item_id,
      'last_error', psl.last_error,
      'published_at', psl.published_at
    )
  ) as per_shop_detail
from public.product_shopee_listings psl
group by psl.product_id
union all
select
  pl.master_product_id,
  pl.platform,
  count(*) filter (where pl.listing_status = 'listed') as listed_count,
  count(*) filter (where pl.listing_status in ('pending','draft')) as pending_count,
  count(*) filter (where pl.listing_status in ('error','rejected')) as error_count,
  count(*) as total_count,
  jsonb_object_agg(
    coalesce(pl.shop_id, pl.country, pl.platform || '_default'),
    jsonb_build_object(
      'status', pl.listing_status,
      'platform_item_id', pl.platform_item_id,
      'shop_id', pl.shop_id,
      'country', pl.country,
      'last_error', pl.error_msg
    )
  ) as per_shop_detail
from public.platform_listings pl
where pl.deleted_at is null and pl.platform <> 'shopee'
group by pl.master_product_id, pl.platform;

grant select on public.platform_listing_rollups to authenticated;
