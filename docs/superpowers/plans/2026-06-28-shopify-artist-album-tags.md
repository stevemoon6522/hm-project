# Shopify Artist Album Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add artist and album tags to Shopify product creation without touching Shopify collection APIs.

**Architecture:** Reuse the existing shared K-pop title parser from `platform-publish/_shared/grouping.ts`. Keep Shopify tag generation inside `supabase/functions/platform-publish/adapters/shopify.ts`, and verify the behavior with static regression tests that extract and execute the adapter helper logic.

**Tech Stack:** Supabase Edge Function TypeScript, Node static regression tests, Shopify Admin GraphQL `ProductCreateInput.tags`.

---

## Files

- Modify: `scripts/test-shopify-product-registration.mjs`
- Modify: `supabase/functions/platform-publish/adapters/shopify.ts`
- Read-only reference: `supabase/functions/platform-publish/_shared/grouping.ts`
- Read-only reference: `C:\dev\api-refs\marketplaces\shopify\product-create-input.graphql.md`
- Read-only reference: `C:\dev\api-refs\marketplaces\shopify\collection.graphql.md`
- Read-only reference: `C:\dev\api-refs\marketplaces\shopify\tags-add.graphql.md`

## Task 1: Add Regression Coverage

**Files:**
- Modify: `scripts/test-shopify-product-registration.mjs`

- [x] **Step 1: Write the failing test**

Add assertions that:

```javascript
assert.match(shopifyAdapter, /deriveKpopFromTitle/, 'Shopify adapter must reuse the shared K-pop parser for artist/album tags');
assert.match(shopifyAdapter, /function shopifyArtistAlbumTagsFrom/, 'Shopify adapter must isolate artist/album tag derivation');
assert.doesNotMatch(shopifyAdapter, /collectionsToJoin|collectionAddProducts|collectionUpdate/, 'Shopify adapter must not manage collection membership for smart collections');
```

Then extract `tagsFrom()` and its helper block from `shopify.ts`, execute it with a representative CORTIS product, and assert:

```javascript
assert(tags.includes('CORTIS'), 'Shopify tags must include derived artist tag');
assert(tags.includes('GREENGREEN'), 'Shopify tags must include derived album tag');
assert(!tags.includes('WEVERSE'), 'Shopify tags must not include derived version tag');
```

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
node scripts\test-shopify-product-registration.mjs
```

Expected: FAIL because `shopify.ts` does not yet import `deriveKpopFromTitle` or expose `shopifyArtistAlbumTagsFrom`.

## Task 2: Implement Shopify Artist/Album Tags

**Files:**
- Modify: `supabase/functions/platform-publish/adapters/shopify.ts`

- [x] **Step 1: Import the shared parser**

Change the Shopify adapter import to include `deriveKpopFromTitle`:

```typescript
import { buildVariationItems, deriveKpopFromTitle, inferKpopBrandName, parentSku, publishableGroupRows } from '../_shared/grouping.ts';
```

- [x] **Step 2: Add helper functions**

Add focused helpers near `productTypeFrom()`:

```typescript
function isMeaningfulShopifyTagSource(value: unknown): boolean {
  const text = cleanText(value);
  return !!text && !/^no\s*brand$/i.test(text);
}

function shopifyArtistAlbumTagsFrom(master: Record<string, unknown>, shopify: Record<string, any>): string[] {
  const derived = deriveKpopFromTitle(shopify.title || master.product_name || master.sku);
  const artist = [
    shopify.artist,
    master.artist,
    derived.artist,
    master.brand,
    master.shopee_brand_name,
    master.qoo10_brand_name,
  ].find(isMeaningfulShopifyTagSource);
  const album = [
    shopify.album,
    master.album,
    master.release_title,
    derived.album,
  ].find(isMeaningfulShopifyTagSource);
  return [artist, album].map((value) => cleanText(value)).filter(Boolean);
}
```

- [x] **Step 3: Add the helper to `tagsFrom()`**

Add the helper spread after explicit tags and before operational tags:

```typescript
...shopifyArtistAlbumTagsFrom(master, shopify),
```

Keep the existing dedupe and cap logic unchanged.

- [x] **Step 4: Run test to verify it passes**

Run:

```powershell
node scripts\test-shopify-product-registration.mjs
```

Expected: PASS.

## Task 3: Verify Broader Regressions

**Files:**
- No code changes.

- [x] **Step 1: Run Shopify regression tests**

Run:

```powershell
node scripts\test-shopify-product-registration.mjs
node scripts\test-shopify-price-policy-db-ui.mjs
node scripts\test-platform-publish-group-registration.mjs
```

Expected: all commands exit 0.

- [x] **Step 2: Inspect diff**

Run:

```powershell
git diff --check
git diff --stat
```

Expected: no whitespace errors; diff only includes Shopify adapter, Shopify test, and Superpowers docs.
