# Shopify Product Registration Plan

## Goal

Add Shopify as a first-class V2 platform for product registration without bypassing the existing `platform-publish` dispatcher.

## Local API References

Primary local refs:

- `C:\dev\api-refs\marketplaces\shopify\product-create.graphql.md`
- `C:\dev\api-refs\marketplaces\shopify\product-variants-bulk-create.graphql.md`
- `C:\dev\api-refs\marketplaces\shopify\inventory-set-quantities.graphql.md`
- `C:\dev\api-refs\marketplaces\shopify\publishable-publish.graphql.md`
- `C:\dev\api-refs\marketplaces\shopify\product-set.graphql.md`

Existing local refs already covered shipping, orders, webhooks, and fulfillment only. Product registration docs were added before implementation.

## MVP Scope

- Create Shopify products as Draft.
- Create SKU-bearing variants through Admin GraphQL.
- Store Shopify product GID as `platform_item_id`.
- Store variant GID through `platform_listings.external_variant_id` via SKU absorb.
- Support SKU sync through `platform-publish`.
- Keep publication and inventory push gated until shop defaults are verified.

## Implementation Steps

1. Add local Shopify product API refs.
2. Add DB migration:
   - add `shopify` to platform checks
   - create `shopify_shops`
   - create `shopify_oauth_states`
   - seed `platform_capabilities`
   - extend SKU coverage and absorb RPC
3. Add `supabase/functions/shopify-bridge`:
   - OAuth URL and callback
   - Admin GraphQL client
   - `create-product`
   - `lookup-sku`
   - gated inventory and publication helpers
4. Add `platform-publish` Shopify adapter:
   - `create_listing`
   - `sync`
   - grouped variant payloads
5. Add V2 UI entry:
   - Shopify platform tab
   - Draft registration via dispatcher preview
   - SKU sync coverage
6. Add regression coverage:
   - Shopify docs/bridge/adapter/migration/UI checks
   - grouped registration checks include Shopify option mapping

## Deferred

- `activate_listing` with `publishablePublish`
- inventory quantity push with `inventorySetQuantities`
- media update flows
- `productSet` reconciliation
- price formula per Shopify store currency
