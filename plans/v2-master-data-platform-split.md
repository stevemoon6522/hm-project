---
title: v2 — master-data tab vs per-platform send split
author: Opus 4.7 (Claude Code)
date: 2026-05-27
status: planning
---

# Goal
Make the v2 "상품 등록 (마스터 데이터 일괄 생성)" tab purely about drafting
internal master rows. Every platform-specific input (Shopee/Joom/eBay) and
every per-platform publish action moves out to the "상품 목록" tab's new
single "플랫폼 전송" modal. Option images become operator-uploaded files
stored in Supabase Storage instead of free-form URLs.

# Operator answers (msg #1212)
1. **Storage**: Supabase Storage, new bucket `product-options`.
2. **Scope**: strip everything platform-specific from the master tab —
   including Shopee category/DTS + the Shopee publish flow. Master data is
   "초안 데이터 가공" only.
3. **Target placement**: single "플랫폼 전송" modal in 상품 목록, operator
   picks the platform inside.
4. **Legacy `_extra_images`**: delete from both UI and persistence.
5. **Future**: separate "구성품" tab will plug into per-platform
   description templates later — out of scope for this PR (memoised in
   project_sd_components_tab_planned.md).

# Current state (verified)
- File: `v2/index.html`. All UI is hand-built DOM via `el(...)`; no
  framework.
- Master-data tab card header builds Shopee/Joom/eBay blocks at
  `v2/index.html:10816-11017`.
- Per-option image inputs (main URL + extras + "+ 추가 이미지" button)
  at `v2/index.html:11141-11178`. `row._main_image` (string),
  `row._extra_images` (string[]) hold the values.
- Card-header platform fields live on `firstRow._shopee_category_id`,
  `firstRow._shopee_days_to_ship`, `firstRow._joomCategory`,
  `firstRow._joomBrand`, `firstRow._joomMainImageOverride`,
  `firstRow._ebayCategory`. `group.joomStatus`, `group.ebayStatus`,
  `group.shopeeStatus` track per-card publish state.
- Per-card publish handlers: `mrPromoteJoom`, `mrPromoteEbay`,
  `mrPromoteAll` (Shopee path inside).
- 상품 목록 view id: `view-products`, opened by tab button at
  `v2/index.html:998`. The promote button at `v2/index.html:1074`
  (`#mr-promote-btn`) currently navigates from master tab to 상품 목록 with
  an "전체 등록 → 상품 목록" label — its label/flow will change.
- 상품 목록 row renderer + action column: needs scoping below.

# Plan
## P1 — strip master tab UI
1. Delete the entire Shopee block (10816-10863), Joom block (10865-10957),
   eBay block (10959-11017). Keep the basics row (artist/album/version,
   매입가/무게).
2. Drop the per-card "전체 등록 → 상품 목록" button's Shopee publish kicker.
   Master tab's only outbound action becomes "마스터 등록 → 상품 목록"
   (saves rows, no platform calls).
3. Delete the extras image scaffolding in `renderOptionRow`
   (11152-11178): the `row._extra_images` init, the loop that renders each
   slot, and the "+ 추가 이미지" button. Keep only `row._main_image`.

## P2 — option image upload
4. Replace the `메인 이미지 URL` text input with two children:
   - a `<input type="file" accept="image/*">` styled as "이미지 첨부".
   - a read-only `<input type="text">` showing the uploaded URL (or a small
     preview thumbnail) after a successful upload.
5. New helper `uploadOptionImage(file, sku) → Promise<string>` that
   `POST`s a multipart form to a small Supabase Edge Function
   `upload-product-option-image` which writes the file to
   `product-options/<sku>/<timestamp>-<filename>` and returns the public
   URL. The Edge Function uses the project's service-role key (set as a
   secret) and returns `{ url }`.
6. On upload success → set `row._main_image = url`, paint the URL into the
   read-only field, light up the preview. On failure → red border + inline
   error text.

## P3 — 상품 목록 "플랫폼 전송" modal
7. Add a single "🚀 플랫폼 전송" action on each product row in 상품 목록.
   Clicking opens a modal with three tabs (Shopee / Joom / eBay) inside one
   dialog. Each tab holds the fields that used to live on the master card:
   - Shopee: category select + DTS.
   - Joom: category select + brand + main-image override.
   - eBay: category ID.
   Each tab has its own "발행" button that fires the existing
   `mrPromoteShopee/mrPromoteJoom/mrPromoteEbay` helpers, but reads inputs
   from the modal state instead of `firstRow._*`.
8. Modal opens with defaults pre-filled from the existing per-card
   defaults helper, so the operator only fills what changed.

## P4 — persistence cleanup
9. Drop `_extra_images` from any read/write path (search and remove). The
   master rows table will not write that column going forward.
10. One-shot migration script in `migrations/` that nulls `extra_images`
    column (or whatever the persisted column is named) for existing rows;
    column kept around for now to avoid breaking any consumer that still
    selects it.

## P5 — verification
11. Smoke: open master tab, paste a staronemall URL, see the rendered card
    has no platform sections, no extras, just the file-upload widget.
12. Smoke: register one master row, open 상품 목록, click "플랫폼 전송",
    flip through all three tabs, send to Shopee burnable shop.
13. Run existing manual QA list at `plans/v2-register-variants-plan.md` —
    P4 items 1-3 should still pass.

# Risks
- The "단일 모달 with 3 tabs" pattern is new in v2 — must not collide with
  the existing modal stack (e.g. PRE ORDER ack modal). Inspect
  `v2/index.html`'s existing modal markup before adding.
- Supabase Storage bucket needs to be created in the active project
  (`mgqlwgnmwegzsjelbrih`) with the right policies (operator-only write,
  public read).
- File upload size — cap at 5MB to avoid blocking the dashboard tab.
- Existing in-flight master rows (status='준비') may still carry
  `_extra_images` in their session state. Ignore them; the value is
  per-session and gets dropped on tab refresh.

# Out of scope
- The 구성품 (Components) tab — separate follow-up per
  project_sd_components_tab_planned.md.
- Description template editing — comes with the Components tab work.
- Bulk re-publish from 상품 목록 across multiple rows.
- Other marketplaces (Qoo10, Alibaba) — same pattern, but out of scope here.
