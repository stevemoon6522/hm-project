alter table products
  add column if not exists lifecycle_state text,
  add column if not exists weight_measured_at timestamptz;

alter table product_shopee_listings
  add column if not exists days_to_ship integer,
  add column if not exists title_state text,
  add column if not exists last_pushed_name text,
  add column if not exists last_pushed_at timestamptz;

create index if not exists idx_products_lifecycle_state
  on products (lifecycle_state);

create index if not exists idx_product_shopee_listings_title_state
  on product_shopee_listings (title_state);
