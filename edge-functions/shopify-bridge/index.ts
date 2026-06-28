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
// action === 'lookup-sku'
// productCreate
// function shopifyProductStatus
// status: shopifyProductStatus(product.status)
// productVariantsBulkCreate
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
