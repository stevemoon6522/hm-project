# SD Local API Doc Index

Use this index before implementing or changing marketplace integrations. Final reports for API work should mention the local doc path that was checked.

## Shopee

Global product registration and publish:

- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.add_global_item.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.add_global_model.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.create_publish_task.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.get_publish_task_result.json`
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.delete_global_item.json`

Related SD docs:

- `docs/wiki/shopee-registration-preflight.md`
- `docs/shopee-option-image-policy.md`

## Joom

Create, update, and remove products:

- `C:\dev\api-refs\marketplaces\joom\openapi.yaml`
- `C:\dev\api-refs\marketplaces\joom\api-catalog.md`

## eBay

Inventory item, offer, publish, withdraw, and fulfillment policy behavior:

- `C:\dev\api-refs\marketplaces\ebay\sell\inventory.yaml`

Related SD docs:

- `docs/wiki/ebay-master-content-sync.md`

## Qoo10

Goods creation and deletion/status changes:

- `C:\dev\api-refs\marketplaces\qoo10\api-pages\...\10009-SetNewGoods.md`
- `C:\dev\api-refs\marketplaces\qoo10\api-pages\...\10013-EditGoodsStatus.md`

Known operation notes:

- `SetNewGoods` creates a new goods listing.
- `EditGoodsStatus` with `Status=3` is the current deletion/discontinued path used by the disposable test cycle.

## Shopify

Shopify support is newer than the original Shopee/Joom/Qoo10/eBay paths. Start from current repo plans and result docs until a local official API reference is added under `C:\dev\api-refs\marketplaces\shopify\`.

- `docs/superpowers/plans/2026-06-27-shopify-product-registration.md`
- `docs/superpowers/plans/2026-06-28-shopify-platform-publish-live-results.md`
- `docs/superpowers/plans/2026-06-28-shopify-price-policy.md`

If local Shopify API docs are missing for a task, say so explicitly and use official docs only as a supplement.
