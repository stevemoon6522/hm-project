-- Runtime guard for Shopee registration on the shared starwms project.
-- This is intentionally idempotent because the V2 repo may be linked to a
-- different Supabase project during development.

create or replace function public.sd_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

alter table public.products
  add column if not exists shopee_category_id bigint,
  add column if not exists shopee_brand_id bigint default 0,
  add column if not exists shopee_brand_name text default 'No Brand',
  add column if not exists shopee_image_id text,
  add column if not exists shopee_extra_image_ids text[] default null,
  add column if not exists shopee_description text,
  add column if not exists shopee_extra_attributes jsonb default '[{"attribute_id": 100037, "attribute_value_list": [{"original_value_name": "South Korea"}]}]'::jsonb,
  add column if not exists shopee_days_to_ship jsonb default '{"ready_stock": {"SG": 2, "TW": 1, "TH": 2, "MY": 2, "PH": 2, "BR": 3}, "pre_order": {"SG": 10, "TW": 10, "TH": 10, "MY": 10, "PH": 10, "BR": 10}}'::jsonb,
  add column if not exists shopee_global_raw_payload jsonb,
  add column if not exists shopee_global_model_raw_payload jsonb,
  add column if not exists shopee_option_image_url text,
  add column if not exists shopee_global_item_sku text,
  add column if not exists shopee_global_model_sku text;

alter table public.product_shopee_listings
  add column if not exists account_key text not null default 'starphotocard',
  add column if not exists global_model_id bigint,
  add column if not exists shop_id bigint,
  add column if not exists raw_payload jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

update public.product_shopee_listings
   set account_key = 'starphotocard'
 where account_key is null or account_key = '';

do $$
declare
  pkey_name text;
  pkey_cols text;
begin
  select c.conname, string_agg(a.attname, ',' order by u.ordinality)
    into pkey_name, pkey_cols
    from pg_constraint c
    join unnest(c.conkey) with ordinality as u(attnum, ordinality) on true
    join pg_attribute a
      on a.attrelid = c.conrelid
     and a.attnum = u.attnum
   where c.conrelid = 'public.product_shopee_listings'::regclass
     and c.contype = 'p'
   group by c.conname;

  if pkey_cols is distinct from 'product_id,account_key,region' then
    if pkey_name is not null then
      execute format('alter table public.product_shopee_listings drop constraint %I', pkey_name);
    end if;
    alter table public.product_shopee_listings
      add constraint product_shopee_listings_pkey primary key (product_id, account_key, region);
  end if;
end $$;

create index if not exists idx_product_shopee_listings_account_region
  on public.product_shopee_listings (account_key, region);

create index if not exists idx_product_shopee_listings_account_global_item
  on public.product_shopee_listings (account_key, global_item_id);

create index if not exists idx_product_shopee_listings_global_model
  on public.product_shopee_listings (global_model_id);

drop trigger if exists product_shopee_listings_touch_updated_at on public.product_shopee_listings;
create trigger product_shopee_listings_touch_updated_at
before update on public.product_shopee_listings
for each row execute function public.sd_touch_updated_at();

create table if not exists public.shopee_publish_idempotency (
  publish_request_id uuid primary key,
  action text not null,
  region text,
  shop_id bigint,
  response jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_shopee_publish_idempotency_created_at
  on public.shopee_publish_idempotency (created_at desc);

notify pgrst, 'reload schema';
