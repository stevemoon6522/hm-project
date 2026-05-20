-- D0 dispatcher skeleton: platform_capabilities capability enum expansion +
-- auth_verified column, products new columns, ebay_revision_counts table.
--
-- Plan ref: platform-publish-dispatcher-plan.md v2 §D0, §A.2 gate 4,
-- §B.2 capability matrix, Codex P1 #2 (ebay_revision_counts).

-- ---------------------------------------------------------------------------
-- 1. Expand platform_capabilities.capability CHECK to include the 7 new
--    capability names from plan §B.2. Keep all OLD names so existing rows
--    survive (drop-replace, not drop-only).
-- ---------------------------------------------------------------------------
alter table public.platform_capabilities
  drop constraint platform_capabilities_capability_check;

alter table public.platform_capabilities
  add constraint platform_capabilities_capability_check
  check (capability in (
    -- legacy names (keep for existing rows)
    'list_query', 'update_listing', 'update_price', 'image_rules', 'offer_publish',
    -- v2 dispatcher capability names (plan §B.2)
    'create_listing', 'activate_listing', 'update_metadata',
    'update_price_qty', 'update_images', 'update_variant_inventory', 'sync'
  ));

-- ---------------------------------------------------------------------------
-- 2. Add auth_verified column (plan §A.2 gate 4, Codex P2 #5).
--    Backfill true for everyone EXCEPT qoo10 (auth is empirical, not verified).
-- ---------------------------------------------------------------------------
alter table public.platform_capabilities
  add column if not exists auth_verified boolean not null default false;

-- Backfill: all existing rows get true, then qoo10 rows get false.
update public.platform_capabilities set auth_verified = true;
update public.platform_capabilities set auth_verified = false
  where platform = 'qoo10';

-- ---------------------------------------------------------------------------
-- 3. Seed new v2 capability rows per §B.2 matrix (7 capabilities × 5 platforms).
--    Use ON CONFLICT DO NOTHING so this is re-runnable.
-- ---------------------------------------------------------------------------
insert into public.platform_capabilities
  (platform, capability, docs_ready, auth_verified, doc_path, evidence_note)
values
  -- Shopee
  ('shopee', 'create_listing',            true,  true,
   'marketplaces/shopee/docs_ai/apis/global_product/v2.global_product.add_global_item.json',
   'add_global_item + add_global_model + create_publish_task chain'),
  ('shopee', 'activate_listing',          false, true,
   null,
   'n/a — Shopee auto-activates on publish_task; CAPABILITY_UNSUPPORTED'),
  ('shopee', 'update_metadata',           true,  true,
   'marketplaces/shopee/docs_ai/apis/global_product/v2.global_product.update_global_item.json',
   'update_global_item / update_global_model'),
  ('shopee', 'update_price_qty',          false, true,
   null,
   'docs_ready=false: v2.global_product.update_price.json not captured yet (gap E1)'),
  ('shopee', 'update_images',             true,  true,
   'marketplaces/shopee/docs_ai/apis/global_product/v2.global_product.update_global_item.json',
   'update_global_item with image_id_list'),
  ('shopee', 'update_variant_inventory',  false, true,
   null,
   'docs_ready=false: undocumented update_stock; manual only (gap E2)'),
  ('shopee', 'sync',                      true,  true,
   'marketplaces/shopee/docs_ai/apis/global_product/v2.global_product.get_global_item_info.json',
   'get_global_item_info'),

  -- Joom
  ('joom', 'create_listing',              true,  true,
   'marketplaces/joom/openapi.yaml',
   'POST /products/create — full schema in openapi.yaml'),
  ('joom', 'activate_listing',            false, true,
   null,
   'n/a — Joom auto-activates on create; CAPABILITY_UNSUPPORTED'),
  ('joom', 'update_metadata',             true,  true,
   'marketplaces/joom/openapi.yaml',
   'POST /products/update (PATCH semantics)'),
  ('joom', 'update_price_qty',            true,  true,
   'marketplaces/joom/openapi.yaml',
   'POST /products/update with price field'),
  ('joom', 'update_images',               true,  true,
   'marketplaces/joom/openapi.yaml',
   'POST /products/update with images array'),
  ('joom', 'update_variant_inventory',    true,  true,
   'marketplaces/joom/openapi.yaml',
   'variants[] in update body'),
  ('joom', 'sync',                        true,  true,
   'marketplaces/joom/api-catalog.md',
   'GET /products?sku='),

  -- Alibaba
  ('alibaba', 'create_listing',           true,  true,
   'marketplaces/alibaba/markdown/api/api-011-alibaba-icbu-product-listing-v2-get-post.md',
   'alibaba.icbu.product.listing.v2 + photobank pre-step'),
  ('alibaba', 'activate_listing',         false, true,
   null,
   'n/a — Alibaba auto-activates; CAPABILITY_UNSUPPORTED'),
  ('alibaba', 'update_metadata',          false, true,
   null,
   'CAPABILITY_UNSUPPORTED: product.edit NOT in api-refs (gap E7)'),
  ('alibaba', 'update_price_qty',         false, true,
   null,
   'CAPABILITY_UNSUPPORTED: product.edit NOT in api-refs (gap E7)'),
  ('alibaba', 'update_images',            false, true,
   null,
   'CAPABILITY_UNSUPPORTED: product.edit NOT in api-refs (gap E7)'),
  ('alibaba', 'update_variant_inventory', false, true,
   null,
   'CAPABILITY_UNSUPPORTED: product.edit NOT in api-refs (gap E7)'),
  ('alibaba', 'sync',                     true,  true,
   'marketplaces/alibaba/markdown/api/api-011-alibaba-icbu-product-search-v2-get-post.md',
   'alibaba.icbu.product.status.get.v2'),

  -- eBay
  ('ebay', 'create_listing',              true,  true,
   'marketplaces/ebay/sell/inventory.yaml',
   'PUT /inventory_item/{sku} (Inventory only)'),
  ('ebay', 'activate_listing',            false, true,
   null,
   'OUT OF SCOPE: eBay LED tops out at draft; OFFER_PUBLISH_OUT_OF_SCOPE'),
  ('ebay', 'update_metadata',             true,  true,
   'marketplaces/ebay/sell/inventory.yaml',
   'PUT /inventory_item/{sku} with GET-merge-PUT semantics'),
  ('ebay', 'update_price_qty',            true,  true,
   'marketplaces/ebay/sell/inventory.yaml',
   'PUT /inventory_item/{sku} price subset; revision-cap enforced'),
  ('ebay', 'update_images',               true,  true,
   'marketplaces/ebay/sell/inventory.yaml',
   'PUT /inventory_item/{sku} imageUrls'),
  ('ebay', 'update_variant_inventory',    true,  true,
   'marketplaces/ebay/sell/inventory.yaml',
   'availability.quantity in PUT body'),
  ('ebay', 'sync',                        true,  true,
   'marketplaces/ebay/sell/inventory.yaml',
   'GET /inventory_item/{sku}'),

  -- Qoo10 (auth_verified=false until smoke test passes — plan §A.2 gate 4)
  ('qoo10', 'create_listing',             true,  false,
   'marketplaces/qoo10/api-pages/상품-등록/10009-SetNewGoods.md',
   'ItemsBasic.SetNewGoods — auth_verified=false until GetCatagoryListAll smoke test'),
  ('qoo10', 'activate_listing',           true,  false,
   'marketplaces/qoo10/api-pages/상품-수정/EditGoodsStatus.md',
   'ItemsBasic.EditGoodsStatus 10013 — Qoo10 only platform needing explicit activate'),
  ('qoo10', 'update_metadata',            true,  false,
   'marketplaces/qoo10/api-pages/상품-수정/10010-UpdateGoods.md',
   'ItemsBasic.UpdateGoods 10010'),
  ('qoo10', 'update_price_qty',           true,  false,
   'marketplaces/qoo10/api-pages/상품-수정/10024-SetGoodsPriceQty.md',
   'ItemsOrder.SetGoodsPriceQty 10024 / SetGoodsPriceQtyBulk 15238'),
  ('qoo10', 'update_images',              true,  false,
   'marketplaces/qoo10/api-pages/상품-수정/10028-EditGoodsImage.md',
   'EditGoodsImage 10028 (main) + EditGoodsMultiImage 10029 (detail)'),
  ('qoo10', 'update_variant_inventory',   true,  false,
   'marketplaces/qoo10/api-pages/상품-수정/10024-SetGoodsPriceQty.md',
   'SetGoodsPriceQtyBulk with SellerCode slot'),
  ('qoo10', 'sync',                       true,  false,
   'marketplaces/qoo10/api-pages/상품-조회/10008-GetAllGoodsInfo.md',
   'ItemsLookup.GetItemDetailInfo 10007 / GetAllGoodsInfo 10008')

on conflict (platform, capability) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Add new columns to products (plan §D0 §G).
-- ---------------------------------------------------------------------------

-- joom_variant_grouping: operator msg #529 — Joom puts member in size slot,
-- color slot empty. Default is the current production behavior.
alter table public.products
  add column if not exists joom_variant_grouping jsonb
    not null default '{"size":"member","color":null}'::jsonb;

-- ebay_category_id: required for eBay create_listing (gap E14).
alter table public.products
  add column if not exists ebay_category_id text;

-- qoo10_category_id: required for Qoo10 create_listing (gap E17).
alter table public.products
  add column if not exists qoo10_category_id text;

-- ---------------------------------------------------------------------------
-- 5. ebay_revision_counts table (plan §A.3 step 4, Codex P1 #2).
--    Dispatcher increments inside its transaction; if day count >= 250,
--    refuses with RATE_LIMITED before API call.
-- ---------------------------------------------------------------------------
create table if not exists public.ebay_revision_counts (
  sku  text not null,
  date date not null,
  count integer not null default 0,
  primary key (sku, date)
);

alter table public.ebay_revision_counts enable row level security;

-- Authenticated users can read (for observability UI).
drop policy if exists "ebay_revision_counts readable by authenticated"
  on public.ebay_revision_counts;
create policy "ebay_revision_counts readable by authenticated"
  on public.ebay_revision_counts for select
  using (auth.role() = 'authenticated');

-- Service-role (Edge Functions) can write; no policy needed for service-role
-- because RLS is bypassed by service-role key.

-- ---------------------------------------------------------------------------
-- Verify: check the updated constraint exists with all expected values.
-- ---------------------------------------------------------------------------
do $$
declare
  chk text;
begin
  select pg_get_constraintdef(oid)
    into chk
    from pg_constraint
   where conrelid = 'public.platform_capabilities'::regclass
     and conname = 'platform_capabilities_capability_check';
  if chk is null then
    raise exception 'platform_capabilities_capability_check constraint not found';
  end if;
  if chk not like '%sync%' then
    raise exception 'platform_capabilities_capability_check missing sync: %', chk;
  end if;
end$$;
