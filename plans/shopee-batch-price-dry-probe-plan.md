# Shopee batch price dry/probe plan

Date: 2026-06-24

## Goal

Validate whether the new Shopee Product batch price API can be wired into V2 without
touching live prices during the first probe step.

The dry/probe step must not call:

- `POST /api/v2/product/batch_update_outlet_price`
- `GET /api/v2/product/get_batch_task_result` against a real task
- existing V2 live `update_price`

It only builds and validates the payload that would be used later in a supervised
live compatibility spike.

## Local API references

Primary local docs:

- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.batch_update_outlet_price.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.get_batch_task_result.json`

Relevant constraints from the docs:

- `batch_update_outlet_price` is shop-authenticated.
- Request body is `item_list`.
- `item_list` size must be between 1 and 100.
- Each row requires `outlet_shop_id`, `item_id`, and `price_list`.
- `price_list` size must be at least 1.
- `price_list[].model_id` is optional for item-without-model.
- `price_list[].original_price` is required and must be greater than 0.
- Create response returns `response.task_id`.
- Result query uses `task_type=1` for price.
- Result records include `shop_id`, `item_id`, `model_id`, and failed rows include
  `failed_reason`.

## Safety model

The first script is deliberately non-mutating:

1. It reads local API JSON docs.
2. It accepts either a sample fixture, a local JSON input, or read-only Supabase
   listing lookup.
3. It builds the exact `item_list` body shape.
4. It validates doc limits and required IDs.
5. It prints the future request body and the future result query shape.
6. It never signs or sends the Shopee batch request.

When run from DB mode, the default target price is `last_synced_price`, not a newly
computed price. This keeps the later live spike as close to no-op as Shopee allows,
but the later live spike is still a real platform mutation and requires explicit
operator confirmation before execution.

## Script

`scripts/shopee-batch-price-probe-dry-run.mjs`

Modes:

- `--sample`: use a built-in sample row, no network.
- `--input path.json`: use a local JSON fixture, no network.
- `--from-db --sku SKU --region SG`: read `products` and
  `product_shopee_listings` through Supabase REST, then build the payload. This
  is read-only network access and still does not call Shopee.

Expected output:

- local doc validation summary
- selected product/listing metadata
- `batch_update_outlet_price` body
- `get_batch_task_result` query template
- correlation key needed later to map Shopee task results back to local rows
- explicit `will_call_shopee: false`

## Compatibility spike after this step

Only after the dry/probe output is reviewed:

1. Add a supervised bridge action or one-off operator script that actually calls
   `batch_update_outlet_price`.
2. Use one SG item with known `shop_id`, `shop_item_id`, and, if variant, exact
   `shop_model_id`.
3. Use the current `last_synced_price` as the submitted `original_price` unless
   Steve explicitly chooses another test price.
4. Poll `get_batch_task_result` with `task_type=1`.
5. Confirm Seller Center / remote item price did not drift unexpectedly.

Pass criteria:

- task creation succeeds,
- task result reaches `publish_status=2`,
- target row appears in `success_list`,
- no unintended price drift is observed.

Fail criteria:

- API rejects `outlet_shop_id` for normal regional shop,
- result never finishes,
- row appears in `failed_list`,
- remote price changes unexpectedly or cannot be reconciled.

If fail criteria are met, keep V2 on existing shop-level `update_price` and treat
the new batch API as outlet/mart-specific until proven otherwise.
