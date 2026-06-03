-- Base schema required before the 2026-05-12+ [sd] migrations.
-- New Supabase projects start empty; v1 still reads/writes these tables
-- directly from the browser, while token-bearing Shopee tables stay locked
-- down to service-role Edge Functions.

create extension if not exists pgcrypto;

create or replace function public.sd_touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  shopee_item_id bigint,
  global_model_id bigint,
  sku text not null default '',
  product_name text,
  option_name text,
  sourcing_price numeric,
  cost_krw numeric not null default 0,
  weight_g numeric not null default 0,
  position bigint not null default 0,
  staronemall_url text,
  purpose text not null default 'price_edit',
  tags text[] default array[]::text[],
  joom_product_id text,
  joom_variant_id text,
  joom_currency text,
  joom_status text,
  joom_published_at timestamptz,
  joom_mapping_status text,
  joom_mapping_error text,
  joom_last_synced_price numeric,
  joom_last_synced_at timestamptz,
  lifecycle_state text not null default 'pre_order',
  inventory integer not null default 0,
  days_to_ship integer not null default 2,
  cost_updated_at timestamptz,
  weight_measured_at timestamptz,
  main_image text,
  extra_images text[],
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_purpose_check check (purpose in ('price_edit', 'registration')),
  constraint products_lifecycle_state_check check (lifecycle_state in ('pre_order', 'ready_stock'))
);

alter table public.products
  add column if not exists shopee_item_id bigint,
  add column if not exists global_model_id bigint,
  add column if not exists sku text not null default '',
  add column if not exists product_name text,
  add column if not exists option_name text,
  add column if not exists sourcing_price numeric,
  add column if not exists cost_krw numeric not null default 0,
  add column if not exists weight_g numeric not null default 0,
  add column if not exists position bigint not null default 0,
  add column if not exists staronemall_url text,
  add column if not exists purpose text not null default 'price_edit',
  add column if not exists tags text[] default array[]::text[],
  add column if not exists joom_product_id text,
  add column if not exists joom_variant_id text,
  add column if not exists joom_currency text,
  add column if not exists joom_status text,
  add column if not exists joom_published_at timestamptz,
  add column if not exists joom_mapping_status text,
  add column if not exists joom_mapping_error text,
  add column if not exists joom_last_synced_price numeric,
  add column if not exists joom_last_synced_at timestamptz,
  add column if not exists lifecycle_state text not null default 'pre_order',
  add column if not exists inventory integer not null default 0,
  add column if not exists days_to_ship integer not null default 2,
  add column if not exists cost_updated_at timestamptz,
  add column if not exists weight_measured_at timestamptz,
  add column if not exists main_image text,
  add column if not exists extra_images text[],
  add column if not exists description text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists products_sku_nonempty_uidx
  on public.products (sku)
  where btrim(sku) <> '';

create index if not exists idx_products_position_created
  on public.products (position asc, created_at asc);

drop trigger if exists products_touch_updated_at on public.products;
create trigger products_touch_updated_at
before update on public.products
for each row execute function public.sd_touch_updated_at();

create table if not exists public.country_settings (
  country_code text primary key,
  name text not null,
  currency text not null,
  exchange_rate numeric not null default 1,
  pg_fee numeric not null default 0,
  sales_fee numeric not null default 0,
  fsp_fee numeric not null default 0,
  other_fee numeric not null default 0,
  settlement_fee numeric not null default 0,
  gst numeric not null default 0,
  fsp_ccb numeric not null default 0,
  import_duty numeric not null default 0,
  fixed_service_fee numeric not null default 0,
  purchase_vat numeric not null default 0,
  margin_formula text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists country_settings_touch_updated_at on public.country_settings;
create trigger country_settings_touch_updated_at
before update on public.country_settings
for each row execute function public.sd_touch_updated_at();

insert into public.country_settings
  (country_code, name, currency, exchange_rate, pg_fee, sales_fee, fsp_fee, other_fee,
   settlement_fee, gst, fsp_ccb, import_duty, fixed_service_fee, purchase_vat)
values
  ('SG', 'Singapore', 'SGD', 1000, 3.00, 15.35, 0.00, 2.00, 0.90, 9.00, 0.00, 0.00, 0.00, 0.00),
  ('TW', 'Taiwan', 'NTD', 42, 2.50, 12.35, 0.00, 0.00, 0.90, 0.00, 1.50, 0.00, 0.00, 0.00),
  ('TH', 'Thailand', 'THB', 40, 3.21, 17.49, 0.00, 2.00, 0.90, 7.00, 0.00, 25.50, 1.00, 0.00),
  ('MY', 'Malaysia', 'MYR', 310, 3.78, 16.58, 0.00, 2.00, 0.90, 10.00, 0.00, 0.00, 0.54, 0.00),
  ('PH', 'Philippines', 'PHP', 24, 2.24, 10.01, 0.00, 5.60, 0.90, 0.00, 3.36, 0.00, 0.00, 0.00),
  ('BR', 'Brazil', 'BRL', 240, 2.00, 13.35, 0.00, 0.00, 0.90, 0.00, 0.00, 0.00, 0.00, 0.00),
  ('JM', 'Joom (Global)', 'USD', 1380, 0.00, 15.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 9.10)
on conflict (country_code) do nothing;

create table if not exists public.product_shopee_listings (
  product_id uuid not null references public.products(id) on delete cascade,
  region text not null,
  global_item_id bigint,
  global_model_id bigint,
  shop_id bigint,
  shop_item_id bigint,
  shop_model_id bigint,
  status text not null default 'mapped',
  published_at timestamptz,
  last_error text,
  last_synced_price numeric,
  last_synced_at timestamptz,
  days_to_ship integer,
  title_state text,
  last_pushed_name text,
  last_pushed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, region)
);

create index if not exists idx_product_shopee_listings_region
  on public.product_shopee_listings (region);

create index if not exists idx_product_shopee_listings_global_item
  on public.product_shopee_listings (global_item_id);

drop trigger if exists product_shopee_listings_touch_updated_at on public.product_shopee_listings;
create trigger product_shopee_listings_touch_updated_at
before update on public.product_shopee_listings
for each row execute function public.sd_touch_updated_at();

create table if not exists public.inventory (
  id uuid primary key default gen_random_uuid(),
  sku text,
  barcode text,
  idol text,
  album text,
  version text,
  member text,
  bundle_components jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_inventory_sku
  on public.inventory (sku);

create index if not exists idx_inventory_barcode
  on public.inventory (barcode);

create table if not exists public.shopee_app (
  id integer primary key default 1,
  partner_id bigint,
  partner_key text,
  is_sandbox boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopee_app_singleton check (id = 1)
);

insert into public.shopee_app (id, partner_id, partner_key, is_sandbox)
values (1, 2033682, '', false)
on conflict (id) do nothing;

create table if not exists public.shopee_shops (
  shop_id bigint primary key,
  region text not null,
  shop_name text,
  merchant_id bigint,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  status text not null default 'active',
  authorized_at timestamptz,
  last_polled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopee_shops_status_check check (status in ('active', 'inactive', 'banned'))
);

create index if not exists idx_shopee_shops_region_status
  on public.shopee_shops (region, status);

drop trigger if exists shopee_shops_touch_updated_at on public.shopee_shops;
create trigger shopee_shops_touch_updated_at
before update on public.shopee_shops
for each row execute function public.sd_touch_updated_at();

create table if not exists public.shopee_tokens (
  region text primary key,
  shop_id bigint,
  merchant_id bigint,
  access_token text,
  refresh_token text,
  expires_at bigint,
  is_sandbox boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists shopee_tokens_touch_updated_at on public.shopee_tokens;
create trigger shopee_tokens_touch_updated_at
before update on public.shopee_tokens
for each row execute function public.sd_touch_updated_at();

-- Browser-facing v1 tables. This preserves the existing single-page app
-- behavior; tightening these requires first moving v1 writes behind auth/RPCs.
grant select, insert, update, delete on public.products to anon, authenticated;
grant select, update on public.country_settings to anon, authenticated;
grant select, insert, update, delete on public.product_shopee_listings to anon, authenticated;
grant select on public.inventory to anon, authenticated;

-- Shop tokens are secrets. Allow browser code to read only non-secret shop
-- identity columns needed for GKP auto-mapping.
alter table public.shopee_shops enable row level security;
drop policy if exists "shopee_shops public non-secret read" on public.shopee_shops;
create policy "shopee_shops public non-secret read"
  on public.shopee_shops for select
  to public
  using (true);
revoke all on public.shopee_shops from anon, authenticated;
grant select (region, shop_id, status) on public.shopee_shops to anon, authenticated;

alter table public.shopee_tokens enable row level security;
revoke all on public.shopee_tokens from anon, authenticated;

alter table public.shopee_app enable row level security;
revoke all on public.shopee_app from anon, authenticated;
