-- eBay K-pop album listing support.
--
-- Adds variation listing tracking columns and append-only publish run evidence.
-- Idempotent by design: safe to run on an already-upgraded project.

alter table public.products
  add column if not exists ebay_inventory_group_key text,
  add column if not exists ebay_listing_mode text,
  add column if not exists ebay_variation_axis text,
  add column if not exists ebay_variation_value text,
  add column if not exists ebay_variation_image_url text;

comment on column public.products.ebay_inventory_group_key is
  'Seller-defined eBay InventoryItemGroup key for multiple-variation listings.';
comment on column public.products.ebay_listing_mode is
  'eBay listing mode for this product row: single or variation.';
comment on column public.products.ebay_variation_axis is
  'Variation aspect used on eBay, normally Version for K-pop albums.';
comment on column public.products.ebay_variation_value is
  'Variation value shown to eBay buyers, normally the master option name.';
comment on column public.products.ebay_variation_image_url is
  'Option image URL used for the eBay variation row.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'products_ebay_listing_mode_check'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_ebay_listing_mode_check
      check (ebay_listing_mode is null or ebay_listing_mode in ('single', 'variation'));
  end if;
end $$;

create index if not exists products_ebay_inventory_group_key_idx
  on public.products (ebay_inventory_group_key)
  where ebay_inventory_group_key is not null;

create table if not exists public.ebay_publish_runs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id) on delete set null,
  product_group_id text,
  listing_mode text not null check (listing_mode in ('single', 'variation')),
  inventory_group_key text,
  marketplace_id text not null default 'EBAY_US',
  status text not null default 'started'
    check (status in ('started', 'published', 'failed')),
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  error_msg text,
  ebay_item_id text,
  ebay_offer_ids text[] not null default array[]::text[],
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

comment on table public.ebay_publish_runs is
  'Append-only evidence for eBay single and variation publish attempts.';

create index if not exists ebay_publish_runs_product_created_idx
  on public.ebay_publish_runs (product_id, created_at desc);

create index if not exists ebay_publish_runs_group_created_idx
  on public.ebay_publish_runs (inventory_group_key, created_at desc)
  where inventory_group_key is not null;

alter table public.ebay_publish_runs enable row level security;

drop policy if exists "ebay_publish_runs readable by authenticated" on public.ebay_publish_runs;
create policy "ebay_publish_runs readable by authenticated"
  on public.ebay_publish_runs for select
  to public
  using (auth.role() = 'authenticated');

grant select on public.ebay_publish_runs to authenticated;
