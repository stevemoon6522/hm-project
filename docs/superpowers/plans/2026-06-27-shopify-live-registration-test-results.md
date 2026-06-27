# Shopify Live Registration Test Results

Date: 2026-06-27
Shop: `jsupyn-fa.myshopify.com`

## Execution Path

The intended `platform-publish` path was blocked before dry-run because the current V2 browser session did not expose an authenticated Supabase JWT.

To continue the live Shopify API test, the products were created through `shopify-bridge/create-product` with the internal bridge token. The resulting Shopify mappings were then recorded with `public.absorb_platform_sku_lookup(...)`.

## No-Option Product

- Local product id: `94568db2-8d79-4f3b-a96d-7ac6274f0563`
- SKU: `PO-BTS-CRADLE`
- Local title: `[READY STOCK] BTS OFFICIAL LIGHT STICK V4 CRADLE`
- Shopify product GID: `gid://shopify/Product/10429846683936`
- Shopify variant GID: `gid://shopify/ProductVariant/51918986805536`
- Shopify status: `draft`
- DB mapping: `platform_listings.mapping_status='mapped'`, `listing_status='draft'`
- Result: created successfully after fixing `productCreate.userErrors` selection.

## Option Group Product

- Product group id: `e7d6dbe0-1b4f-4b48-8f96-8f9a776a1c39`
- Local title: `[READY STOCK] (ENHYPEN) - [BORDER : DAY ONE]`
- Shopify product GID: `gid://shopify/Product/10429848125728`
- Shopify status: `draft`
- Variant count: 3

| Local product id | SKU | Option | Shopify variant GID |
| --- | --- | --- | --- |
| `e7d6dbe0-1b4f-4b48-8f96-8f9a776a1c39` | `C1-ENH-DAYON-PHO-DAWN` | `DAWN` | `gid://shopify/ProductVariant/51918995489056` |
| `76af6461-9da6-402f-ac04-9b646647372f` | `C1-ENH-DAYON-PHO-DUSK` | `DUSK` | `gid://shopify/ProductVariant/51918995521824` |
| `7add5f2d-d974-4fa7-8108-055afc177f9c` | `C1-ENH-DAYON-PHO-SET` | `SET` | `gid://shopify/ProductVariant/51918995554592` |

- DB mapping: all 3 rows have the same `platform_item_id`, distinct `external_variant_id`, `mapping_status='mapped'`, `listing_status='draft'`.
- Result: created successfully.

## Verification

- Pre-create SKU lookup returned `product_not_found` for all 4 test SKUs.
- No-option dry-run returned:
  - `ok=true`
  - 1 product option
  - 1 SKU-bearing variant
  - 2 media entries
  - Shopee Seller Center template present in `descriptionHtml`
- Option-group dry-run returned:
  - `ok=true`
  - 3 unique option values: `DAWN`, `DUSK`, `SET`
  - 3 unique SKUs
  - 4 media entries
  - Shopee Seller Center template present in `descriptionHtml`
- Post-create SKU lookup returned `status=200`, `listing_status='draft'`, and the expected Product/Variant GIDs for all 4 SKUs.
- Supabase `platform_listings` contains 4 Shopify mapped rows for the created products.

## Issues Found

1. V2 auth state was inconsistent.
   - UI initially showed `Sign out`, but no Supabase auth token existed in local/session storage.
   - `platform-publish` correctly rejected anon dry-run with `401 auth_anon_rejected`.

2. GitHub login cannot currently be used.
   - Chrome showed `ERR_BLOCKED_BY_CLIENT` on the Supabase OAuth URL.
   - Direct server check returned `Unsupported provider: provider is not enabled`.
   - Root cause: GitHub provider is not enabled for the Supabase project, despite the UI button being present.

3. Plan query used stale column names.
   - `platform_listings.matched_product_id` does not exist.
   - Correct column is `platform_listings.master_product_id`.
   - `platform_item_id` is the Shopify Product GID column, not `external_product_id`.

4. Plan request body used stale field name.
   - `platform-publish` requires `master_product_id`.
   - The plan examples used `product_id`.

5. Supabase CLI `db query --linked` is fragile under parallel calls.
   - Parallel DB queries triggered temp login role failures and a pooler circuit breaker.
   - Single sequential queries recovered.

6. Shopify bridge GraphQL selection was incompatible with Admin API 2026-04.
   - `productCreate.userErrors` was queried as `{ field message code }`.
   - Shopify returned `Field 'code' doesn't exist on type 'UserError'`.
   - Fixed by removing `code` from the `productCreate.userErrors` selection and redeploying `shopify-bridge`.

7. Dispatcher path remains unverified end-to-end for live create.
   - Because no authenticated V2 JWT was available, the actual live create used `shopify-bridge` directly.
   - DB mappings were manually absorbed afterward with `absorb_platform_sku_lookup`.

## Follow-Up Fixes

- [x] Remove unsupported `productCreate.userErrors.code` from `shopify-bridge`.
- [x] Redeploy `shopify-bridge`.
- [x] Manually absorb mappings for bridge-created Draft products.
- [ ] Enable or remove the V2 GitHub login button.
- [ ] Fix the V2 auth UI so it cannot show `Sign out` when no Supabase session token exists.
- [x] Update the Shopify live test plan examples from `product_id` to `master_product_id`.
- [x] Update the Shopify live test plan queries from `matched_product_id`/`external_product_id` to `master_product_id`/`platform_item_id`.
- [ ] Run one more create through `platform-publish` after authenticated V2 login is restored, to verify automatic `platform_listings` absorption.
