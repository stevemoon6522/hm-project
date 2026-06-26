# Shopee SKU Mapping Context Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Shopee tab `SKU mapping` button map every option of an already-published Shopee Global Product group, including `A`, `Diary`, and `Z` options of `[READY STOCK] ATEEZ GOLDEN HOUR : Part.4`, instead of only the option that already has enough local Global Product context.

**Architecture:** Keep the V2 frontend as the orchestrator, but make it pass group-level Shopee context into `shopee-bridge/lookup-sku`. The bridge should resolve a SKU through the official Global Product and Shop Product APIs: Global model SKU -> published shop item ids -> shop model SKU. The frontend should then merge Global and Shop hits and upsert complete `product_shopee_listings` rows with both Global ids and Shop ids.

**Tech Stack:** Plain HTML/JS in `v2/index.html`, Supabase JS client, Supabase Edge Function TypeScript in `supabase/functions/shopee-bridge/index.ts` and `edge-functions/shopee-bridge/index.ts`, Node test runner.

---

## API Contract Used

Local Shopee API docs reviewed:

- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.search_item.json`
  - `GET /api/v2/product/search_item`
  - Required: `page_size`
  - Useful optional fields: `item_sku`, `item_name`, `item_status`, `offset`
  - Returns item id candidates; when `item_sku` and `item_name` are both provided, Shopee filters by `item_sku`.
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.get_model_list.json`
  - `GET /api/v2/product/get_model_list`
  - Required: `item_id`
  - Response includes `response.model[].model_id`, `response.model[].model_sku`, `response.model[].tier_index`.
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.get_global_item_info.json`
  - Required: `global_item_id_list`
  - Response includes `response.global_item_list[].global_item_id`, `global_item_name`, `global_item_sku`, `global_item_status`.
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.get_global_model_list.json`
  - Required: `global_item_id`
  - Response includes `response.global_model[].global_model_id`, `global_model_sku`, `tier_index`.
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.get_published_list.json`
  - Required: `global_item_id`
  - Optional: `shop_id_list`
  - Response includes `response.published_item[].shop_id`, `shop_region`, `item_id`, `item_status`.

Important implication: `get_published_list` does not return shop `model_id`. A deterministic Global Product mapping must call `product.get_model_list` on each published shop `item_id` and match `model_sku` to the requested SKU.

---

## Root Cause

Observed target Global Product:

- `global_item_id`: `54504712282`
- `A`: `global_model_id=400436990942`, `global_model_sku=O1-ATE-4GOLD-PHO-A`
- `Z`: `global_model_id=400436990943`, `global_model_sku=O1-ATE-4GOLD-PHO-Z`
- `DIARY`: `global_model_id=400436990944`, `global_model_sku=O1-ATE-4GOLD-PHO-DIARY`
- `SET`: `global_model_id=400436990945`, `global_model_sku=O1-ATE-4GOLD-PHO-SET`

Current behavior is asymmetric:

1. `SET` maps because that row already has enough local Global Product context for `lookup-sku` to find it.
2. `A`, `DIARY`, and `Z` are real Shopee options, but their product rows do not reliably carry the same `global_item_id` context.
3. `v2/index.html:29320` `coverageLookupShopeePublishedBySku()` builds the first `lookup-sku` query from only the selected product row and local rows for that exact `product_id`; it does not borrow sibling group context and currently does not append the known `global_item_id` to the main `lookup-sku` request.
4. `shopee-bridge` already accepts `global_item_id` in `lookup-sku` (`supabase/functions/shopee-bridge/index.ts:5322`), but the button path does not consistently provide it for sibling options.
5. `v2/index.html:29289` `coverageNormalizeShopeeSkuLookupHit()` chooses `global_region_hits` over `region_hits`:

```js
const rows = globalRows.length ? globalRows : shopRows;
```

This can discard shop-level `shop_item_id/shop_model_id` when both Global and Shop hits are present. The persisted mapping can become Global-only even when the bridge also found the actual published Shop model.

---

## File Structure

- Modify: `v2/index.html`
  - `loadData()` product select near `v2/index.html:6958`.
  - Shopee SKU mapping path: `coverageNormalizeShopeeSkuLookupHit()`, `coverageLookupShopeePublishedBySku()`, `coverageAbsorbShopeePublishedHit()`.
  - Shopee price sync mapping preflight path: `catFetchShopeeSkuLookupHits()`, `catShopeeSkuLookupHitsFromResponse()`, `catEnsureSelectedShopeeListings()`, `catBuildPriceSyncPayloads()`.
  - Add a small Shopee group-context helper near the coverage/SKU mapping helpers.
- Modify: `supabase/functions/shopee-bridge/index.ts`
  - Add deterministic Global Product -> published shop item -> shop model resolution in GET `lookup-sku`.
  - Reuse existing helpers where possible: `lookupShopeeGlobalSkuInItem()`, `fetchShopeeGlobalItemInfo()`, `shopeeSkuHitFromItemIds()`, `lookupShopeeSkuAcrossRegions()`.
- Modify: `edge-functions/shopee-bridge/index.ts`
  - Keep the deployed edge-function mirror in sync with `supabase/functions/shopee-bridge/index.ts`.
- Modify: `tests/shopee-sku-lookup-regression.test.mjs`
  - Add static coverage for the new bridge resolution path and source doc citations.
- Create or modify: `tests/v2-shopee-sku-mapping-regression.test.mjs`
  - Add executable frontend helper regression coverage for group context and result merging.

Implementation note: the working tree may contain unrelated user changes. Read the target files before editing and preserve unrelated diffs.

---

### Task 1: Add Failing Regression Tests

**Files:**
- Modify: `tests/shopee-sku-lookup-regression.test.mjs`
- Create or modify: `tests/v2-shopee-sku-mapping-regression.test.mjs`

- [ ] **Step 1: Bridge static regression**

Extend `tests/shopee-sku-lookup-regression.test.mjs` for both bridge copies:

- Assert GET `lookup-sku` still accepts `global_item_id`.
- Assert the bridge calls `/api/v2/global_product/get_published_list` inside the lookup path after a Global Product match.
- Assert published item ids are verified with `/api/v2/product/get_model_list`.
- Assert shop model matching uses exact `model_sku` equality.
- Assert `source_docs` cites:
  - `docs_ai/apis/global_product/v2.global_product.get_published_list.json`
  - `docs_ai/apis/product/v2.product.get_model_list.json:model_sku`

- [ ] **Step 2: Frontend context regression**

Add a focused test that extracts or mirrors the new helper behavior from `v2/index.html`:

- Given a product group where only the `SET` sibling has a listing row with `global_item_id=54504712282`, the lookup context for `A`, `DIARY`, and `Z` must include `54504712282`.
- The lookup query for each SKU must include:
  - `sku`
  - active Shopee regions
  - one or more `global_item_id` values from the selected row and siblings
  - product name / group name search terms as fallback hints

- [ ] **Step 3: Frontend merge regression**

Add a test for `coverageNormalizeShopeeSkuLookupHit()`:

- Input raw response has `region_hits` with `shop_item_id/shop_model_id` and `global_region_hits` with `global_item_id/global_model_id`.
- Expected normalized `regionHits` keep the shop ids and attach the matching Global ids.
- If only Global hits exist, expected output is still found, but rows are marked as Global-only and must not fake `shop_model_id`.

---

### Task 2: Load Required Shopee Columns in V2 State

**File:** `v2/index.html`

- [ ] **Step 1: Update product select**

Update the main `loadData()` products select around `v2/index.html:6958` to include existing Shopee Global columns:

- `global_model_id`
- `shopee_global_raw_payload`
- `shopee_global_model_raw_payload`
- `shopee_global_item_sku`
- `shopee_global_model_sku`

These columns already exist in migration `supabase/migrations/202605290002_shopee_global_import_master.sql`.

- [ ] **Step 2: Keep lightweight fallback selectors aligned**

Check V2 REST fallback selectors around `v2/index.html:23687` and `v2/index.html:23703`. They already include `global_model_id` and `shopee_global_model_sku`; only add missing raw/SKU fields if the helper needs them and the query remains stable.

---

### Task 3: Build Group-Aware Shopee Lookup Context

**File:** `v2/index.html`

- [ ] **Step 1: Add helper**

Add a helper near the coverage lookup functions, for example:

```js
function coverageShopeeGroupLookupContext(product) {
  // Return { globalItemIds, itemNameTerms, siblingProductIds }.
}
```

The helper should collect:

- selected product `shopee_item_id`
- selected product/listing `global_item_id`
- sibling products with the same `product_group_id`
- sibling `product_shopee_listings.global_item_id`
- useful item-name terms from `product_name`, `option_name`, and sibling group rows

- [ ] **Step 2: De-duplicate and constrain**

Deduplicate ids and terms. Only include finite positive numeric `global_item_id` values. Keep name terms bounded to a small list so the bridge does not fan out into unnecessary Shopee API calls.

- [ ] **Step 3: Use active Shopee regions**

Use `SHOPEE_PLATFORM_ACTIVE_REGIONS` as the default region list. Do not introduce hardcoded out-of-scope regions.

---

### Task 4: Pass Explicit Context to `lookup-sku`

**File:** `v2/index.html`

- [ ] **Step 1: Append Global ids**

In `coverageLookupShopeePublishedBySku()`, append every context `global_item_id` to the main `/lookup-sku` query before fetching:

```js
for (const id of context.globalItemIds) qs.append('global_item_id', String(id));
```

- [ ] **Step 2: Append fallback item names**

Append context item-name terms with repeated `item_name` query params. Keep the current selected product terms, but add sibling/group terms when present.

- [ ] **Step 3: Keep `published_list` fallback**

Keep the existing `/published_list` fallback, but treat it as a weaker fallback because it does not include `shop_model_id`. The main `lookup-sku` bridge path should become the preferred deterministic path.

---

### Task 5: Add Deterministic Bridge Resolution for Global Product Listings

**Files:**
- `supabase/functions/shopee-bridge/index.ts`
- `edge-functions/shopee-bridge/index.ts`

- [ ] **Step 1: Resolve Global model by SKU**

In GET `lookup-sku`, after `global_lookup` finds a matching `global_item_id/global_model_id/global_model_sku`, call `global_product.get_published_list` for that `global_item_id`.

- [ ] **Step 2: Filter published shop items**

Use only published rows whose `shop_region` is in `requestedRegions` and whose `item_status` is normal/listed enough for mapping. Preserve existing operating-region and account-key constraints.

- [ ] **Step 3: Verify shop model SKU**

For each published row, call `product.get_model_list` in the row's `shop_region` with the published `item_id`, then find `response.model[]` where `model_sku` exactly equals the requested SKU.

When found, push a normal `region_hits` row containing:

- `region`
- `shop_id`
- `shop_item_id` / `item_id`
- `shop_model_id` / `model_id`
- `global_item_id`
- `global_model_id`
- `model_sku`
- `global_model_sku`
- `lookup_source: 'global_published_model_list'`

- [ ] **Step 4: Keep fallback behavior**

If this deterministic path fails for a region, keep the current fallback order:

1. existing DB `product_shopee_listings`
2. `product.search_item` by `item_sku`
3. `product.search_item` by `item_name`
4. explicit scan fallback only when requested

- [ ] **Step 5: Add source docs**

Add `docs_ai/apis/global_product/v2.global_product.get_published_list.json:item_id` to `source_docs`, alongside existing `search_item`, `get_model_list`, `get_global_item_info`, and `get_global_model_list` citations.

---

### Task 6: Merge Global and Shop Hits in the Frontend Normalizer

**File:** `v2/index.html`

- [ ] **Step 1: Replace global-over-shop selection**

Change `coverageNormalizeShopeeSkuLookupHit()` so it does not choose one array:

```js
const rows = globalRows.length ? globalRows : shopRows;
```

Instead, normalize both arrays and merge them by region.

- [ ] **Step 2: Prefer shop ids**

For each region:

- keep `shop_item_id`, `shop_model_id`, and `shop_id` from `region_hits` when present
- attach `global_item_id` and `global_model_id` from the matching `global_region_hits`
- keep a Global-only row only when no shop hit exists for that region

- [ ] **Step 3: Preserve status filtering**

Keep status filtering for active/unlisted Shopee rows. Avoid accepting deleted, banned, or invalid remote rows as mapped.

---

### Task 7: Upsert Complete Mapping Rows

**File:** `v2/index.html`

- [ ] **Step 1: Persist complete ids**

Keep `coverageAbsorbShopeePublishedHit()` upserting `product_shopee_listings`, but ensure rows from the normalized hit can carry both:

- `global_item_id`, `global_model_id`
- `shop_id`, `shop_item_id`, `shop_model_id`

- [ ] **Step 2: Mark partial Global-only rows clearly**

If a row has only Global ids and no shop item/model ids, do not fake shop ids. Use the existing status conventions carefully:

- Prefer `status='mapped'` only for rows with `shop_item_id` or `shop_model_id`.
- For Global-only fallback, either use `status='mapped_global'` if the UI rollups support it, or keep `status='mapped'` with `last_error='shop_mapping_pending_global_only'` after confirming current UI expectations.

Before choosing, inspect `platform_listing_coverage` and V2 rollup logic so the LED/status UI does not regress.

---

### Task 8: Extend the Same Fix to Shopee Price Sync

**File:** `v2/index.html`

**Additional production symptom:** `[READY STOCK] BOYNEXTDOOR 1st Studio Album [HOME] (SWEET HOME ver.)` can fail when only the `RANDOM` option is selected in the price sync screen. This is not fully covered by the Shopee tab SKU mapping button plan because price sync uses its own preflight/mapping helpers.

Current price sync risk points:

- `catProductGlobalItemId(product, byRegion)` only checks the selected product and that product's listing rows.
- `catFetchShopeeSkuLookupHits()` calls `/lookup-sku` without sibling `global_item_id` context.
- `catShopeeSkuLookupHitsFromResponse()` only reads `region_hits` and `region_results[].hit`; it ignores `global_region_hits`.
- `catEnsureSelectedShopeeListings()` therefore may fail to create a complete `product_shopee_listings` row before `catBuildPriceSyncPayloads()` builds `/update_price` payloads.

- [ ] **Step 1: Reuse group context for price sync**

Make the group-context helper usable from both:

- `coverageLookupShopeePublishedBySku()`
- `catFetchShopeeSkuLookupHits()`

For a selected option row such as `RANDOM`, context must include sibling `global_item_id` values from the same `product_group_id`.

- [ ] **Step 2: Pass Global ids into price sync lookup**

Change `catFetchShopeeSkuLookupHits(sku, targetRegions, product)` so it appends context `global_item_id` query params to `/lookup-sku`.

- [ ] **Step 3: Read Global hits in price sync lookup parsing**

Change `catShopeeSkuLookupHitsFromResponse()` so it reads `global_region_hits` as well as `region_hits` and `region_results[].hit`.

Do not treat Global-only hits as sufficient for an `/update_price` payload. They are useful as fallback context, but the price sync payload still requires `shop_item_id`, and model products require `shop_model_id`.

- [ ] **Step 4: Prefer complete shop hits**

When both shop and Global hits exist, use the shop hit for `shop_item_id/shop_model_id` and attach `global_item_id/global_model_id` when available. This keeps price sync from sending item-level price updates to a variant item.

- [ ] **Step 5: Regression case**

Add a regression test where:

- selected product is `RANDOM`
- selected product has no local `global_item_id`
- sibling product/listing has `global_item_id`
- `/lookup-sku` response includes both `region_hits` and `global_region_hits`
- price sync helper returns a hit with `shop_item_id`, `shop_model_id`, `global_item_id`, and `global_model_id`

---

### Task 9: Verification

**Commands:**

```powershell
node --test tests\shopee-sku-lookup-regression.test.mjs
node --test tests\v2-shopee-sku-mapping-regression.test.mjs
```

If `v2-product-list-regression.test.mjs` is touched or helper extraction affects product-list logic:

```powershell
node --test tests\v2-product-list-regression.test.mjs
```

**Live bridge smoke after deployable implementation:**

- Call `shopee-bridge/lookup-sku` for:
  - `O1-ATE-4GOLD-PHO-A`
  - `O1-ATE-4GOLD-PHO-DIARY`
  - `O1-ATE-4GOLD-PHO-Z`
  - `O1-ATE-4GOLD-PHO-SET`
- Include `global_item_id=54504712282`.
- Expected:
  - `found=true`
  - `region_hits` exists for active regions where the item is published
  - each hit has `shop_item_id` and `shop_model_id`
  - each hit also carries matching `global_item_id` and `global_model_id`

**V2 rendered checkpoint:**

Before production deployment, run the local V2 app and verify the Shopee tab mapping button on the target product group. The UI should map `A`, `DIARY`, `Z`, and `SET`, then refresh `product_shopee_listings` without clearing valid sibling mappings.

---

### Task 10: Commit and Deploy Only After Steve Requests the Fix

- [ ] Validate tests and rendered V2 behavior.
- [ ] Commit scoped changes only.
- [ ] Push `main`.
- [ ] Deploy with:

```powershell
vercel deploy --prod --yes
```

- [ ] Smoke-check `https://shopee-dashboard-kohl.vercel.app/v2/`.

Suggested commit message:

```text
fix: map Shopee sibling option SKUs with global context
```
