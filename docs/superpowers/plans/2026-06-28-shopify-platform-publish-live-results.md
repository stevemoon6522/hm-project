# Shopify Platform-Publish Live Results

Date: 2026-06-28
Shop: `jsupyn-fa.myshopify.com`

## Goal

Verify one real Shopify product creation through the authenticated V2 `platform-publish` path, not through direct `shopify-bridge` creation or manual DB absorb.

## Candidate

- Master product id: `35370461-8cfb-4a66-881f-01c8f6134ea4`
- SKU: `V1-CORTIS-GREENGREEN-DICE`
- Product: `[READY STOCK] CORTIS The 2nd EP [GREENGREEN] (Dice ver.)`
- Cost: `30888` KRW
- Weight: `300` g
- Public image: `https://staronemall2.wisacdn.com/_data/product/c24/m11670/4ea253691e3bfbe4e4665af9a439e32a.jpg`

## Execution Path

1. Confirmed the live V2 browser session was authenticated.
2. Opened the Shopify platform workbench.
3. Clicked the row-level `Shopify Active` action for `V1-CORTIS-GREENGREEN-DICE`.
4. Confirmed the V2 preview panel showed:
   - `Shopify · 대량 등록 미리보기`
   - selected master product count `1`
   - selected SKU/option count `1`
   - execution path `dispatcher 직접 실행`
   - validation `기본 검증 통과`
5. Clicked `실행` once.

## Shopify Verification

`shopify-bridge/lookup-sku` returned:

- HTTP status: `200`
- Shopify product GID: `gid://shopify/Product/10430595268896`
- Shopify variant GID: `gid://shopify/ProductVariant/51919875211552`
- Inventory item GID: `gid://shopify/InventoryItem/53950748786976`
- Shopify product status: `ACTIVE`
- Platform listing status: `listed`
- Variant price: `35.86`
- Inventory tracked: `false`
- Product title: `CORTIS The 2nd EP [GREENGREEN] (Dice ver.)`

The USD price matches the current policy:

```text
ceil_to_cent(30888 / 1460 / (1 - 0.41)) = 35.86
```

## DB Verification

`public.platform_listings` contains the automatically absorbed row:

- row id: `55735b37-e51b-46f9-8a5e-8da28c543b0e`
- platform: `shopify`
- master_product_id: `35370461-8cfb-4a66-881f-01c8f6134ea4`
- platform_item_id: `gid://shopify/Product/10430595268896`
- external_variant_id: `gid://shopify/ProductVariant/51919875211552`
- external_sku: `V1-CORTIS-GREENGREEN-DICE`
- listing_status: `listed`
- mapping_status: `mapped`
- error_msg: `null`

## UI Verification

After closing the preview panel, the Shopify workbench row changed to:

```text
V1-CORTIS-GREENGREEN-DICE · 단품 등록됨 1/1 listed
```

## Issues Found

1. The sidebar navigation meta still says `Draft / SKU sync` even though the Shopify workbench now uses `Shopify Active`.
   - This is a UI copy mismatch only.
   - It should be fixed in a later UI cleanup or active-registration-safety task.

2. Direct same-session `platform-publish` dry-run could not be executed from the browser automation layer because `javascript:` page-context execution was blocked by browser security policy.
   - The V2 preview panel provided preflight validation before live execution.
   - The deployed `shopify-bridge` dry-run and regression tests had already verified `ACTIVE`, USD price, and no inventory push.

## Result

Priority 1 passed. The real V2 authenticated `platform-publish` path can create a Shopify `ACTIVE` product and automatically write the Shopify mapping into `platform_listings`.
