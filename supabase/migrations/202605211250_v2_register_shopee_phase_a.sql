-- Phase A: Add Shopee-specific master-data columns to products table.
--
-- Plan ref: register-shopee-rebuild-phase-a.md §A
-- Operator decisions: msg #651 (category candidates 100740/101390),
--   msg #653 (price model C: KRW push, no margin multiplication),
--   msg #647 (extra_attributes defaults, days_to_ship per-region/lifecycle).
--
-- All columns are nullable or have defaults so existing rows are unaffected.

ALTER TABLE public.products
  -- Shopee Global Product category ID. Operator picks from dropdown.
  -- Phase A CHECK: only two known operator-approved categories allowed.
  -- 100740 = CD/DVD/Bluray, 101390 = Idol Collectibles.
  -- NULL = not yet assigned.
  ADD COLUMN IF NOT EXISTS shopee_category_id bigint,

  -- Shopee brand attribute ID. 0 = No Brand (Shopee standard sentinel).
  ADD COLUMN IF NOT EXISTS shopee_brand_id bigint DEFAULT 0,

  -- Shopee brand display name for the attribute_value_list.
  ADD COLUMN IF NOT EXISTS shopee_brand_name text DEFAULT 'No Brand',

  -- Shopee image_id returned by /upload_image. Cached after first upload.
  -- NULL means the image hasn't been uploaded yet (Phase B will auto-upload).
  ADD COLUMN IF NOT EXISTS shopee_image_id text,

  -- Shopee product description (up to 5000 chars). Falls back to product_name if NULL.
  ADD COLUMN IF NOT EXISTS shopee_description text,

  -- Shopee extra attributes jsonb. Default covers Region of Origin = South Korea.
  -- Format: [{"attribute_id": N, "attribute_value_list": [{"original_value_name": "..."}]}]
  -- Phase A default: Region of Origin (attribute_id 100037) = "South Korea".
  -- Brand attribute is resolved at publish time from shopee_brand_id + shopee_brand_name.
  -- Phase B will refine per-category attribute_id mapping.
  ADD COLUMN IF NOT EXISTS shopee_extra_attributes jsonb DEFAULT '[{"attribute_id": 100037, "attribute_value_list": [{"original_value_name": "South Korea"}]}]'::jsonb,

  -- Per-region, per-lifecycle DTS (days-to-ship) overrides.
  -- Keyed by lifecycle_state ("ready_stock" | "pre_order") then region code.
  -- Phase A default values derived from operator's standard SLA commitments.
  ADD COLUMN IF NOT EXISTS shopee_days_to_ship jsonb DEFAULT '{"ready_stock": {"SG": 2, "TW": 1, "TH": 2, "MY": 2, "PH": 2, "BR": 3}, "pre_order": {"SG": 10, "TW": 10, "TH": 10, "MY": 10, "PH": 10, "BR": 10}}'::jsonb;

-- CHECK: shopee_category_id must be one of the two operator-approved categories, or NULL.
-- msg #651: only 100740 (CD/DVD/Bluray) and 101390 (Idol Collectibles) are valid in Phase A.
ALTER TABLE public.products
  ADD CONSTRAINT products_shopee_category_id_check
    CHECK (shopee_category_id IN (100740, 101390) OR shopee_category_id IS NULL);

-- Column comments for documentation
COMMENT ON COLUMN public.products.shopee_category_id    IS 'Shopee Global Product category ID. Phase A: 100740 (CD/DVD/Bluray) or 101390 (Idol Collectibles). NULL = not assigned.';
COMMENT ON COLUMN public.products.shopee_brand_id       IS 'Shopee brand attribute ID used in attribute_list. 0 = No Brand.';
COMMENT ON COLUMN public.products.shopee_brand_name     IS 'Shopee brand display name for attribute_value_list (e.g. "HYBE", "SM Entertainment"). Default: No Brand.';
COMMENT ON COLUMN public.products.shopee_image_id       IS 'Shopee image_id cached after /upload_image. NULL = not yet uploaded. Phase B will auto-upload from main_image.';
COMMENT ON COLUMN public.products.shopee_description    IS 'Shopee product description (max 5000 chars). Falls back to product_name at publish time if NULL.';
COMMENT ON COLUMN public.products.shopee_extra_attributes IS 'Shopee attribute_list jsonb. Default: Region of Origin = South Korea. Brand resolved at publish. Phase B refines per-category mapping.';
COMMENT ON COLUMN public.products.shopee_days_to_ship   IS 'Per-region DTS override keyed by lifecycle_state (ready_stock|pre_order) then region. Defaults: ready_stock SG/TH/MY/PH=2, TW=1, BR=3; pre_order all=10.';
