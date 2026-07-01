-- Shopify product pricing policy.
-- This keeps operator-editable Shopify pricing inputs out of the Edge Function
-- source while preserving the approved USD defaults.

create table if not exists public.shopify_price_policy (
  id text primary key default 'default',
  currency text not null default 'USD',
  krw_per_usd numeric not null default 1460 check (krw_per_usd > 0),
  target_margin_pct numeric not null default 0 check (target_margin_pct >= 0 and target_margin_pct < 100),
  payment_fee_pct numeric not null default 1 check (payment_fee_pct >= 0),
  transaction_fee_pct numeric not null default 10 check (transaction_fee_pct >= 0),
  fixed_operation_fee_pct numeric not null default 0 check (fixed_operation_fee_pct >= 0),
  include_shipping_in_price boolean not null default false,
  default_status text not null default 'ACTIVE' check (default_status in ('ACTIVE', 'DRAFT', 'ARCHIVED')),
  set_inventory boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopify_price_policy_singleton check (id = 'default')
);

drop trigger if exists shopify_price_policy_touch_updated_at on public.shopify_price_policy;
create trigger shopify_price_policy_touch_updated_at
before update on public.shopify_price_policy
for each row execute function public.sd_touch_updated_at();

insert into public.shopify_price_policy (
  id,
  currency,
  krw_per_usd,
  target_margin_pct,
  payment_fee_pct,
  transaction_fee_pct,
  fixed_operation_fee_pct,
  include_shipping_in_price,
  default_status,
  set_inventory
) values (
  'default',
  'USD',
  1460,
  0,
  1,
  10,
  0,
  false,
  'ACTIVE',
  false
) on conflict (id) do nothing;

alter table public.shopify_price_policy enable row level security;

drop policy if exists "shopify_price_policy public read" on public.shopify_price_policy;
create policy "shopify_price_policy public read"
  on public.shopify_price_policy for select
  to public
  using (true);

drop policy if exists "shopify_price_policy authenticated write" on public.shopify_price_policy;
create policy "shopify_price_policy authenticated write"
  on public.shopify_price_policy for all
  to authenticated
  using (true)
  with check (id = 'default');

grant select on public.shopify_price_policy to anon, authenticated;
grant insert, update on public.shopify_price_policy to authenticated;
