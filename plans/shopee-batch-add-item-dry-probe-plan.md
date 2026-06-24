# Shopee batch_add_item dry/probe plan

Date: 2026-06-24

## Goal

Validate whether `v2.product.batch_add_item` can become useful for
shopee-dashboard without creating any live Shopee item.

This is deliberately a non-mutating probe. It builds the future
`item_list[0]` shape, checks the local Shopee docs, compares it with the current
V2 registration flow, and reports blockers.

## Local API references

- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.batch_add_item.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.get_batch_task_result.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.add_global_item.json`

## Current V2 registration baseline

Current V2 registration is CBSC Global Product based:

1. `shopee-bridge/register_cbsc`
2. `/api/v2/global_product/add_global_item`
3. optional `/api/v2/global_product/init_tier_variation`
4. optional `/api/v2/global_product/add_global_model`
5. `/api/v2/global_product/create_publish_task`
6. `/api/v2/global_product/get_publish_task_result`

The new `v2.product.batch_add_item` doc is different:

- auth scope is `shop`, not `merchant`;
- it creates an async Product task and returns `response.task_id`;
- result polling uses `get_batch_task_result` with `task_type=4`;
- the captured doc does not describe Global Product publish;
- the captured doc does not include `tier_variation` or `model` fields.

Therefore the dry/probe must not mark this API as a replacement for the current
CBSC registration flow.

## Script

`scripts/shopee-batch-add-item-probe-dry-run.mjs`

Supported modes:

- `--sample`: built-in valid request-shape sample.
- `--input path.json`: local JSON containing either a register_cbsc-style
  payload, a platform-publish dry-run `rawResponse.computed_payload`, or a
  prebuilt `item_list`.
- `--from-db --sku SKU --region SG`: read `products` and
  `product_shopee_listings` through Supabase REST, then build a candidate
  payload. This is read-only and does not call Shopee.
- `--from-lookup --sku SKU --region SG`: call the existing `lookup-sku` read
  path. This may call Shopee read APIs inside the bridge, but it does not call
  any Product create/update endpoint.

Safety flags emitted by the script:

- `will_call_shopee=false`
- `will_call_shopee_add_item_api=false`
- `will_mutate_listing=false`
- `current_v2_replacement_ready=false`

## Expected findings

The script can validate the request shape, but it should keep V2 replacement
blocked for now.

Known blockers and gaps:

- `logistic_info` is required by `batch_add_item`, but current Global Product
  register payload does not always contain it directly.
- option-group mapping is blocked because the captured `batch_add_item` doc does
  not include `tier_variation` or `model` fields.
- current V2 registration needs `global_item_id` plus per-region publish
  reconciliation; `batch_add_item` returns a Product batch task.
- a live call would create a real shop item and can duplicate an already-listed
  SKU.

## Current decision

The batch_add_item dry/probe script is now available, but the API is not ready
to replace V2 registration.

Status:

- `request_shape_ok` can be true for a fully supplied shop-level payload.
- `current_v2_replacement_ready=false` remains the expected decision.
- Live calls remain blocked until a separate burnable-product plan is approved.

## SKU dry/probe result - 2026-06-24

Command:

```powershell
node scripts\shopee-batch-add-item-probe-dry-run.mjs --from-lookup --sku "V1-COR-COLOR-PHO-SCENE 1" --region SG --json
```

Result:

- `ok=false`
- `will_call_shopee=false`
- `will_call_shopee_add_item_api=false`
- `will_mutate_listing=false`
- `compatibility.status=blocked_option_group_unmapped`
- `current_v2_replacement_ready=false`

Selected source:

- SKU: `V1-COR-COLOR-PHO-SCENE 1`
- Region: `SG`
- shop_id: `1001961186`
- existing shop item_id: `43322467262`
- existing global_item_id: `42522453834`

Missing required `batch_add_item` paths:

- `item_list[0].weight`
- `item_list[0].category_id`
- `item_list[0].image.image_id_list`
- `item_list[0].logistic_info`

Additional blockers:

- Lookup shows the existing listing has a model, but the captured
  `batch_add_item` doc does not include `tier_variation` or `model` fields.
- The product is already registered in Shopee, so a future live
  `batch_add_item` call could create a duplicate shop item.
- The lookup result did not provide a local `products.id`, so this SKU alone is
  not enough to reconstruct the full V2 master registration payload.

Decision from this SKU:

- Do not run `batch_add_item` live with `V1-COR-COLOR-PHO-SCENE 1`.
- A real live compatibility spike would need a burnable/test product with full
  master fields, explicit logistics discovery, and a cleanup plan.
