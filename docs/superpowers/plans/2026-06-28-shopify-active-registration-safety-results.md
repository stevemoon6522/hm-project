# Shopify Active Registration Safety Results

Date: 2026-06-28

## Scope

Priority 4 added live-create safety for Shopify Active registration:

- duplicate SKU preflight before `productCreate`
- archive cleanup when a product is created but variant creation fails
- final operator confirmation before a real ACTIVE Shopify create

## Implemented

- `platform-publish` Shopify adapter now runs `preflightShopifyDuplicateSkus()` before live create.
- Duplicate preflight calls `shopify-bridge/lookup-sku` once per unique variant SKU and returns `SHOPIFY_DUPLICATE_SKU` before mutation when Shopify already has the SKU.
- `shopify-bridge` SKU lookup now uses exact quoted Shopify search:
  - `sku:"${escapedSku}"`
  - This matters for marketplace SKUs with hyphens such as `V1-CORTIS-GREENGREEN-DICE`.
- `shopify-bridge` now exposes `archive-product` and uses `productUpdate(product: { id, status: 'ARCHIVED' })` as the cleanup action.
- `create-product` now archives the newly created product by default if `productVariantsBulkCreate` fails after `productCreate`.
- V2 Shopify registration now shows a final confirm dialog before ACTIVE registration:
  - `Shopify ACTIVE registration will create a live product immediately.`
  - The dialog includes selected group count and SKUs.

## Verification

Static and regression checks:

```powershell
node scripts\test-shopify-product-registration.mjs
node scripts\test-shopify-price-policy-db-ui.mjs
node scripts\test-v2-qa-stabilization.mjs
node scripts\test-v2-price-sync-joom-preorder-fee-ui.mjs
```

All passed.

V2 syntax checks:

- Parsed 1 classic inline script with `vm.Script`.
- Parsed 1 module inline script with `node --check --input-type=module`.

Deployment-source guard:

```powershell
npm run verify:v2-deploy-source
```

Passed.

Local render check:

- Served the worktree at `http://127.0.0.1:5174/v2/`.
- Verified the DOM contains:
  - `platformConfirmShopifyActiveRegistration`
  - `Shopify ACTIVE registration will create a live product`
  - `#shopify-price-policy-panel`
  - 9 Shopify price policy controls with approved defaults

Edge deploy:

```powershell
supabase functions deploy shopify-bridge
supabase functions deploy platform-publish
```

Both deployed to project `mgqlwgnmwegzsjelbrih`.

Edge auth smoke:

- `platform-publish` anon Shopify dry-run request returned HTTP 401 `auth_anon_rejected`.
- `shopify-bridge/archive-product` anon dry-run request returned HTTP 401 `auth_anon_rejected`.

Vercel deploy:

- Production deployment id: `dpl_8dZdaQnCCMH8QE88hDsbe6G2d3qw`
- Production URL: `https://multi-platform-dashboard-1m2ciyoth-moon-jeonghos-projects.vercel.app`
- Public alias: `https://starphotocard-multi-dashboard.vercel.app`
- Verified both public aliases contain:
  - final Shopify confirmation text
  - duplicate preflight wording
  - Shopify price policy panel marker

Live Shopify duplicate evidence:

- During validation before the quoted-SKU fix, the unquoted search missed existing SKU `V1-CORTIS-GREENGREEN-DICE` and created duplicate product `gid://shopify/Product/10430638227744`.
- The duplicate product was immediately archived with Shopify `productUpdate`.
- After the fix, direct Shopify Admin GraphQL search for `sku:"V1-CORTIS-GREENGREEN-DICE"` returns exactly two variants:
  - `gid://shopify/Product/10430595268896`, status `ACTIVE`
  - `gid://shopify/Product/10430638227744`, status `ARCHIVED`
- A follow-up check after the live UI confirm attempt still returned count `2`, so no third duplicate product was created.

## Notes

- The in-app browser reached the final Shopify confirm path on the deployed V2 app, but browser automation became unstable while the JavaScript confirm dialog was active and could not reliably read the final preview text.
- Because of that tool limitation, the live duplicate-block assertion is supported by:
  - deployed code path tests requiring duplicate preflight before mutation
  - exact quoted SKU query verification against Shopify Admin GraphQL
  - post-attempt Shopify product count staying at two products, with no new duplicate
- The current shop token still has product-write scope only. CarrierService registration remains blocked until Shopify OAuth is reauthorized with `write_shipping`.
