-- Shopify platform-tab parity: enable selected price updates through the
-- documented productVariantsBulkUpdate path. Inventory remains disabled.
--
-- Local API refs:
--   C:\dev\api-refs\marketplaces\shopify\product-variants-bulk-update.graphql.md
--   C:\dev\api-refs\marketplaces\shopify\tags-add.graphql.md

update public.platform_capabilities
set docs_ready = true,
    auth_verified = exists (
      select 1
      from public.shopify_shops
      where auth_verified is true
    ),
    doc_path = 'marketplaces/shopify/product-variants-bulk-update.graphql.md',
    evidence_note = 'Selected Shopify price sync uses productVariantsBulkUpdate against mapped ProductVariant GIDs; inventory writes remain gated off.',
    updated_at = now()
where platform = 'shopify'
  and capability = 'update_price_qty';

insert into public.platform_capabilities
  (platform, capability, docs_ready, auth_verified, doc_path, evidence_note)
select
  'shopify',
  'update_price_qty',
  true,
  exists (
    select 1
    from public.shopify_shops
    where auth_verified is true
  ),
  'marketplaces/shopify/product-variants-bulk-update.graphql.md',
  'Selected Shopify price sync uses productVariantsBulkUpdate against mapped ProductVariant GIDs; inventory writes remain gated off.'
where not exists (
  select 1
  from public.platform_capabilities
  where platform = 'shopify'
    and capability = 'update_price_qty'
);
