# Shopee API update impact matrix - 2026-06-24

## Goal

Classify the Shopee OpenAPI update items into actions for the current
starphotocard systems before wiring any more live API calls.

The main implementation question is whether the new Product batch APIs should
replace any existing V2 Shopee Dashboard flows. The current answer is selective:
keep normal V2 price sync on `v2.product.update_price`, do not adopt the
Outlet/Mart APIs for current shops, and treat `batch_add_item` as a separate
dry/probe candidate.

## Local sources

- Email update: `C:\Users\STEVE\.codex\attachments\13e75adf-fc9a-4b6a-94d3-9c21e93faa02\pasted-text.txt`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.batch_add_item.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.batch_update_outlet_price.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.batch_update_outlet_stock.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.batch_publish_item_to_outlet_shop.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.get_batch_task_result.json`

## Account evidence

Live Product batch price probe on 2026-06-24:

- SKU: `V1-COR-COLOR-PHO-SCENE 1`
- Region: `SG`
- `outlet_shop_id`: `1001961186`
- `item_id`: `43322467262`
- `model_id`: `228142123769`
- `original_price`: `26.39`
- Shopee response: `product.error_param`
- Shopee message: `parameter invalid : not a mart shop`
- Request ID: `e3e3e7f354fec5eb8622b0569699c600`
- Local `shopee_mutation_log.id`: `915`
- `task_id`: not returned

Read-only shop evidence:

- SG/MY/PH/TH/TW/BR operating shops report `is_mart_shop=false`.
- SG/MY/PH/TH/TW/BR operating shops report `is_outlet_shop=false`.
- The same shops report `is_cb=true` and `is_upgraded_cbsc=true`.

## Impact matrix

| Update | Current decision | Current project impact | Reason | Next action |
| --- | --- | --- | --- | --- |
| `v2.product.batch_update_outlet_price` | Do not adopt for current V2 | Keep V2 price sync on shop-level `v2.product.update_price` | Live probe returned `parameter invalid : not a mart shop`; current shops are not Mart/Outlet shops | Revisit only if a Mart/Outlet shop is explicitly onboarded |
| `v2.product.batch_update_outlet_stock` | Do not adopt for current V2/WMS stock sync | No stock sync change | Local doc requires `item_list[].outlet_shop_id` and describes Outlet shop stock; account evidence says no Mart/Outlet shops | Do not connect to inventory/WMS until a valid Mart/Outlet context exists |
| `v2.product.batch_publish_item_to_outlet_shop` | Do not adopt for current V2 registration | No registration/publish change | Local doc requires `item_list[].mart_item_id`, `item_list[].outlet_shop_id`, and an Outlet publish payload | Do not use for CBSC regional publish; revisit only for Mart/Outlet operations |
| `v2.product.batch_add_item` | Dry/probe available; no live call | No replacement of current registration flow yet | This API is not Outlet-specific in the captured doc, but it creates live products asynchronously and its shop-level Product task differs from current CBSC Global Product registration | Use `scripts/shopee-batch-add-item-probe-dry-run.mjs`; keep `current_v2_replacement_ready=false` until a burnable live plan is approved |
| `v2.product.get_batch_task_result` | Supporting endpoint only | Keep guarded diagnostic route, no V2 UI flow | It is useful only after a batch create API returns a valid `task_id`; the price probe did not return one | Use only for supervised diagnostics or for a future adopted batch API |
| SSP offline APIs: `v2.product.get_ssp_list`, `v2.product.get_ssp_info`, `v2.product.add_ssp_item`, `v2.product.link_ssp`, `v2.product.unlink_ssp` | No action in shopee-dashboard | No code change | Repo search found no SSP usage; Shopee states old BR SSP APIs had no production traffic | No migration needed unless another project proves usage |
| Payment field `buyer_payment_info.ads_voucher_discount` on `v2.payment.get_escrow_detail` and `v2.payment.get_escrow_detail_batch` | Not shopee-dashboard scope | No V2 product/price change | V2 does not currently parse escrow payment detail fields | Consider WMS/order settlement support if Ads Smart Voucher reporting becomes required |
| Order prescription fields on `v2.order.get_order_detail` and `v2.order.get_package_detail` | Not shopee-dashboard scope | No V2 product/price change | Fields such as `error_in_fetching_is_prescription_item`, `is_prescription_item`, `prescription_check_status`, and `prescription_reject_reason` target TH/PH/ID medicine/prescription scenarios; V2 dashboard is product/listing/price oriented | Consider WMS order parsing only if prescription items enter operating scope |

## Product API implementation posture

For current starphotocard Shopee Dashboard V2:

1. Keep normal price sync on `/api/v2/product/update_price`.
2. Keep `batch_update_outlet_price` behind the existing explicit confirmation
   guard for diagnostics only.
3. Do not add UI controls for Outlet price, Outlet stock, or Outlet publish until
   there is an actual Mart/Outlet shop context.
4. Do not run `batch_add_item` live from this update cycle. The non-mutating
   payload mapper now exists, and it must keep
   `current_v2_replacement_ready=false` until Global Product and option-group
   differences are resolved.
5. Keep `get_batch_task_result` as an async-task support primitive, not a
   standalone feature.

## Recommended next work

The batch_add_item dry/probe script is now available:

- `scripts/shopee-batch-add-item-probe-dry-run.mjs`
- `scripts/test-shopee-batch-add-item-probe.mjs`

The next useful implementation task is to run the dry/probe against one existing
SKU and decide whether a separate burnable live product is worth creating for a
supervised compatibility spike. Do not use an already listed operating product
for the first live call because `batch_add_item` would create a new shop item.
