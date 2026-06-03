# eBay K-pop Listing Process Plan

Last updated: 2026-06-03

## Operating Rule

All eBay listing work must be split into the smallest practical units. Do not move
to the next unit until the current unit has passed its validation gate. After any
V2 HTML/app change, review the rendered local app before production deployment.
Production deploy only happens after Steve explicitly asks for deploy.

## Video-Derived Listing Model

### Single-SKU K-pop album

- eBay flow observed: Revise listing, fixed price listing.
- eBay category: `Music > CDs`, category ID `176984`.
- Store category: `/K-pop`.
- Listing format: `Buy It Now`.
- Condition: `Brand New`, API enum `NEW`.
- Images: representative image plus detail images, up to 24.
- Required item specifics: `Artist`, `Release Title`.
- Default/recommended specifics: `Format=CD`, `Genre=K-Pop`, `Style=K-Pop`,
  `Type=Album` or `Mini Album`, `Country of Origin=Korea, South`.
- Policies: fulfillment policy `253030471025` / `ALBUM PRE-ORDER` is the
  default shipping template. Managed payments and return policy use the stored
  seller account defaults.
- Description: operator-supplied English textarea until Steve provides the final
  house template.

### Version-option K-pop album

- eBay variation axis: `Version`.
- Each option row needs a SKU, option label, price, quantity, weight, and option image.
- Group-level listing has the shared title, description, common images, common item
  specifics, category, store category, and policy set.
- Each variation offer has its own SKU, price, quantity, category, store category,
  and policies.
- Variation images must be visible before publish. Missing option images block Apply.

## API Basis

Local eBay API references are the implementation source of truth:

- `C:\dev\api-refs\marketplaces\ebay\sell\inventory.yaml`
- `C:\dev\api-refs\marketplaces\ebay\sell\account.yaml`
- `C:\dev\api-refs\marketplaces\ebay\commerce\taxonomy.yaml`

Live API drift note, verified on 2026-06-02: the local 2026-05 Inventory
snapshot lists `PUT /sell/inventory/v1/location/{merchantLocationKey}` for
`createInventoryLocation`, but the current eBay developer docs and production
API require `POST /sell/inventory/v1/location/{merchantLocationKey}`. The bridge
must use `POST`; using `PUT` returns eBay error `2004 ACCESS Invalid request`.

Inventory API calls required for option listings:

- `PUT /sell/inventory/v1/inventory_item/{sku}`
- `POST /sell/inventory/v1/offer`
- `PUT /sell/inventory/v1/inventory_item_group/{inventoryItemGroupKey}`
- `POST /sell/inventory/v1/offer/publish_by_inventory_item_group`

Important implementation constraints:

- Inventory write calls require `Content-Language: en-US`.
- SKU and inventory group key max length is 50.
- eBay title max length is 80.
- Do not send UPC/EAN/ISBN. Do not let catalog matching overwrite our title/images.
- Use `includeCatalogProductDetails: false` on offers.
- Existing inventory items/groups are complete replacements, so publish payloads
  must include all required fields every time.

## Validation Gates

1. Documentation gate: this file must include the small-step rule, video-derived
   single/option fields, API reference paths, and deployment gate.
2. Draft builder gate: single and option fixtures must produce expected payload
   previews and block missing images/required fields.
3. Local HTML gate: the V2 eBay modal must render without clipped option controls.
4. DB gate: migration must be idempotent and preserve existing product rows.
5. Bridge gate: single publish must continue to work; edge and supabase bridge
   copies must remain identical.
6. Variation bridge gate: mock payloads must include inventory item group, offers,
   and publish-by-group payloads matching local API docs.
7. Apply gate: only after local preview approval, run one burnable master product
   Apply and verify the live eBay listing.
8. Deploy gate: deploy only after Steve explicitly requests deployment, then smoke
   check the live `/v2/` app.
