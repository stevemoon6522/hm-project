-- D2 Shopee adapter: ensure platform_capabilities rows are correct for
-- all 7 new capability names that the dispatcher (gate 3) checks.
--
-- Plan ref: platform-publish-dispatcher-plan.md v2 §D2, §B.2.
-- Spec ref: api-summaries/shopee-dispatcher-spec.md §2-§7.
--
-- Uses INSERT ... ON CONFLICT DO UPDATE so this is idempotent and
-- corrects any rows that may have been seeded with wrong values by
-- the D0 migration's ON CONFLICT DO NOTHING pass.
--
-- Shopee capability matrix (§B.2):
--   create_listing         docs_ready=true  — add_global_item chain (spec §2)
--   activate_listing       docs_ready=false — n/a; auto-activated by publish_task
--   update_metadata        docs_ready=true  — update_global_item (spec §3a)
--   update_price_qty       docs_ready=false — gap E1: update_price.json not captured
--   update_images          docs_ready=true  — update_global_item w/ image_id_list (spec §3a)
--   update_variant_inventory docs_ready=false — gap E2: undocumented update_stock
--   sync                   docs_ready=true  — get_global_item_info (spec §5b)

insert into public.platform_capabilities
  (platform, capability, docs_ready, auth_verified, doc_path, evidence_note)
values
  ('shopee', 'create_listing', true, true,
   'marketplaces/shopee/docs_ai/apis/global_product/v2.global_product.add_global_item.json',
   'D2: add_global_item + init_tier_variation + add_global_model + create_publish_task chain; bridge register_cbsc'),

  ('shopee', 'activate_listing', false, true,
   null,
   'D2: n/a — Shopee auto-activates on create_publish_task; adapter returns CAPABILITY_UNSUPPORTED'),

  ('shopee', 'update_metadata', true, true,
   'marketplaces/shopee/docs_ai/apis/global_product/v2.global_product.update_global_item.json',
   'D2: update_global_item via V2 mutation pipeline (bridge index.ts:1112-1142)'),

  ('shopee', 'update_price_qty', false, true,
   null,
   'D2: docs_ready=false — gap E1: v2.global_product.update_price.json not captured in api-refs; scrape before enabling'),

  ('shopee', 'update_images', true, true,
   'marketplaces/shopee/docs_ai/apis/global_product/v2.global_product.update_global_item.json',
   'D2: update_global_item with image_id_list (spec §3a; pre-upload via /upload_image required)'),

  ('shopee', 'update_variant_inventory', false, true,
   null,
   'D2: docs_ready=false — gap E2: undocumented update_stock; manual only; no local spec'),

  ('shopee', 'sync', true, true,
   'marketplaces/shopee/docs_ai/apis/global_product/v2.global_product.get_global_item_info.json',
   'D2: get_global_item_info (PUBLIC_ACTION on bridge; no auth required for GET)')

on conflict (platform, capability) do update
  set docs_ready   = excluded.docs_ready,
      auth_verified = excluded.auth_verified,
      doc_path     = excluded.doc_path,
      evidence_note = excluded.evidence_note,
      updated_at   = now();
