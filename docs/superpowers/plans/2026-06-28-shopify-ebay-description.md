# Shopify eBay Description Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Shopify product creation use the eBay-style description template and fix Contents item splitting for Shopify/eBay generated descriptions.

**Architecture:** Keep the Shopify description builder local to `platform-publish/adapters/shopify.ts` so Shopify can remove the two Album product information lines without changing eBay copy. Reuse the same component-splitting semantics in Shopify, eBay bridge, and V2 preview by implementing parallel small helpers in each existing file rather than introducing a cross-function shared import that would disturb deploy bundles.

**Tech Stack:** Supabase Edge Function TypeScript, V2 single-file HTML/JS, Node static regression tests, Shopify Admin GraphQL `ProductCreateInput.descriptionHtml`.

---

## Files

- Modify: `supabase/functions/platform-publish/adapters/shopify.ts`
- Modify: `supabase/functions/ebay-bridge/index.ts`
- Modify: `edge-functions/ebay-bridge/index.ts`
- Modify: `v2/index.html`
- Modify: `scripts/test-shopify-product-registration.mjs`
- Modify: `scripts/test-platform-publish-group-registration.mjs`
- Modify: `scripts/test-v2-ebay-kpop-listing-flow.mjs`

## Task 1: Add Failing Tests

- [x] **Step 1: Update Shopify registration test**

In `scripts/test-shopify-product-registration.mjs`, replace the Shopee-template assertions with assertions that Shopify:

```javascript
assert.doesNotMatch(shopifyAdapter, /shopeeSellerCenterDescription/, 'Shopify adapter must not use the Shopee description template');
assert.match(shopifyAdapter, /function shopifyEbayDescriptionHtmlFrom/, 'Shopify adapter must build the default eBay-style Shopify description');
```

Then execute extracted Shopify description helpers with `components_extracted_en: 'Photobook, CD, Photocard'` and assert:

```javascript
assert(description.includes('Album product information'), 'Shopify description must include eBay-style album card');
assert(description.includes('<li>Photobook</li>'), 'Shopify description must split Photobook into its own Contents item');
assert(description.includes('<li>CD</li>'), 'Shopify description must split CD into its own Contents item');
assert(description.includes('<li>Photocard</li>'), 'Shopify description must split Photocard into its own Contents item');
assert(!description.includes('100% Official & Authentic K-POP item'), 'Shopify description must remove the official/authentic album bullet');
assert(!description.includes('Eligible albums may support Hanteo'), 'Shopify description must remove the chart-count album bullet');
```

- [x] **Step 2: Update grouped registration test**

In `scripts/test-platform-publish-group-registration.mjs`, replace the Shopify Shopee-template assertion with:

```javascript
assert.match(shopify, /shopifyEbayDescriptionHtmlFrom/, 'Shopify adapter must use the eBay-style description template for grouped creates');
```

- [x] **Step 3: Update eBay flow test**

In `scripts/test-v2-ebay-kpop-listing-flow.mjs`, execute `ebayComponentLines` from `supabase/functions/ebay-bridge/index.ts` and `mrEbayComponentLines` from `v2/index.html` with:

```javascript
'Photobook (random 1 of 3), CD; Sticker'
```

Assert both return:

```javascript
['Photobook (random 1 of 3)', 'CD', 'Sticker']
```

- [x] **Step 4: Run tests to verify RED**

Run:

```powershell
node scripts\test-shopify-product-registration.mjs
node scripts\test-platform-publish-group-registration.mjs
node scripts\test-v2-ebay-kpop-listing-flow.mjs
```

Expected: at least the Shopify tests fail because the adapter still uses `shopeeSellerCenterDescription`.

## Task 2: Implement Shopify eBay-Style Description

- [x] **Step 1: Remove the Shopee description import**

Remove:

```typescript
import { shopeeSellerCenterDescription } from '../_shared/shopee-description.ts';
```

- [x] **Step 2: Add Shopify description helper functions**

Add local helpers near `descriptionHtmlFrom()`:

```typescript
function shopifyHtmlEscape(value: unknown): string { ... }
function shopifySplitTopLevelComponents(value: string): string[] { ... }
function shopifyComponentLines(components: unknown): string[] { ... }
function shopifyDescriptionCard(title: string, bodyHtml: string, bgColor = '#fff7fb'): string { ... }
function shopifyDescriptionList(items: string[]): string { ... }
function shopifyDescriptionTable(headers: string[], rows: string[][]): string { ... }
function shopifyEbayDescriptionHtmlFrom(master: Record<string, unknown>, title: string, lifecycleState: string): string { ... }
```

The Shopify album card should include the greeting and product title, but not the two eBay-only album bullets.

- [x] **Step 3: Change `descriptionHtmlFrom()` default path**

Keep explicit overrides. For the generated default, call:

```typescript
shopifyEbayDescriptionHtmlFrom(master, stripLifecycleTags(master.product_name) || cleanText(master.sku), lifecycleOf(master))
```

## Task 3: Fix eBay Contents Splitting

- [x] **Step 1: Update eBay bridge splitter**

In both `supabase/functions/ebay-bridge/index.ts` and `edge-functions/ebay-bridge/index.ts`, update `ebayComponentLines()` to parse newline, HTML breaks/list endings, bullets, semicolons, and top-level commas.

- [x] **Step 2: Update V2 preview splitter**

In `v2/index.html`, update `mrEbayComponentLines()` with the same splitting behavior.

## Task 4: Verify and Deploy

- [x] **Step 1: Run focused tests**

```powershell
node scripts\test-shopify-product-registration.mjs
node scripts\test-platform-publish-group-registration.mjs
node scripts\test-v2-ebay-kpop-listing-flow.mjs
node scripts\test-shopify-price-policy-db-ui.mjs
```

- [x] **Step 2: Run source/deploy checks**

```powershell
npm run verify:v2-deploy-source
git diff --check
```

- [x] **Step 3: Review rendered V2 locally**

Start a local static server for `/v2/`, open it in the browser, and verify the app renders without a blank screen.

- [ ] **Step 4: Commit, push, deploy**

Commit and push to `origin/main`, deploy:

```powershell
supabase functions deploy platform-publish --project-ref mgqlwgnmwegzsjelbrih
supabase functions deploy ebay-bridge --project-ref mgqlwgnmwegzsjelbrih
vercel deploy --prod --yes
```

- [ ] **Step 5: Live smoke**

Verify:

- `platform-publish` deployed function responds with the expected auth gate for anon requests.
- `ebay-bridge` deployed function responds with the expected auth gate for anon requests.
- `https://shopee-dashboard-kohl.vercel.app/v2/` returns HTML and includes current V2 app markers.
