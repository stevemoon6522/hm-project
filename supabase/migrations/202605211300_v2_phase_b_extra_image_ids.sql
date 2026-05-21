-- Phase B: add shopee_extra_image_ids column to products for caching additional Shopee image IDs
-- (cover = shopee_image_id, additional = shopee_extra_image_ids)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS shopee_extra_image_ids text[] DEFAULT NULL;

COMMENT ON COLUMN products.shopee_extra_image_ids IS
  'Phase B: Cached Shopee image IDs for additional (non-cover) product images. Index 0..7 maps to positions 2..9. Cover image stays in shopee_image_id.';
