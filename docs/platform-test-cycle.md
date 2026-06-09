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
node scripts/platform-test-cycle.mjs dry-run-all
```

Live cleanup calls require `PLATFORM_BRIDGE_INTERNAL_TOKEN` in the environment.

```powershell
$env:PLATFORM_BRIDGE_INTERNAL_TOKEN = '<server-only-token>'
node scripts/platform-test-cycle.mjs ebay-withdraw --live
node scripts/platform-test-cycle.mjs joom-delete --live
node scripts/platform-test-cycle.mjs qoo10-delete --item-code 1234567890 --live
node scripts/platform-test-cycle.mjs shopee-delete --global-item-id 3000141126 --live
```

Official local docs used for cleanup behavior:

- eBay: `C:\dev\api-refs\marketplaces\ebay\sell\inventory.yaml`, `POST /offer/{offerId}/withdraw`
- Joom: `C:\dev\api-refs\marketplaces\joom\openapi.yaml`, `POST /products/remove`
- Qoo10: `C:\dev\api-refs\marketplaces\qoo10\api-pages\상품-수정\10013-EditGoodsStatus.md`, `Status=3`
- Shopee: `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.delete_global_item.json`
