# Shopify Weight-Based Shipping Results - 2026-06-28

## Local API refs used

- `C:\dev\api-refs\marketplaces\shopify\carrier-service-create.graphql.html`
- `C:\dev\api-refs\marketplaces\shopify\carrier-service.rest.html`
- `C:\dev\api-refs\marketplaces\shopify\carrier-service-query.graphql.html`
- `C:\dev\api-refs\marketplaces\shopify\README.md`

## Implemented

- Added public Vercel callback `api/shopify-shipping-rates.js`.
- Callback accepts Shopify CarrierService POST bodies rooted at `rate`.
- It sums `items[].grams * quantity`, ignores items with `requires_shipping === false`, rounds to the existing 100g bucket model, and returns Shopify `rates`.
- It reuses the existing `ebay_shipping_country_rates` country/weight KRW table as the current app weight-rate source.
- It converts KRW shipping to USD cents with `SHOPIFY_SHIPPING_KRW_PER_USD`, defaulting to the approved `1460` KRW/USD policy.
- It returns an empty `rates` array for unsupported currencies, missing countries, missing rates, and weights above the current 1kg table instead of undercharging.
- Added `shopify-bridge/carrier-service` registration path for `carrierServiceCreate`.
- Added scope guard: registration stops with `shopify_write_shipping_scope_missing` until OAuth has `write_shipping`.
- Updated Supabase secrets:
  - `SHOPIFY_SCOPES=read_products,write_products,write_shipping`
  - `SHOPIFY_CARRIER_CALLBACK_URL=https://shopee-dashboard-kohl.vercel.app/api/shopify-shipping-rates`

## Live verification

- Vercel production deployment: `dpl_A4n4Qnkp3yRh91qJwKVAYMKwQH6E`.
- Live callback smoke passed on both aliases:
  - `https://starphotocard-multi-dashboard.vercel.app/api/shopify-shipping-rates`
  - `https://shopee-dashboard-kohl.vercel.app/api/shopify-shipping-rates`
- Smoke payload: US destination, USD, one 300g shipping item.
- Smoke response: one `starphotocard Standard` rate, `service_code=SPC_STANDARD`, `currency=USD`, `total_price=720`.
- Supabase `shopify-bridge` deployed to project `mgqlwgnmwegzsjelbrih`.
- `shopify-bridge/shop` live state for `jsupyn-fa.myshopify.com`:
  - `scopes=["write_products"]`
  - `shipping_auth_verified=false`
  - `carrier_callback_url=https://shopee-dashboard-kohl.vercel.app/api/shopify-shipping-rates`
- `shopify-bridge/carrier-service` dry-run attempt currently returns HTTP `409` with `shopify_write_shipping_scope_missing`.
- `shopify-bridge/oauth-url` now requests scopes:
  - `read_products`
  - `write_products`
  - `write_shipping`

## Blockers / expected next behavior

- Current Shopify token has only `write_products`; Steve must run the new OAuth URL once to grant `write_shipping`.
- After reauth, `shopify-bridge/carrier-service` can run live `carrierServiceCreate`.
- Shopify may still reject CarrierService creation if the store is not eligible for carrier-calculated shipping. The local REST docs say eligibility normally requires Advanced Shopify or higher, yearly Shopify billing/add-on, or a development store.
- If Shopify returns an eligibility `userErrors` response after reauth, the complement is a Shopify plan/add-on change rather than code.

## Verification commands

```powershell
node scripts\test-shopify-shipping-rates.mjs
node scripts\test-shopify-product-registration.mjs
node scripts\test-v2-qa-stabilization.mjs
node --check api\shopify-shipping-rates.js
```
