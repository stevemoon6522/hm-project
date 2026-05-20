-- Step 1c (plan v2.2 §B.3 + §E.1): platform_listings table for non-Shopee
-- platforms + platform_listing_rollups view that powers the 5-LED column
-- in 상품 목록. variants table deferred (operator msg #402 — lazy
-- reclassification).

create table if not exists public.platform_listings (
  id uuid primary key default gen_random_uuid(),
  master_product_id uuid not null references public.products(id) on delete cascade,
  platform text not null check (platform in ('shopee','joom','qoo10','ebay','alibaba')),
  shop_id text,
  country text,
  platform_item_id text,
  listing_status text not null default 'not_listed'
    check (listing_status in ('not_listed','draft','pending','listed','error','rejected','paused','banned')),
  last_publish_request_id uuid,
  last_payload jsonb,
  last_sync_at timestamptz,
  error_msg text,
  error_code text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists platform_listings_dispatcher_uniq
  on public.platform_listings
     (master_product_id, platform, coalesce(shop_id, ''), coalesce(country, ''))
  where deleted_at is null;

create unique index if not exists platform_listings_remote_uniq
  on public.platform_listings (platform, shop_id, platform_item_id)
  where platform_item_id is not null and deleted_at is null;

create index if not exists platform_listings_master_idx
  on public.platform_listings (master_product_id, platform);

alter table public.platform_listings enable row level security;

drop policy if exists "platform_listings readable by authenticated" on public.platform_listings;
create policy "platform_listings readable by authenticated"
  on public.platform_listings for select
  to public
  using (auth.role() = 'authenticated');

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
    coalesce(pl.country, pl.shop_id, pl.platform),
    jsonb_build_object(
      'status', pl.listing_status,
      'platform_item_id', pl.platform_item_id,
      'shop_id', pl.shop_id,
      'last_error', pl.error_msg
    )
  ) as per_shop_detail
from public.platform_listings pl
where pl.deleted_at is null and pl.platform <> 'shopee'
group by pl.master_product_id, pl.platform;

grant select on public.platform_listing_rollups to authenticated;
