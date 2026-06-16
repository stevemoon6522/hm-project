-- Qoo10 price-sync cache columns for V2.
-- API basis: C:\dev\api-refs\marketplaces\qoo10\api-pages\...\10024-SetGoodsPriceQty.md

alter table public.products
  add column if not exists qoo10_last_synced_price numeric,
  add column if not exists qoo10_last_synced_at timestamptz;
