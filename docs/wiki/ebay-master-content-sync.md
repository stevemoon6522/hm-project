# eBay Master Content Sync

## Decision

Existing eBay listings created through the Sell Inventory API are updated in place with Inventory API replace calls, not by deleting and re-registering the listing.

## Local API References

- `C:\dev\api-refs\marketplaces\ebay\sell\inventory.yaml`
- `PUT /inventory_item_group/{inventoryItemGroupKey}`: complete replacement of the inventory item group; changes to title, description, images, aspects, `variantSKUs`, and `variesBy` update the live multiple-variation listing.
- `PUT /inventory_item/{sku}`: complete replacement of the inventory item; when updating a published SKU, existing availability, condition, package, and product data must be preserved unless intentionally changed.
- `PUT /offer/{offerId}`: complete replacement of the offer; single-SKU listing description updates must preserve published offer fields and listing policies.

## V2 Behavior

- The existing platform workbench `master_sync` action now supports eBay.
- Variation listings call `ebay-bridge/sync-master-content` with:
  - group title from current master title builder
  - group description from the eBay clean description builder
  - group default photos from the layered master main image plus detail images only
  - variation SKU/item aspects and option images applied on each variation inventory item
  - `SET` variation moved to the final position in both `variantSKUs` and `variesBy.specifications[].values`
- When a variation payload includes `productId` but no explicit `imageUrls`, the bridge reads the master product row and uses `products.shopee_option_image_url` as the eBay variation photo. If that is missing, it falls back to `products.main_image`.
- Single-SKU listings update the inventory item product fields and the published offer `listingDescription` when available.

## Safety Notes

- The bridge reads the current eBay object first and sends only allowed replace payload fields.
- The bridge blocks variation sync if the requested payload would omit an existing eBay group SKU.
- Dry-run responses expose current/next summaries and changed field names.
- This path consumes eBay listing revision capacity, so repeated sync attempts should be avoided unless the preview indicates a real master-data change.
