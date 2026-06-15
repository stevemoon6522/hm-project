-- Account-aware Shopee publishing.
--
-- Local docs referenced:
-- - C:\dev\api-refs\marketplaces\shopee\docs_ai_guides\guides\regional\krsc-api-integration-guide.md
-- - C:\dev\api-refs\marketplaces\shopee\docs_ai_guides\common\token_rules.json
-- - C:\dev\api-refs\marketplaces\shopee\docs_ai_guides\guides\global_product\publishing-global-product.md
-- KRSC tokens are independent per merchant/shop, so V2 must namespace tokens,
-- shop rows, and listing mappings by seller account.

create table if not exists public.shopee_account_profiles (
  account_key text primary key,
  display_name text not null,
  main_account_id bigint,
  merchant_id bigint,
  layer_asset_path text not null default 'shop-overlay-layer.png',
  enabled_regions text[] not null default array['SG','TW','TH','MY','PH','BR']::text[],
  status text not null default 'active',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopee_account_profiles_key_check
    check (account_key ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  constraint shopee_account_profiles_status_check
    check (status in ('active','inactive','pending','banned'))
);

drop trigger if exists shopee_account_profiles_touch_updated_at on public.shopee_account_profiles;
create trigger shopee_account_profiles_touch_updated_at
before update on public.shopee_account_profiles
for each row execute function public.sd_touch_updated_at();

insert into public.shopee_account_profiles (
  account_key,
  display_name,
  main_account_id,
  layer_asset_path,
  enabled_regions,
  notes
) values (
  'starphotocard',
  'starphotocard',
  1842717,
  'shop-overlay-layer.png',
  array['SG','TW','TH','MY','PH','BR']::text[],
  'Existing KRSC main merchant. Backfilled as the default account for legacy rows.'
) on conflict (account_key) do update
set
  display_name = excluded.display_name,
  main_account_id = coalesce(public.shopee_account_profiles.main_account_id, excluded.main_account_id),
  layer_asset_path = coalesce(nullif(public.shopee_account_profiles.layer_asset_path, ''), excluded.layer_asset_path),
  enabled_regions = coalesce(public.shopee_account_profiles.enabled_regions, excluded.enabled_regions),
  updated_at = now();

alter table public.shopee_tokens
  add column if not exists account_key text not null default 'starphotocard';

update public.shopee_tokens
   set account_key = 'starphotocard'
 where account_key is null or account_key = '';

do $$
begin
  if exists (
    select 1
      from pg_constraint
     where conrelid = 'public.shopee_tokens'::regclass
       and conname = 'shopee_tokens_pkey'
  ) then
    alter table public.shopee_tokens drop constraint shopee_tokens_pkey;
  end if;
end $$;

alter table public.shopee_tokens
  add constraint shopee_tokens_pkey primary key (account_key, region);

create index if not exists idx_shopee_tokens_region
  on public.shopee_tokens (region);

alter table public.shopee_shops
  add column if not exists account_key text not null default 'starphotocard';

update public.shopee_shops
   set account_key = 'starphotocard'
 where account_key is null or account_key = '';

create index if not exists idx_shopee_shops_account_region_status
  on public.shopee_shops (account_key, region, status);

create unique index if not exists shopee_shops_account_shop_uidx
  on public.shopee_shops (account_key, shop_id);

alter table public.product_shopee_listings
  add column if not exists account_key text not null default 'starphotocard';

update public.product_shopee_listings
   set account_key = 'starphotocard'
 where account_key is null or account_key = '';

do $$
begin
  if exists (
    select 1
      from pg_constraint
     where conrelid = 'public.product_shopee_listings'::regclass
       and conname = 'product_shopee_listings_pkey'
  ) then
    alter table public.product_shopee_listings drop constraint product_shopee_listings_pkey;
  end if;
end $$;

alter table public.product_shopee_listings
  add constraint product_shopee_listings_pkey primary key (product_id, account_key, region);

create index if not exists idx_product_shopee_listings_account_region
  on public.product_shopee_listings (account_key, region);

create index if not exists idx_product_shopee_listings_account_global_item
  on public.product_shopee_listings (account_key, global_item_id);

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
      when p.joom_mapping_status = 'mapping_failed' then 'error'
      else 'listed'
    end as listing_status,
    coalesce(p.joom_mapping_status, 'mapped') as mapping_status,
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

alter table public.shopee_account_profiles enable row level security;

drop policy if exists "shopee_account_profiles public read" on public.shopee_account_profiles;
create policy "shopee_account_profiles public read"
  on public.shopee_account_profiles for select
  using (true);

grant select on public.shopee_account_profiles to anon, authenticated;
