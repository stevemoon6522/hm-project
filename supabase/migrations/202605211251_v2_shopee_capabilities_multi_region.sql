-- Phase A: Register platform_capabilities row for create_listing_multi_region.
--
-- Plan ref: register-shopee-rebuild-phase-a.md §B (dispatcher adapter),
--   §C (gate 7 Shopee-specific checks).
-- This capability routes to shopee.ts handleCreateListingMultiRegion(),
-- which calls shopee-bridge /register_cbsc with multi-region targets[].
--
-- The platform_capabilities.capability CHECK constraint must be extended to
-- allow the new value before the INSERT can succeed.

-- 1) Drop and recreate the capability CHECK constraint to add the new value.
ALTER TABLE public.platform_capabilities
  DROP CONSTRAINT platform_capabilities_capability_check;

ALTER TABLE public.platform_capabilities
  ADD CONSTRAINT platform_capabilities_capability_check
    CHECK (capability = ANY (ARRAY[
      'list_query', 'create_listing', 'activate_listing',
      'update_metadata', 'update_price_qty', 'update_images',
      'update_variant_inventory', 'sync',
      'update_listing', 'update_price', 'image_rules', 'offer_publish',
      'create_listing_multi_region'
    ]::text[]));

-- 2) Seed the new capability row.
INSERT INTO public.platform_capabilities
  (platform, capability, docs_ready, auth_verified, doc_path, evidence_note)
VALUES
  ('shopee', 'create_listing_multi_region', true, true,
   'marketplaces/shopee/docs_ai/apis/global_product/v2.global_product.add_global_item.json',
   'Phase A: multi-region register_cbsc composite (add_global_item + publish_task × N regions). Reuses existing bridge action unchanged.')
ON CONFLICT (platform, capability) DO NOTHING;
