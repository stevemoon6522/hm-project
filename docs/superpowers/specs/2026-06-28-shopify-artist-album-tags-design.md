# Shopify Artist Album Tags Design

## Context

Shopify store collections are already driven by smart collection rules. Direct collection assignment would add unnecessary behavior and could conflict with the current store organization.

Local Shopify API references used:

- `C:\dev\api-refs\marketplaces\shopify\product-create-input.graphql.md`
- `C:\dev\api-refs\marketplaces\shopify\collection.graphql.md`
- `C:\dev\api-refs\marketplaces\shopify\tags-add.graphql.md`

## Scope

V2 Shopify product creation will continue to send initial product tags through `ProductCreateInput.tags`.

The adapter will not call `collectionsToJoin`, `collectionAddProducts`, or `collectionUpdate`.

## Tag Rule

Keep the existing operational/default tags because current smart collections can depend on them:

- `Album` or `Goods`
- `Ready Stock` or `Pre Order`
- `starphotocard`
- explicit `products.shopify_tags`
- explicit request `shopify.tags`

Add only these derived merchandising tags:

- artist name
- album name

Do not derive member, version, lifecycle, option, vendor, product type, or collection names as additional merchandising tags.

## Derivation

Use the existing shared K-pop title parser in `supabase/functions/platform-publish/_shared/grouping.ts`.

Artist source priority:

1. explicit `shopify.artist`
2. `master.artist`
3. parsed artist from `product_name`
4. `master.brand`
5. marketplace brand columns that are not `No Brand`

Album source priority:

1. explicit `shopify.album`
2. `master.album`
3. `master.release_title`
4. parsed album from `product_name`

## Safety

Tags remain deduped case-insensitively, trimmed, capped at 255 characters per tag, and capped at 50 tags total.

## Expected Result

A Shopify dry-run for a product like `[READY STOCK] CORTIS - [ GREENGREEN ] 2ND EP (WEVERSE Ver.)` includes `CORTIS` and `GREENGREEN` in `product.tags` while still keeping the current smart-collection base tags.
