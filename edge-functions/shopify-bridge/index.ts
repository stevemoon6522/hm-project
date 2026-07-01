// @ts-nocheck
// shopify-bridge edge mirror.
//
// The executable implementation lives in:
//   ../../supabase/functions/shopify-bridge/index.ts
//
// Tokens intentionally mirrored for static deployment checks:
// SHOPIFY_API_VERSION
// authorization-code grant
// function requireBridgeTokenOrAuthenticatedUser
// action === 'oauth-url'
// action === 'oauth-callback'
// action === 'create-product'
// action === 'reprice-products'
// action === 'archive-product'
// action === 'lookup-sku'
// function shopifySearchString
// const queryText = `sku:"${escapedSku}"`
// productCreate
// productUpdate
// async function archiveProduct
// status: 'ARCHIVED'
// cleanup_on_variant_failure !== false
// cleanup_action: 'archive_product'
// function shopifyProductStatus
// status: shopifyProductStatus(product.status)
// productVariantsBulkCreate
// productVariantsBulkUpdate
// async function handleRepriceProducts
// target_margin_pct
// remote_price
// inventorySetQuantities
// publishablePublish
// listing_status: mapShopifyListingStatus(product)
// scopeSet.has('write_products')
// missing_scopes
// write_shipping
// SHOPIFY_CARRIER_CALLBACK_URL
// carrierServiceCreate
// shopify_write_shipping_scope_missing

import '../../supabase/functions/shopify-bridge/index.ts';
