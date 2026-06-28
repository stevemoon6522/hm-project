# Shopify eBay Description Design

## Context

Shopify product creation currently builds `descriptionHtml` from the Shopee Seller Center template. That means the previous request to use the eBay description format has not yet been implemented.

The existing eBay description format lives in:

- `supabase/functions/ebay-bridge/index.ts`
- `edge-functions/ebay-bridge/index.ts`
- `v2/index.html`

Shopify accepts HTML in `ProductCreateInput.descriptionHtml`; local reference: `C:\dev\api-refs\marketplaces\shopify\product-create-input.graphql.md`.

## Scope

Change only default generated descriptions:

- Shopify `platform-publish` default `descriptionHtml`
- eBay bridge generated description component splitting
- V2 eBay preview/generated description component splitting

Do not change pricing, tags, collections, images, variant creation, OAuth, or inventory behavior.

## Shopify Description Rule

If `shopify.description_html` or `shopify.description` is provided explicitly, keep honoring the override.

If no override is provided, Shopify should generate an eBay-style HTML description using cards:

- Album product information
- What is included / Handling before shipment
- International shipping time guide
- Customs, Duties & Taxes
- Important notice and friendly support

In Shopify's Album product information card, remove these two existing eBay list lines:

- `100% Official & Authentic K-POP item, brand new from official Korean distributors.`
- `Eligible albums may support Hanteo and Circle chart counts through official channels.`

## Contents Rule

Component lists must render one list item per component even when the stored value is not already newline-separated.

The parser should support:

- newline-separated values
- HTML `<br>` and list endings
- bullet symbols
- semicolon-separated values
- top-level comma-separated values, while avoiding commas inside parentheses/brackets

Examples:

- `Photobook, CD, Photocard` -> `Photobook`, `CD`, `Photocard`
- `Photobook (random 1 of 3), CD; Sticker` -> `Photobook (random 1 of 3)`, `CD`, `Sticker`

## Verification

Tests must prove:

- Shopify no longer imports or calls `shopeeSellerCenterDescription`.
- Shopify default description includes eBay-style sections.
- Shopify default description excludes the two Album product information lines.
- Shopify default description renders comma-separated Contents as separate `<li>` values.
- eBay bridge and V2 eBay preview use the same improved component splitting behavior.
