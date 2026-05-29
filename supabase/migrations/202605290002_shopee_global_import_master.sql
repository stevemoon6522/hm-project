-- V2 Shopee Global Product keyword import → master product persistence.
-- Keeps Shopee Global SKU as canonical SKU and preserves raw item/model JSON plus option image URLs.
-- Also adds Joom category mapping used by platform-publish/joom adapter.

alter table public.products
  add column if not exists shopee_global_raw_payload jsonb,
  add column if not exists shopee_global_model_raw_payload jsonb,
  add column if not exists shopee_option_image_url text,
  add column if not exists shopee_global_item_sku text,
  add column if not exists shopee_global_model_sku text,
  add column if not exists joom_category_id text;

alter table public.product_shopee_listings
  add column if not exists raw_payload jsonb;

comment on column public.products.shopee_global_raw_payload is
  'Raw Shopee global item JSON captured by V2 keyword import. Preserves API shape for rehydration/debugging.';
comment on column public.products.shopee_global_model_raw_payload is
  'Raw Shopee global model JSON captured by V2 keyword import. Includes global_model_id, global_model_sku/model_sku, tier_index and seller stock/price fields.';
comment on column public.products.shopee_option_image_url is
  'Shopee option/model image URL resolved from tier_variation.option_list.image/image_url or model image fields during V2 Global Product import.';
comment on column public.products.shopee_global_item_sku is
  'Original item-level Shopee global_item_sku/item_sku preserved separately from canonical products.sku.';
comment on column public.products.shopee_global_model_sku is
  'Original model-level Shopee global_model_sku/model_sku preserved separately from canonical products.sku.';
comment on column public.products.joom_category_id is
  'Joom product category key or category ID used by platform-publish/joom adapter create_listing.';
comment on column public.product_shopee_listings.raw_payload is
  'Raw Shopee published/shop mapping payload captured during Global Product import/mapping.';

-- Table privileges/RLS are managed by the base schema; this migration only adds columns.
