-- Step 1a (plan v2.2 §B.6): platform_capabilities — runtime doc-readiness gate.
--
-- Codex P0 #1 fix: the operator's hard rule is "no implementation against
-- guessed API behavior — only what's documented in C:\dev\api-refs". This
-- table makes that a runtime check, not just a code review convention.
-- platform-publish (Step 2) MUST query (platform, capability) before any
-- API call and refuse with error_code='DOCS_NOT_READY' when docs_ready=false.
--
-- Initial seed mirrors the validated capabilities in plan v2.2 §B.6:
--   - Shopee KRSC: validated in v2-wizard-plan.md §0-4
--   - Joom: validated by Codex pointer to openapi.yaml lines 687-695 / 757-764
--   - Alibaba: validated by api-refs/marketplaces/alibaba/markdown/api/*
--   - Qoo10: validated 2026-05-20 via Playwright capture (49 APIs)
--   - eBay: Inventory only (Offer publish OUT OF SCOPE per operator msg #400)

create table if not exists public.platform_capabilities (
  platform text not null check (platform in (
    'shopee', 'joom', 'qoo10', 'ebay', 'alibaba'
  )),
  capability text not null check (capability in (
    'list_query', 'create_listing', 'update_listing', 'update_price',
    'image_rules', 'offer_publish'
  )),
  docs_ready boolean not null default false,
  doc_path text,
  evidence_note text,
  updated_at timestamptz not null default now(),
  primary key (platform, capability)
);

create index if not exists platform_capabilities_ready_idx
  on public.platform_capabilities (docs_ready, platform);

alter table public.platform_capabilities enable row level security;

create policy "platform_capabilities readable by anyone"
  on public.platform_capabilities for select
  to public
  using (true);

-- Mutating only via service-role Edge Functions or DBA migration.

-- Seed: all currently-validated capabilities per plan v2.2 §B.6
insert into public.platform_capabilities
  (platform, capability, docs_ready, doc_path, evidence_note)
values
  -- Shopee KRSC
  ('shopee', 'list_query', true,
    'marketplaces/shopee/docs_ai/apis/global_product/v2.global_product.get_global_item_list.json',
    'KRSC Global Product API — validated in v2-wizard-plan.md §0-4'),
  ('shopee', 'create_listing', true,
    'marketplaces/shopee/docs_ai/apis/global_product/v2.global_product.add_global_item.json',
    'add_global_item + add_global_model + create_publish_task chain'),
  ('shopee', 'update_listing', true,
    'marketplaces/shopee/docs_ai/apis/global_product/v2.global_product.update_global_item.json',
    'update_global_item / update_global_model'),
  ('shopee', 'update_price', true,
    'marketplaces/shopee/docs_ai/apis/global_product/v2.global_product.update_price.json',
    'KRSC global_product/update_price (region batch)'),
  ('shopee', 'image_rules', true,
    'marketplaces/shopee/docs_ai/apis/global_product/v2.global_product.add_global_item.json',
    'image_id_list — upload handled by shopee-bridge /upload_image'),

  -- Joom (docs_ready confirmed by Codex pointer to openapi.yaml lines)
  ('joom', 'list_query', true,
    'marketplaces/joom/api-catalog.md',
    'GET /products?sku= (single) + GET /products/multi (paginated)'),
  ('joom', 'create_listing', true,
    'marketplaces/joom/openapi.yaml',
    'POST /products/create — full schema in openapi.yaml'),
  ('joom', 'update_listing', true,
    'marketplaces/joom/openapi.yaml',
    'POST /products/update — preserves variant currency'),
  ('joom', 'image_rules', true,
    'marketplaces/joom/openapi.yaml',
    'L687-695 product mainImage (JPEG/PNG/GIF, direct URL); L757-764 variant mainImage (>=550x550, square)'),

  -- Alibaba
  ('alibaba', 'list_query', true,
    'marketplaces/alibaba/markdown/api/api-011-alibaba-icbu-product-search-v2-get-post.md',
    'alibaba.icbu.product.search.v2 + status.get.v2'),
  ('alibaba', 'create_listing', true,
    'marketplaces/alibaba/markdown/api/api-011-alibaba-icbu-product-listing-v2-get-post.md',
    'alibaba.icbu.product.listing.v2 — requires photobank.upload pre-step for non-alicdn URLs'),
  ('alibaba', 'update_listing', false, null,
    'product.edit endpoint not yet captured in api-refs'),
  ('alibaba', 'image_rules', true,
    'marketplaces/alibaba/markdown/api/api-001-alibaba-icbu-photobank-upload-get-post.md',
    'L29-31 image_bytes required; L50-53 5MB max per upload; max 6 images per product'),

  -- eBay: Inventory only (Offer publish OUT OF SCOPE — operator decision msg #400)
  ('ebay', 'list_query', true,
    'marketplaces/ebay/sell/inventory.yaml',
    'GET /inventory_item/{sku} + GET /inventory_items'),
  ('ebay', 'create_listing', true,
    'marketplaces/ebay/sell/inventory.yaml',
    'PUT /inventory_item/{sku} (Inventory only — no Offer publish)'),
  ('ebay', 'offer_publish', false, null,
    'OUT OF SCOPE per operator decision 2026-05-20 (msg #400): eBay LED tops out at draft'),

  -- Qoo10: validated by 2026-05-20 Playwright capture (49 APIs)
  ('qoo10', 'list_query', true,
    'marketplaces/qoo10/api-pages/상품-조회/10008-GetAllGoodsInfo.md',
    'ItemsLookup.GetAllGoodsInfo (bulk) + GetItemDetailInfo (single)'),
  ('qoo10', 'create_listing', true,
    'marketplaces/qoo10/api-pages/상품-등록/10009-SetNewGoods.md',
    'ItemsBasic.SetNewGoods — 30 request params, validated 2026-05-20'),
  ('qoo10', 'update_listing', true,
    'marketplaces/qoo10/api-pages/상품-수정/10010-UpdateGoods.md',
    'ItemsBasic.UpdateGoods'),
  ('qoo10', 'update_price', true,
    'marketplaces/qoo10/api-pages/상품-수정/10024-SetGoodsPriceQty.md',
    'ItemsOrder.SetGoodsPriceQty (single) + SetGoodsPriceQtyBulk'),
  ('qoo10', 'image_rules', true,
    'marketplaces/qoo10/api-pages/상품-수정/10028-EditGoodsImage.md',
    'StandardImage URL string; EditGoodsImage (main) + EditGoodsMultiImage (up to 50 detail)')
on conflict (platform, capability) do nothing;
