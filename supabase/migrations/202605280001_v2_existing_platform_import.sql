-- V2 existing platform listing import foundation.
-- Goal: absorb listings that already exist on Shopee/Joom/Qoo10/Alibaba/eBay
-- without publishing duplicates, then use coverage gaps to drive expansion.

create extension if not exists pgcrypto;

create table if not exists public.platform_listing_snapshots (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('shopee','joom','qoo10','ebay','alibaba')),
  market text,
  account_id text,
  external_product_id text not null,
  external_variant_id text,
  sku text,
  title text,
  currency text,
  remote_price numeric,
  remote_stock numeric,
  listing_status text,
  match_status text not null default 'unmatched'
    check (match_status in ('unmatched','auto_matched','needs_review','mapped','ignored','duplicate_candidate')),
  matched_product_id uuid references public.products(id) on delete set null,
  confidence numeric,
  raw_payload jsonb not null default '{}'::jsonb,
  imported_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists platform_listing_snapshots_remote_uniq
  on public.platform_listing_snapshots
    (platform, coalesce(account_id, ''), coalesce(market, ''), external_product_id, coalesce(external_variant_id, ''));

create index if not exists platform_listing_snapshots_sku_idx
  on public.platform_listing_snapshots (platform, sku);

create index if not exists platform_listing_snapshots_match_idx
  on public.platform_listing_snapshots (match_status, platform, last_seen_at desc);

drop trigger if exists platform_listing_snapshots_touch_updated_at on public.platform_listing_snapshots;
create trigger platform_listing_snapshots_touch_updated_at
before update on public.platform_listing_snapshots
for each row execute function public.sd_touch_updated_at();

alter table public.platform_listing_snapshots enable row level security;

drop policy if exists "platform_listing_snapshots readable by authenticated" on public.platform_listing_snapshots;
create policy "platform_listing_snapshots readable by authenticated"
  on public.platform_listing_snapshots for select
  to public
  using (auth.role() = 'authenticated');

grant select on public.platform_listing_snapshots to authenticated;

create table if not exists public.platform_listing_match_candidates (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.platform_listing_snapshots(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  match_method text not null default 'sku_exact'
    check (match_method in ('sku_exact','sku_normalized','title_option','image','manual','other')),
  confidence numeric not null default 0,
  status text not null default 'candidate'
    check (status in ('candidate','accepted','rejected','superseded')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (snapshot_id, product_id)
);

create index if not exists platform_listing_match_candidates_product_idx
  on public.platform_listing_match_candidates (product_id, status);

drop trigger if exists platform_listing_match_candidates_touch_updated_at on public.platform_listing_match_candidates;
create trigger platform_listing_match_candidates_touch_updated_at
before update on public.platform_listing_match_candidates
for each row execute function public.sd_touch_updated_at();

alter table public.platform_listing_match_candidates enable row level security;

drop policy if exists "platform_listing_match_candidates readable by authenticated" on public.platform_listing_match_candidates;
create policy "platform_listing_match_candidates readable by authenticated"
  on public.platform_listing_match_candidates for select
  to public
  using (auth.role() = 'authenticated');

grant select on public.platform_listing_match_candidates to authenticated;

alter table public.platform_listings
  add column if not exists external_variant_id text,
  add column if not exists external_sku text,
  add column if not exists title text,
  add column if not exists currency text,
  add column if not exists remote_price numeric,
  add column if not exists remote_stock numeric,
  add column if not exists mapping_status text not null default 'mapped',
  add column if not exists publish_origin text not null default 'remote_imported',
  add column if not exists last_seen_at timestamptz,
  add column if not exists raw_snapshot_id uuid references public.platform_listing_snapshots(id) on delete set null;

alter table public.platform_listings
  drop constraint if exists platform_listings_mapping_status_check,
  add constraint platform_listings_mapping_status_check
    check (mapping_status in ('mapped','needs_review','duplicate_candidate','ignored','unmatched','mapping_failed'));

alter table public.platform_listings
  drop constraint if exists platform_listings_publish_origin_check,
  add constraint platform_listings_publish_origin_check
    check (publish_origin in ('v2_created','remote_imported','manual','unknown'));

drop index if exists platform_listings_remote_uniq;
create unique index if not exists platform_listings_remote_uniq
  on public.platform_listings
    (platform, coalesce(shop_id, ''), coalesce(country, ''), platform_item_id, coalesce(external_variant_id, ''))
  where platform_item_id is not null and deleted_at is null;

create index if not exists platform_listings_mapping_status_idx
  on public.platform_listings (platform, mapping_status, last_seen_at desc)
  where deleted_at is null;

insert into public.platform_listings (
  master_product_id,
  platform,
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
  error_msg
)
select
  p.id,
  'joom',
  'GLOBAL',
  p.joom_product_id,
  p.joom_variant_id,
  p.sku,
  p.product_name,
  p.joom_currency,
  p.joom_last_synced_price,
  case
    when p.joom_mapping_status = 'mapping_failed' then 'error'
    else 'listed'
  end,
  coalesce(p.joom_mapping_status, 'mapped'),
  'remote_imported',
  jsonb_build_object(
    'legacy_source', 'products.joom_columns',
    'joom_status', p.joom_status,
    'joom_published_at', p.joom_published_at
  ),
  p.joom_last_synced_at,
  coalesce(p.joom_last_synced_at, p.joom_published_at, p.updated_at),
  p.joom_mapping_error
from public.products p
where p.joom_product_id is not null
  and not exists (
    select 1
    from public.platform_listings pl
    where pl.master_product_id = p.id
      and pl.platform = 'joom'
      and pl.deleted_at is null
  );

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

grant select on public.platform_listing_rollups to authenticated;

create or replace view public.platform_listing_coverage as
with platforms(platform) as (
  values ('shopee'::text), ('joom'::text), ('qoo10'::text), ('alibaba'::text), ('ebay'::text)
)
select
  p.id as product_id,
  p.sku,
  p.product_name,
  p.option_name,
  p.lifecycle_state,
  pf.platform,
  coalesce(r.listed_count, 0) as listed_count,
  coalesce(r.pending_count, 0) as pending_count,
  coalesce(r.error_count, 0) as error_count,
  coalesce(r.total_count, 0) as total_count,
  case
    when coalesce(r.listed_count, 0) > 0 then 'mapped'
    when coalesce(r.pending_count, 0) > 0 then 'pending'
    when coalesce(r.error_count, 0) > 0 then 'error'
    else 'missing'
  end as coverage_status,
  r.per_shop_detail
from public.products p
cross join platforms pf
left join public.platform_listing_rollups r
  on r.master_product_id = p.id and r.platform = pf.platform;

grant select on public.platform_listing_coverage to authenticated;
