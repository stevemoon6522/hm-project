-- Qoo10 create_listing support fields for SD V2.
-- Based on local official Qoo10 docs:
-- - SetNewGoods: SecondSubCat, BrandNo, ShippingNo, AvailableDateType/Value
-- - GetSellerDeliveryGroupInfo: seller shipping template list
-- - SearchBrand: brand code search
-- - EditGoodsHeaderFooter: post-create listing header HTML

alter table public.products
  add column if not exists qoo10_brand_no text,
  add column if not exists qoo10_brand_name text,
  add column if not exists qoo10_shipping_no text,
  add column if not exists qoo10_available_date_type text,
  add column if not exists qoo10_available_date_value text,
  add column if not exists qoo10_release_date date;

update public.platform_capabilities
set docs_ready = true,
    evidence_note = coalesce(evidence_note, '') || case when coalesce(evidence_note, '') = '' then '' else E'\n' end ||
      'Qoo10 create_listing mapped to SetNewGoods with ShippingNo, BrandNo, AvailableDateType/Value, and EditGoodsHeaderFooter header post-step. Official docs captured under C:\dev\api-refs\marketplaces\qoo10\api-pages.',
    updated_at = now()
where platform = 'qoo10'
  and capability = 'create_listing';
