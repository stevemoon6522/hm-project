# StarOneMall Vision Extraction Plan

**Date:** 2026-05-26  
**Author:** Claude Sonnet 4.6  
**Task:** Automatically extract K-pop album component lists from StarOneMall detail images using Claude Vision API.

---

## Decision Log (Telegram msg #983)

| Item | Decision |
|------|----------|
| Vision provider | Claude Vision API (Anthropic SDK) — operator already uses Anthropic API |
| Result language | English only |
| Trigger | Auto-extract on staronemall URL input (no separate button) |
| Caching | `products.components_extracted_en` TEXT column — no re-call once set |
| Apply flow | Show → operator reviews → Approve button → applied to description |

---

## Files Changed

### A. Migration
**`supabase/migrations/202605260100_sd_components_extracted.sql`**  
Adds three columns to `products` table:
- `components_extracted_en TEXT` — Claude Vision result (hyphen-prefixed English lines)
- `components_extracted_at TIMESTAMPTZ` — extraction timestamp
- `components_approved INTEGER DEFAULT 0` — 0=pending, 1=approved

All `ADD COLUMN IF NOT EXISTS` — idempotent.

### B. Edge Function
**`edge-functions/staronemall-vision/index.ts`**  
**`supabase/functions/staronemall-vision/index.ts`** (deploy target)

POST `/extract` handler:
1. `master_row_id = 0` → extract-only mode (no DB persist, used before row is saved)
2. `master_row_id > 0` → check DB cache first; if `components_extracted_en` exists, return cached
3. Fetch StarOneMall HTML → regex-extract wisacdn `_data/attach` / `_data/product` image URLs
4. Call `claude-sonnet-4-6` via Anthropic Messages API with image URL source
5. Persist result to `products` (skipped for master_row_id=0)
6. Return `{ ok, cached, persisted, components_en, image_url_used }`

2026-06 update: `/extract` also accepts `image_urls?: string[]` and `image_data_urls?: string[]` so V2 can send multiple operator-selected component-detail images in one Vision call. The function combines all selected images into one English hyphen list, bypasses DB cache when selected images are supplied, and returns `image_urls_used` plus image-source diagnostics.

Environment variable required: `ANTHROPIC_API_KEY` (Supabase secrets).

**CORS:** OPTIONS → 204 null body (per feedback_supabase_cors_204_no_body).

### C. UI Integration
**`v2/index.html`**

Changes:
1. Added `STARONEMALL_VISION_URL` constant (`${SUPABASE_URL}/functions/v1/staronemall-vision`)
2. Added components panel HTML below `#w-staronemall-preview` (spinner, result `<pre>`, error, approve/re-extract buttons)
3. Updated `bindRegisterStaronemallImage` schedule: on valid URL after 700ms debounce → calls `triggerComponentsExtraction(url)`
4. Re-extract button event listener inside `bindRegisterStaronemallImage`
5. New functions:
   - `triggerComponentsExtraction(url, forceReextract?)` — session-cached, calls edge function
   - `persistComponentsToDb(masterId, text)` — fallback persist when row was saved after extraction
   - `applyComponentsToDescription(text, masterId, url)` — inserts `[Inclusions]` section, marks approved
   - UI helpers: `showComponentsPanel`, `setComponentsLoading`, `showComponentsResult`, `showComponentsError`
6. Updated `openRegisterShopeeModal` product fetch to include `components_extracted_en, components_extracted_at, components_approved`

### D. This Plan File
**`plans/staronemall-vision-extraction-plan.md`**

---

## Data Flow

```
Operator enters staronemall URL
  → 700ms debounce
  → triggerComponentsExtraction(url)
      → check _componentsCache (session)
      → POST /staronemall-vision/extract
          → check products.components_extracted_en (DB cache)
          → fetch staronemall HTML
          → extract wisacdn image URL (regex)
          → Anthropic Messages API (claude-sonnet-4-6, image url source)
          → UPDATE products SET components_extracted_en = ..., approved = 0
      → show result in UI panel
  → Operator reviews
  → Click "✓ 승인 — description 에 적용"
      → insert [Inclusions] section into #w-description field
      → UPDATE products SET components_approved = 1
```

---

## Edge Cases

| Case | Handling |
|------|----------|
| No wisacdn image found in HTML | 422 error with message |
| ANTHROPIC_API_KEY not set | Clear error: "Add it via supabase secrets set" |
| URL changed after extraction | New URL triggers new extraction (different cache key) |
| master_row_id not yet known (draft) | master_row_id=0 → extract only, persist attempted after row saved |
| DB cache hit | Returns immediately, no Vision API call |
| Re-extract button | Busts session cache for that URL, calls API again (DB cache bypassed by re-extract is handled client-side; DB cache stays until row is re-extracted) |

---

## Verification Checklist

- [ ] `ANTHROPIC_API_KEY` present in Supabase secrets (`mgqlwgnmwegzsjelbrih`)
- [ ] Migration applied: `supabase db push` or MCP `apply_migration`
- [ ] Edge function deployed: `supabase functions deploy staronemall-vision`
- [ ] Open v2, go to 상품 등록, enter a staronemall URL
- [ ] Components panel appears with spinner → result
- [ ] Approve button inserts `[Inclusions]` into description field
- [ ] Re-extract button triggers fresh extraction (same URL, cache busted)
- [ ] Second load of same URL returns cached result (no Vision API call)

---

## Known Constraints

- `view-register-legacy` 5-step wizard only (not the 2-stage `openRegisterShopeeModal` flow)
- Image URL extraction is regex-based; if staronemall changes CDN URL structure, regex needs update
- `claude-sonnet-4-6` pricing: ~$3/MTok input + $15/MTok output (images ≈ 1-3K tokens)
- Re-extract bypasses client session cache but NOT DB cache — for a true DB re-extract, operator must clear `components_extracted_en` manually or use the DB panel
- V2 master registration caps selected component image sources at 20 Claude image blocks across all selected images; if the selected images split into more pieces, the operator must select fewer images.
