# Platform Test Cycle

Canonical test product:

- Product ID: `f8115948-0f45-40f1-99d8-30b9fc7fb4d9`
- SKU: `F4-JEN-RUBY-DIG-`
- Title: `[READY STOCK] (JENNIE) The 1st Studio Album [Ruby] (CD Digipack)`
- Target file: `scripts/platform-test-target.json`

The CLI defaults to read-only inspection or dry-run behavior.

```powershell
node scripts/platform-test-cycle.mjs ensure-product
node scripts/platform-test-cycle.mjs inspect
node scripts/platform-test-cycle.mjs inspect --pack shopee-registration
node scripts/platform-test-cycle.mjs inspect --pack price-sync
node scripts/platform-test-cycle.mjs inspect --pack joom-registration
node scripts/platform-test-cycle.mjs ebay-policy
node scripts/platform-test-cycle.mjs dry-run-all
node scripts/platform-test-cycle.mjs ebay-register
node scripts/platform-test-cycle.mjs ebay-cycle
node scripts/platform-test-cycle.mjs joom-register
node scripts/platform-test-cycle.mjs joom-cycle
node scripts/platform-test-cycle.mjs qoo10-register
node scripts/platform-test-cycle.mjs qoo10-cycle
node scripts/platform-test-cycle.mjs shopee-register
node scripts/platform-test-cycle.mjs shopee-cycle
```

`inspect --pack <name>` adds an operational diagnosis checklist to the normal read-only product/mapping inspection. Current packs:

- `shopee-registration`: compare registration payloads, SKU/model mapping, publish region, images, brand/category/attributes, price, stock, DTS, and bridge stage logs.
- `price-sync`: compare dry-run diff, target model/listing IDs, last known good local price, live marketplace result, and rollback data.
- `joom-registration`: compare brand/category, detail images, SKU, price, stock, weight, request payload, and response body.

Live cleanup or policy repair calls require `PLATFORM_BRIDGE_INTERNAL_TOKEN` in the environment.

```powershell
$env:PLATFORM_BRIDGE_INTERNAL_TOKEN = '<server-only-token>'
node scripts/platform-test-cycle.mjs ebay-register --live
node scripts/platform-test-cycle.mjs ebay-cycle --live
node scripts/platform-test-cycle.mjs ebay-withdraw-sku --ebay-sku SDV2-TEST-EBAY --live
node scripts/platform-test-cycle.mjs ebay-policy --live
node scripts/platform-test-cycle.mjs ebay-withdraw --live
node scripts/platform-test-cycle.mjs joom-cycle --live
node scripts/platform-test-cycle.mjs joom-delete --live
node scripts/platform-test-cycle.mjs qoo10-cycle --live
node scripts/platform-test-cycle.mjs qoo10-delete --item-code 1234567890 --live
node scripts/platform-test-cycle.mjs shopee-cycle --region SG --live
node scripts/platform-test-cycle.mjs shopee-delete --global-item-id 3000141126 --live
```

`joom-cycle --live` creates a disposable Joom product with a generated test SKU and removes that same product after publish succeeds. This avoids removing an existing operating SKU. Joom product creation/update/removal behavior is based on `C:\dev\api-refs\marketplaces\joom\openapi.yaml`.

`ebay-cycle --live` creates a disposable eBay fixed-price listing with a generated SKU through the server-only `publish-headless` route and withdraws that same published offer through `withdraw-sku`. It does not persist the disposable SKU into the operating master product row. eBay publish/withdraw behavior is based on `C:\dev\api-refs\marketplaces\ebay\sell\inventory.yaml`.

`shopee-cycle --live` creates a disposable Shopee Global Product for one region, verifies at least one publish result, and then deletes that generated global item with `delete_global_item_headless` and `reset_local=false`. Shopee add/publish/delete behavior is based on `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.add_global_item.json`, `v2.global_product.create_publish_task.json`, `v2.global_product.get_publish_task_result.json`, and `v2.global_product.delete_global_item.json`.

`qoo10-cycle --live` creates a disposable Qoo10 listing with a generated SellerCode and deletes that generated listing with `EditGoodsStatus Status=3`. Qoo10 creation/deletion behavior is based on `C:\dev\api-refs\marketplaces\qoo10\api-pages\상품-등록\10009-SetNewGoods.md` and `C:\dev\api-refs\marketplaces\qoo10\api-pages\상품-수정\10013-EditGoodsStatus.md`.

Official local docs used for cleanup behavior:

- eBay: `C:\dev\api-refs\marketplaces\ebay\sell\inventory.yaml`, `GET /offer/{offerId}`, `PUT /offer/{offerId}`, `POST /offer/{offerId}/withdraw`
- Joom: `C:\dev\api-refs\marketplaces\joom\openapi.yaml`, `POST /products/create`, `POST /products/update`, `POST /products/remove`
- Qoo10: `C:\dev\api-refs\marketplaces\qoo10\api-pages\상품-등록\10009-SetNewGoods.md`, `C:\dev\api-refs\marketplaces\qoo10\api-pages\상품-수정\10013-EditGoodsStatus.md`, `Status=3`
- Shopee: `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.add_global_item.json`, `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.create_publish_task.json`, `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.get_publish_task_result.json`, `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.delete_global_item.json`
