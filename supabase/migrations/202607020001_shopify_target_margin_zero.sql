-- Shopify target margin policy reset.
--
-- Staronemall/RSH 30% wholesale uplift is already stored in products.cost_krw,
-- so Shopify product pricing should not add a second target margin.

alter table public.shopify_price_policy
  alter column target_margin_pct set default 0;

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
) on conflict (id) do update
set target_margin_pct = 0,
    updated_at = now();
