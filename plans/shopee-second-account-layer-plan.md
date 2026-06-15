# Shopee Second Account Layer Listing Plan

## Goal

Support publishing the same V2 Master Product / Variant SKUs to an additional Shopee account, while changing only the shop overlay layer used for the representative image.

The first safe target is account-aware publishing. The operator should be able to choose a Shopee account profile, and the existing Shopee registration payload should be rebuilt for that account with the selected account layer. Existing `starphotocard` publishing must remain unchanged.

## Local Documentation References

- `C:\dev\api-refs\marketplaces\shopee\docs_ai_guides\guides\regional\krsc-api-integration-guide.md`
  - KRSC product work must use Global Product API and Merchant API.
  - Tokens for each merchant and each shop are independent and must be stored separately.
- `C:\dev\api-refs\marketplaces\shopee\docs_ai_guides\common\token_rules.json`
  - Access/refresh tokens must be stored separately for each `shop_id` and `merchant_id`.
- `C:\dev\api-refs\marketplaces\shopee\docs_ai_guides\guides\global_product\publishing-global-product.md`
  - After creating a Global Product, publish it to market shops via `create_publish_task`.
  - A Global Product can only have one shop product in each market.
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.create_publish_task.json`
  - `create_publish_task` is merchant-scoped, requires `merchant_id`, and takes explicit `shop_id` + `shop_region`.
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.get_publishable_shop.json`
  - `get_publishable_shop` can check which shops are eligible for a Global Product.

## Current Constraints

- `product_shopee_listings` is keyed by `(product_id, region)`, so one Master Product cannot currently store two Shopee listings for the same region across two accounts.
- `shopee_tokens` is keyed by `region`, so the bridge cannot currently store two independent Shopee account token sets for the same region.
- `shopee-bridge` currently defaults merchant calls to the single `_MERCHANT` token row and `SHOPEE_MAIN_ACCOUNT_ID`.
- Both V2 Shopee registration flows use one overlay asset:
  - `v2/shop-overlay-layer.png`
  - root `starphotocard-layer.png` fallback path in older code
- `register_cbsc` already respects explicit `target.shop_id`, which is useful for account-aware publish once account-specific shop lookup exists.

## Required Design

### 1. Account Profile

Add a stable Shopee account key, for example:

- `starphotocard` for the current account
- `staronemall` or another operator-chosen key for the second account

Each account profile should carry:

- `account_key`
- display name
- `main_account_id`
- merchant identifier
- overlay layer asset path
- enabled regions
- optional notes/status

### 2. Token and Shop Namespace

Extend token/shop storage from region-only to account-aware:

- `shopee_tokens(account_key, region)` where `region='_MERCHANT'` stores the merchant token for that account.
- `shopee_shops(account_key, shop_id)` or equivalent indexed account column.

The bridge should continue defaulting to `starphotocard` when no `account_key` is passed, so existing UI and scripts remain compatible.

### 3. Listing Mapping Namespace

Extend `product_shopee_listings` from:

```sql
primary key (product_id, region)
```

to:

```sql
primary key (product_id, account_key, region)
```

Every upsert/read path that maps a Shopee listing must include `account_key`. Existing dashboard rollups can default to `starphotocard` until the UI is updated to show multi-account coverage.

### 4. Bridge Account Routing

Update `shopee-bridge` helpers to accept `account_key`:

- `getValidToken(region, mode, accountKey)`
- `forceRefreshShopToken(region, accountKey)`
- `refreshMerchantRowToken(accountKey)`
- `getValidMerchantToken(accountKey)`
- `merchantApiCall(region, path, opts)` with `opts.account_key`
- `shopApiCall(region, path, opts)` with `opts.account_key`
- `/upload_image` body/query `account_key`
- `/register_cbsc` body `account_key`

`register_cbsc` should:

- create a new Global Product under the selected account merchant
- upload images to the selected account's regional image spaces
- publish to selected account shops
- return `account_key` in every result row

### 5. Layer Selection

Move overlay selection behind a single helper:

```js
getShopeeLayerUrl(accountKey)
```

The current layer remains the default. The second account gets its own 1000x1000 transparent-window PNG, using the same 850x850 image window and 75px inset contract.

### 6. UI Flow

Add an account selector to the Shopee registration modal and URL bulk registration flow:

- Default: current `starphotocard`
- Second account: selected only when operator chooses it

When the operator selects the second account:

- image compositing uses the second account layer
- image upload sends `account_key`
- `register_cbsc` sends `account_key`
- listing upserts include `account_key`
- status rows display account + region

### 7. Validation

Static tests:

- Existing `starphotocard` Shopee registration still builds identical payloads when no account is selected.
- `product_shopee_listings` upserts include `account_key`.
- `register_cbsc` forwards and returns `account_key`.
- layer helper uses the selected account layer.

Local rendered check:

- Open `/v2/`, verify Shopee modal account selector appears.
- Switch accounts and verify representative image preview changes layer.
- Use dry-run/mock where possible before any live publish.

Live smoke after credentials:

- Authorize second account.
- Run `/token_health?account_key=<second>&regions=SG,TW,TH,MY,PH,BR`.
- Publish one low-risk test Master Product to one region first.
- Verify `get_publishable_shop`, `create_publish_task`, `get_publish_task_result`, and local `product_shopee_listings(account_key, region)` rows.

## Open Decisions

1. Is the added Shopee account a completely separate KRSC main account/merchant, or another shop under the current main account?
2. What should the second account key/display name be?
3. Which operating regions should be enabled for the second account?
4. What is the second account layer PNG path/name?
5. Should SKU strings stay identical across accounts, or should the second account add a suffix to seller SKUs?

