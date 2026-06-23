# Shopee Dashboard

This context manages marketplace product data for starphotocard. Its language separates canonical product facts from marketplace-specific listing state so Shopee, Joom, Qoo10, eBay, and Alibaba can share one product backbone without forcing one platform's shape onto the others.

## Language

**Master Product**:
A platform-neutral product family that groups one or more sellable variants for the same release or merch item. One Master Product has many Variant SKUs.
_Avoid_: Shopee product, platform product, listing

**Variant SKU**:
The internal sellable unit used to connect a product option across marketplaces. A Variant SKU should map to each platform's seller-controlled SKU field when that platform exposes one.
_Avoid_: option row, model row, item code

**Platform Listing**:
A product or variant that already exists on a marketplace account. It belongs to exactly one platform/account/market and may be mapped to one Variant SKU.
_Avoid_: master row, uploaded product

**Listing Cleanup**:
An operator action that removes or ends an existing Platform Listing on the marketplace and clears its local mapping so the same Master Product or Variant SKU can be published again.
_Avoid_: product deletion, SKU reset, hard delete

**Platform Listing Header**:
A reusable seller-controlled content block displayed above a marketplace listing's product detail content. Its title line may quote the Master Product name as marketplace copy, but the header is still platform listing content, not a canonical Master Product description.
_Avoid_: master description, product template

**Joom Brand**:
The brand or manufacturer name sent with a Joom Platform Listing. It is selected as listing content, usually from existing marketplace brand names or the artist name, and is not a canonical Master Product fact.
_Avoid_: Shopee brand ID, Qoo10 BrandNo, master brand

**Shopee Global Product**:
The merchant-level Shopee catalog item that acts as the canonical Shopee parent for CBSC/KRSC-published regional shop listings.
_Avoid_: region product, shop item

**Shopee Shop Item**:
The region/shop-level Shopee listing created from a Shopee Global Product after publishing to a shop. One Shopee Global Product can have many Shopee Shop Items across regions.
_Avoid_: global product, master product

**Global English Name**:
The English title on a Shopee Global Product that starphotocard treats as the canonical Shopee title for regional publication.
_Avoid_: translated name, region title

**Shopee Shop Item Name**:
The seller-controlled title on a Shopee Shop Item in a specific region. It may match the Global English Name exactly or be customized/localized for that region.
_Avoid_: global item name, master product name

**Shopee Sync Field**:
A shop-level setting that controls which Shopee Global Product fields are propagated to Shopee Shop Items, such as name and description, media, variation names, price, and days to ship.
_Avoid_: item update, product data

**Shopee Crossupload Permission Block**:
A Shopee-side publication failure where `create_publish_task` or `get_publish_task_result` returns `partner does not have permission to operate shop`, sometimes through `crossupload.api`, after merchant/shop/publishable preflight checks pass. Treat it as an external Shopee account, app, or merchant permission binding issue, not as a payload validation error.
_Avoid_: price ratio error, SET option error, token expired

**Source Listing Snapshot**:
A point-in-time capture of a remote marketplace listing before the operator accepts it as part of the master data. A Shopee listing imported from the shop catalog is a Source Listing Snapshot, not canonical truth by itself.
_Avoid_: master data, source of truth

**SKU Match**:
A mapping decision where a platform seller SKU equals or confidently resolves to a Variant SKU. Exact SKU matches can be auto-mapped; missing, duplicate, or normalized matches require review.
_Avoid_: title match, fuzzy match

**Coverage Gap**:
A marketplace where a Variant SKU has no mapped Platform Listing yet. Coverage Gaps drive new publish candidates so already-listed products are not published twice.
_Avoid_: not uploaded, empty LED

## Flagged Ambiguities

**Shopee product** can mean either a remote Shopee listing or a future Master Product seeded from Shopee. Use **Source Listing Snapshot** for the remote capture and **Master Product** only after canonical fields are accepted.

**Region product name** can mean either the Shopee Global Product title after publication or the title visible on a regional shop listing. Use **Global English Name** for the former and **Shopee Shop Item Name** for the latter.

## Example Dialogue

Operator: "I want to import the HOME PHOTOBOOK that is already listed on Shopee into V2."

Developer: "First we save the Shopee listing as a Source Listing Snapshot. If `model_sku` exactly matches a V2 Variant SKU, we map it as a Platform Listing. Then only the missing Joom, Qoo10, and eBay Coverage Gaps become publish candidates."

Operator: "I want the English Global Product name to appear exactly in TW, TH, and BR."

Developer: "That means making each region's Shopee Shop Item Name exactly match the Global English Name. We need to verify both the Shopee Sync Field policy and direct Shop Item update results."

Operator: "Use our fixed notice above every Qoo10 product detail."

Developer: "That is a Platform Listing Header. We keep it separate from the Master Product description so the same product facts can still publish differently per marketplace."

Operator: "This Joom listing was registered with the wrong category. Delete it so I can register it again."

Developer: "That is a Listing Cleanup: we remove or end the remote Platform Listing and clear the mapping, while keeping the Master Product and Variant SKU as canonical product data."
