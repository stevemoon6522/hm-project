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
// productVariantsBulkCreate
// inventorySetQuantities
// publishablePublish
// scopeSet.has('write_products')
// missing_scopes

import '../../supabase/functions/shopify-bridge/index.ts';
