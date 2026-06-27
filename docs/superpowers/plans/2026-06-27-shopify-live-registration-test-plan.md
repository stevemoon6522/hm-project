# Shopify Live Registration Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register one no-option master product and one option-group master product to Shopify as Draft, then identify and document all integration issues before wider rollout.

**Architecture:** Use the existing V2 `platform-publish` dispatcher, not direct Shopify Admin calls, so the test covers auth gating, Shopify adapter payload generation, `shopify-bridge`, and DB mapping absorption. Use `dry_run=true` first for both product shapes, then run exactly one live Draft registration per shape if the payload is valid.

**Tech Stack:** Shopee Dashboard V2 static app, Supabase Edge Functions, Supabase Postgres, Shopify Admin GraphQL 2026-04, local Shopify API refs under `C:\dev\api-refs\marketplaces\shopify`.

---

## Local References

- `C:\dev\api-refs\marketplaces\shopify\product-create.graphql.md`
- `C:\dev\api-refs\marketplaces\shopify\product-variants-bulk-create.graphql.md`
- `C:\dev\api-refs\marketplaces\shopify\inventory-set-quantities.graphql.md`
- `C:\dev\api-refs\marketplaces\shopify\publishable-publish.graphql.md`
- `C:\dev\shopee-dashboard\.climpire-worktrees\codex-shopify-product-registration\supabase\functions\platform-publish\_shared\shopee-description.ts`
- `C:\dev\shopee-dashboard\.climpire-worktrees\codex-shopify-product-registration\supabase\functions\platform-publish\adapters\shopify.ts`
- `C:\dev\shopee-dashboard\.climpire-worktrees\codex-shopify-product-registration\supabase\functions\shopify-bridge\index.ts`

## Current Preflight Findings

- Shopify OAuth is connected for `jsupyn-fa.myshopify.com`.
- `platform_capabilities` has `shopify.create_listing=true` and `shopify.sync=true`.
- `shopify_shops.auth_verified=true`.
- Current shop scope returned by Shopify is `{write_products}`. The bridge treats `write_products` as sufficient for create and SKU lookup because Shopify write scopes imply the corresponding read capability for this workflow.
- `products.product_group_id is null` has no SKU-bearing rows. Therefore the "no-option product" test should use a single-row product group or the dashboard's single master-row representation, not `product_group_id is null`.

---

### Task 1: Select Test Products

**Files:**
- Read only: Supabase `public.products`, `public.platform_listings`
- No code changes.

- [ ] **Step 1: Verify Shopify auth state**

Run:

```powershell
supabase db query --linked "select jsonb_object_agg(capability, auth_verified) as shopify_auth from public.platform_capabilities where platform='shopify' and capability in ('create_listing','sync');"
```

Expected:

```json
{"shopify_auth":{"create_listing":true,"sync":true}}
```

- [ ] **Step 2: Find a no-option candidate**

Run:

```powershell
supabase db query --linked "with group_counts as (select product_group_id, count(*) as cnt from public.products group by product_group_id) select p.id, p.product_group_id, p.sku, p.product_name, p.main_image, p.cost_krw, p.inventory from public.products p join group_counts g on g.product_group_id = p.product_group_id where g.cnt = 1 and p.sku is not null and p.product_name is not null and not exists (select 1 from public.platform_listings pl where pl.platform='shopify' and pl.matched_product_id=p.id) limit 10;"
```

Expected:

- At least one row with `sku`, `product_name`, and a public `https://` `main_image`.
- If `main_image` is empty or non-HTTPS, reject that row and choose another row.

- [ ] **Step 3: Find an option-group candidate**

Run:

```powershell
supabase db query --linked "with group_counts as (select product_group_id, count(*) as cnt from public.products group by product_group_id having count(*) > 1) select p.id, p.product_group_id, p.sku, p.product_name, p.option_name, p.main_image, p.shopee_option_image_url, p.cost_krw, p.inventory from public.products p join group_counts g on g.product_group_id = p.product_group_id where not exists (select 1 from public.platform_listings pl where pl.platform='shopify' and pl.matched_product_id=p.id) order by g.cnt desc, p.product_group_id, p.sku limit 30;"
```

Expected:

- Pick one group where every variant row has a unique non-empty `sku`.
- Prefer a group with 2-4 variants for the first live test.
- Reject groups where all image fields are empty or non-HTTPS.

---

### Task 2: Dry-Run The No-Option Product

**Files:**
- Read only: browser session on `https://starphotocard-multi-dashboard.vercel.app/v2/`
- No code changes.

- [ ] **Step 1: Acquire an authenticated V2 session token**

Use the existing Chrome V2 session. If not signed in, sign in through Supabase first. Do not use the anon key for `platform-publish`.

Expected:

- Browser local/session storage contains a Supabase authenticated JWT.

- [ ] **Step 2: Call `platform-publish` in dry-run mode**

Request body:

```json
{
  "platform": "shopify",
  "capability": "create_listing",
  "dry_run": true,
  "shop_id": "jsupyn-fa.myshopify.com",
  "product_id": "<NO_OPTION_PRODUCT_ID>",
  "shopify": {
    "shop_domain": "jsupyn-fa.myshopify.com",
    "title": "[TEST Shopify Draft] <original product name>",
    "status": "DRAFT"
  }
}
```

Expected:

- `ok=true`
- `listing_status="draft"`
- `rawResponse.payload.product.status="DRAFT"`
- `rawResponse.payload.product.descriptionHtml` uses the Shopee Seller Center description template, preserving sections such as `[Official & Authentic K-POP Album]`, `[Contents]`, `[Important Notice]`, and `[COD Policy]`.
- `rawResponse.payload.product.productOptions` contains exactly one option named `Title`
- `rawResponse.productVariantsBulkCreate` has exactly one SKU-bearing variant
- No Shopify product is created during dry run

---

### Task 3: Live-Register The No-Option Product

**Files:**
- Writes external state: Shopify Admin creates one Draft product.
- Writes DB state: `platform_listings`, publish audit/request rows.
- No code changes.

- [ ] **Step 1: Submit live create request**

Use the same body as Task 2 with `dry_run=false`.

Expected:

- `ok=true`
- `platform_item_id` is a Shopify Product GID: `gid://shopify/Product/...`
- `listing_status="draft"`
- Raw response includes at least one `variant_id`: `gid://shopify/ProductVariant/...`

- [ ] **Step 2: Verify DB mapping**

Run:

```powershell
supabase db query --linked "select platform, external_product_id, external_variant_id, sku, listing_status, matched_product_id from public.platform_listings where platform='shopify' and matched_product_id='<NO_OPTION_PRODUCT_ID>' order by updated_at desc limit 5;"
```

Expected:

- One row for the product.
- `external_product_id` is the Shopify Product GID.
- `external_variant_id` is the Shopify Variant GID.
- `listing_status='draft'`.

---

### Task 4: Dry-Run The Option Group

**Files:**
- Read only: browser session and Supabase function response.
- No code changes.

- [ ] **Step 1: Call `platform-publish` in dry-run mode**

Request body:

```json
{
  "platform": "shopify",
  "capability": "create_listing",
  "dry_run": true,
  "shop_id": "jsupyn-fa.myshopify.com",
  "product_id": "<ANY_PRODUCT_ID_IN_GROUP>",
  "shopify": {
    "shop_domain": "jsupyn-fa.myshopify.com",
    "title": "[TEST Shopify Options] <group product name>",
    "status": "DRAFT"
  }
}
```

Expected:

- `ok=true`
- `listing_status="draft"`
- `rawResponse.payload.product.descriptionHtml` uses the same Shopee Seller Center template as the no-option test.
- `rawResponse.payload.product.productOptions` represents the group options.
- `rawResponse.productVariantsBulkCreate.length` equals the selected group variant count.
- `rawResponse.option_products` maps each local `product_id` to its SKU and expected option value.
- No Shopify product is created during dry run.

- [ ] **Step 2: Inspect payload quality before live create**

Reject the live test if any of these are true:

- duplicate SKU inside `productVariantsBulkCreate`
- duplicate option value under the same option axis
- empty price for all variants
- `media` array is empty
- title exceeds Shopify's 255-character limit after prefix

---

### Task 5: Live-Register The Option Group

**Files:**
- Writes external state: Shopify Admin creates one Draft product with multiple variants.
- Writes DB state: one product-level mapping and variant-level mappings.
- No code changes.

- [ ] **Step 1: Submit live create request**

Use the same body as Task 4 with `dry_run=false`.

Expected:

- `ok=true`
- One Shopify Draft product is created.
- `rawResponse.variants.length` equals local variant count.
- Every created Shopify variant has the requested SKU.

- [ ] **Step 2: Verify DB mapping for every variant**

Run:

```powershell
supabase db query --linked "select platform, external_product_id, external_variant_id, sku, listing_status, matched_product_id from public.platform_listings where platform='shopify' and matched_product_id in (select id from public.products where product_group_id='<OPTION_PRODUCT_GROUP_ID>') order by sku;"
```

Expected:

- Row count equals option group variant count.
- All rows share the same `external_product_id`.
- Every row has a non-empty `external_variant_id`.
- Every row has `listing_status='draft'`.

---

### Task 6: Record Issues And Decide Fixes

**Files:**
- Update if needed: `docs/superpowers/plans/2026-06-27-shopify-live-registration-test-results.md`
- Modify code only after a failing behavior is reproduced and categorized.

- [ ] **Step 1: Create test results report**

Record:

```markdown
# Shopify Live Registration Test Results

## No-Option Product
- Local product id:
- SKU:
- Shopify product GID:
- Shopify variant GID:
- Result:
- Issues:

## Option Group Product
- Product group id:
- Variant count:
- Shopify product GID:
- Shopify variant GIDs:
- Result:
- Issues:

## Follow-Up Fixes
- [ ] ...
```

Expected:

- The report separates data problems from code problems.

- [ ] **Step 2: Do not delete or archive Shopify test drafts until GIDs are recorded**

Expected:

- Test products remain available in Shopify Admin for manual inspection.

---

## Expected Overall Result

If the integration works, Shopify should contain two new Draft products:

- one Draft product with one SKU-bearing variant
- one Draft product with multiple SKU-bearing variants

Supabase should contain Shopify mappings in `platform_listings` for every tested local product row. No products should be published, inventory quantities should not be pushed, and no existing Shopify products should be modified.

## Failure And Remediation Matrix

| Symptom | Likely Cause | Immediate Action | Permanent Fix If Repeated |
| --- | --- | --- | --- |
| `AUTH_NOT_VERIFIED` or 401 | Expired user JWT or Shopify capability false | Refresh V2 login, re-check `platform_capabilities` | Add an admin-only "Reconnect Shopify" UI |
| `Shopify create_listing requires at least one public https image URL` | Product lacks public image | Choose another candidate or add `main_image` | Add preflight image warning in Shopify tab |
| `productCreate userErrors` | Invalid title, tags, HTML, media, or shop token | Save raw error, do not retry blindly | Add adapter-level validation for that field |
| `productVariantsBulkCreate userErrors` | Duplicate SKU, duplicate option values, invalid option payload | Inspect dry-run payload and group rows | Add grouped-option sanitizer or duplicate guard |
| Product created but variants failed | Partial Shopify mutation success | Record product GID and manually archive/delete Draft if needed | Add rollback/cleanup path in `shopify-bridge` |
| DB mapping missing after success | `option_products` absorption mismatch | Query `platform_listing_snapshots` and `platform_publish_requests` | Fix `absorb_platform_sku_lookup` or option mapping payload |
| Description format differs from Shopee | Shopify adapter used a free-form description fallback or collapsed line breaks | Stop live registration and inspect dry-run `descriptionHtml` | Keep Shopify default description sourced from shared Shopee Seller Center template and add a regression assertion |
| Price blank or wrong currency | `cost_krw` fallback is not true Shopify store currency pricing | Use explicit `shopify.price` for test | Add Shopify price field/formula before production rollout |
| Browser shows blocked callback page | Chrome extension/client blocks Vercel callback render | Read callback URL from tab URL and call Supabase callback directly | Keep Vercel relay, but add UI reconnect endpoint later |
| Duplicate test product created | Retried live create after partial success | Stop, record created GID, inspect Shopify Admin | Add idempotency key or duplicate SKU pre-check before create |

## Execution Gate

Do not run the live create steps until the user approves this plan. Dry-run steps may be run first, but live Shopify Draft creation should be limited to exactly one no-option product and one option-group product.
