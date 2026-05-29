-- Live DB smoke for Shopee Global SKU-dispatch primitives.
-- Verifies: import columns, Shopee listing mapping, sku_platform_coverage view,
-- absorb_platform_sku_lookup RPC, and cleanup cascade.

do $$
declare
  v_product_id uuid := gen_random_uuid();
  v_sku text := 'HERMES-SD-E2E-' || substr(v_product_id::text, 1, 8);
  v_absorb_id uuid;
  v_mapped_count int;
  v_shopee_count int;
  v_qoo10_missing_count int;
begin
  insert into public.products (
    id, sku, product_name, cost_krw, weight_g, inventory, main_image, description,
    shopee_global_raw_payload, shopee_global_model_raw_payload,
    shopee_global_item_sku, shopee_global_model_sku,
    joom_category_id, ebay_category_id, qoo10_category_id
  ) values (
    v_product_id, v_sku, 'Hermes SD E2E SKU', 12000, 300, 3,
    'https://example.com/image.jpg', 'Hermes E2E description',
    '{"global_item_id":123}'::jsonb, '{"global_model_id":456}'::jsonb,
    'ITEM-SKU', 'MODEL-SKU', 'music_albums_cd', '176984', '123456789'
  );

  insert into public.product_shopee_listings (
    product_id, region, global_item_id, global_model_id,
    shop_id, shop_item_id, shop_model_id, status, raw_payload
  ) values (
    v_product_id, 'SG', 123, 456, 999, 888, 777, 'mapped',
    '{"source":"hermes_e2e"}'::jsonb
  );

  select public.absorb_platform_sku_lookup(
    v_product_id, 'joom', v_sku,
    'joom-e2e-product', 'joom-e2e-variant',
    'GLOBAL', null, 'listed', '{"source":"hermes_e2e"}'::jsonb
  ) into v_absorb_id;

  select count(*) into v_mapped_count
    from public.sku_platform_coverage
   where master_product_id = v_product_id
     and platform = 'joom'
     and coverage_status = 'listed'
     and platform_item_id = 'joom-e2e-product';

  select count(*) into v_shopee_count
    from public.sku_platform_coverage
   where master_product_id = v_product_id
     and platform = 'shopee'
     and coverage_status = 'listed';

  select count(*) into v_qoo10_missing_count
    from public.sku_platform_coverage
   where master_product_id = v_product_id
     and platform = 'qoo10'
     and coverage_status = 'not_listed';

  if v_absorb_id is null or v_mapped_count <> 1 or v_shopee_count <> 1 or v_qoo10_missing_count <> 1 then
    raise exception 'SD E2E coverage failed absorb=% mapped=% shopee=% qoo10_missing=%',
      v_absorb_id, v_mapped_count, v_shopee_count, v_qoo10_missing_count;
  end if;

  delete from public.products where id = v_product_id;
end$$;

select 'sd_e2e_coverage_absorb_ok' as result;
