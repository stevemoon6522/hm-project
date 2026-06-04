# Qoo10 & eBay Price-Sync Activation Plan

Last updated: 2026-06-04
Author: Opus (Claude Code)
Task: Enable Qoo10 and eBay in the V2 가격 동기화 (price-sync) tab — make the tabs
active, drop the "준비중" label, and wire real price preview + live sync, mirroring
the existing Shopee/Joom implementation.

## Operating Rule

Smallest practical units, validation gate between each. After any V2 HTML/app change,
review the rendered LOCAL `/v2/` app before any production deploy. Edge-function and
production deploy ONLY after Steve explicitly asks (AGENTS.md deployment gate). This
touches LIVE marketplaces (real money) — no live price push until the operator confirms
the price formula and API-live status per platform.

---

## 1. Current State (verified in code)

The price-sync view (`#view-price-sync`) has full engines for **Shopee** (6 region
columns, V1 fee formula) and **Joom** (single global USD price). Platform routing is
conditional on `_catActivePlatform` at these points:

- Tabs markup: `v2/index.html:2467-2471` — Qoo10/Alibaba/eBay carry `aria-disabled="true"`.
- "준비중" label: CSS `::after` on `.cat-platform-tab[aria-disabled="true"]` — `v2/index.html:880-886`.
- Tab click handler: `initCatPlatformTabs()` `v2/index.html:16304-16329` — disabled tabs show a toast and return.
- Headers: `catBuildRegionHeaders()` `:14575` → joom branch or Shopee.
- Cells: `catBuildRegionCells()` `:14600` → joom branch or Shopee.
- Inline re-render: `catUpdateRowPriceCells()` `:14685` → joom branch or Shopee.
- Summary row: `:14920` and `:15128` → joom branch or Shopee.
- Region-filter visibility: `catSyncPlatformActions()` `:16292` → hides Shopee market chips for Joom.
- Sync button routing: `catExecuteSelectedSync()` `:16299` → `catExecuteJoomSync()` or `catExecuteShopeeLive()`.

There is **no** Qoo10/eBay branch anywhere in the price-sync code today.

### eBay — feasible now
- Price formula EXISTS and is fee-based (parity with Shopee/Joom):
  `_v2EbayCalcUsdListing(costKrw, weightG, c)` → **USD**, `v2/index.html:20635-20658`.
  Country settings from `country_settings` row code **'EX'** via `_v2LoadEbayExCountry()` `:20491`.
- Current price storage EXISTS: `products.ebay_last_synced_price`, `ebay_last_synced_at`
  (migration `202605260001_sd_ebay_schema.sql:50-61`).
- Listed-item identifier EXISTS: `products.ebay_offer_id` (used in PUT offer).
- Live push: **do NOT reuse `createOrUpdateOfferForSku`** — it PUTs the FULL `offerBody`
  (`ebay-bridge/index.ts:437`, body at `:601-623` includes availableQuantity, listingPolicies,
  categoryId, description), so a price-only re-PUT clobbers those fields. CORRECTION (review):
  the correct price-only call is `POST /sell/inventory/v1/bulk_update_price_quantity`
  (`bulkUpdatePriceQuantity`, doc `api-refs/marketplaces/ebay/sell/inventory.yaml:484-518`):
  keyed by `offerId`, updates price/qty of up to 25 offers per SKU without touching
  title/policies/category, revises the live listing directly (no re-publish). It DOES
  require `availableQuantity` per offer → fetch current qty first (getOffer/getOffers) or
  carry it, to avoid resetting stock. A new `update-price` action must be ADDED to
  ebay-bridge. Bridge actions today: healthz, lookup-item, lookup-group, publish,
  publish-variation. See Revision §R1.
- **Variation listings:** a variation product has MULTIPLE offers — migration
  `202606020003_ebay_kpop_variation_publish.sql:55` stores `ebay_offer_ids text[]`; each
  variant SKU gets its own offer (`ebay-bridge:751-774`). Singular `ebay_offer_id` only
  covers single-item listings. See Revision §R3.
- **Scope blocker:** the `_v2Ebay*` functions are nested inside another closure
  (indent level 4, around the eBay registration modal), NOT at the top level where the
  `cat*` price-sync functions live. They are not directly callable from price-sync code.

### Qoo10 — mechanically possible, several gaps
- Registration price is a **stub**, not a fee-based selling price:
  `mrQoo10BasePriceFromRows()` `v2/index.html:11455` = `max(1, round(cost_krw / 10))` JPY,
  min across the group, default 2990. Currency = **JPY**.
- **No** current-price column on `products` (`qoo10_last_synced_price` does not exist).
- **No** persisted Qoo10 item id (`qoo10_item_code`/`goods_no`) — identity is resolved
  live via `qoo10-bridge /lookup-sku?sku=&item_code=` → `goods_no` (like Joom lookup).
- Live push: **no price-only endpoint exists in qoo10-bridge today.** `qoo10-bridge
  /edit-inventory` (`ItemsOptions.EditGoodsInventory`, handler `:475`) edits per-OPTION
  price deltas bounded to ±50% of base price (doc `api-refs/.../10018-EditGoodsInventory.md`),
  CANNOT change the base selling price, and omitting stock sends qty 0 — wrong tool.
  CORRECTION (review): the plan originally claimed a "RetailPrice handler at `:523`" — that
  is FALSE; `:516-569` is `handleCreateListing`/`ItemsBasic.SetNewGoods` (new-listing
  creation). The correct price-only API is `ItemsOrder.SetGoodsPriceQty` (method 10024,
  doc `api-refs/.../10024-SetGoodsPriceQty.md`): send `Price`, omit `Qty` → preserves stock.
  A new `set-price` action must be ADDED to qoo10-bridge. See Revision §R2.
- Project memory: Qoo10/KSE API was "paused awaiting approval" (2026-05-04). Live-push
  may still be blocked.

---

## 2. Goal & Success Criteria

Operator selects the Qoo10 or eBay tab in 가격 동기화 and sees, per selected SKU:
current price, computed new price, Δ%, mapping status — then "동기화" pushes the new
price to that marketplace and persists current price + cost, exactly like Joom does today.

Verify:
1. Tabs are active (no "준비중") for Qoo10 + eBay; Alibaba stays disabled with "준비중".
2. Selecting eBay shows a single USD price column set (현재가 / 신규가 / 매핑) and Δ%.
3. Selecting Qoo10 shows a single JPY price column set and Δ%.
4. 동기화 routes to the correct platform; never silently pushes Shopee while on Qoo10/eBay.
5. eBay live push updates the offer and persists `ebay_last_synced_price/at`.
6. Qoo10 live push updates the item price WITHOUT zeroing stock, persists current price.
7. Local `/v2/` render reviewed before any deploy.

---

## 3. Open Decisions (defaults chosen; operator may override)

| # | Decision | Default |
|---|----------|---------|
| D1 | Qoo10 sync price formula — `cost/10` stub vs a real fee-based JPY engine | Use existing `cost/10` registration formula for parity NOW; flag as stub, build real engine only if operator gives Qoo10 fee table |
| D2 | Qoo10 currency shown | JPY (matches registration + edit-inventory) |
| D3 | Qoo10 current-price persistence | Add `qoo10_last_synced_price` + `qoo10_last_synced_at` columns (migration) for Joom-style delta |
| D4 | Qoo10 live-push endpoint | **[REVISED §R2]** Add a `set-price` action to qoo10-bridge calling `ItemsOrder.SetGoodsPriceQty` (10024) with `{ItemCode, SellerCode, Price}`, NO `Qty` (preserves stock). Do NOT use `edit-inventory`/`EditGoodsInventory` |
| D5 | eBay price-update mechanism | **[REVISED §R1]** Add an `update-price` action to ebay-bridge calling `bulkUpdatePriceQuantity` keyed by `offerId`, carrying current `availableQuantity`. Do NOT re-PUT the full offer via `createOrUpdateOfferForSku` |
| D6 | eBay/Qoo10 formula reuse | **[REVISED §R4]** Add `calculateEbayPrice` + `calculateQoo10Price` to `price-engine.js` next to `calculateJoomPrice`; have BOTH the registration modal and `cat*` call the shared engine. Do NOT extract `_v2Ebay*` out of its IIFE (registration depends on it). cat* must also load the 'EX' `country_settings` row + eBay shipping-rate table or the formula returns 0 |
| D7 | Markets in scope | eBay = EBAY_US only; Qoo10 = QSM Japan (JPY) only |
| D8 | Auto cron | Manual tab only. NOTE [§R5]: `sd-automation-cron` does NOT do price sync ("Price/cost change detection is excluded", `:150`) — nothing to add to; moot |
| D9 | Live execution gate | Build everything, but live push to Qoo10/eBay stays disabled in deploy until operator confirms D1/D4 + Qoo10 API-live status |
| D10 | Variant/multi-offer model | **[NEW §R3]** `catSelectedProducts()` returns individual `products` rows (`:15736`). eBay variation products carry `ebay_offer_ids[]` (one offer per variant) → update each via the same `bulkUpdatePriceQuantity` batch (≤25/SKU). Qoo10 `SetGoodsPriceQty` sets the item base price (covers single-SKU); per-option Qoo10 pricing is OUT of scope for v1 |

---

## 4. Implementation Steps (each with a verify gate)

**Step 1 — Tab activation + safe routing guard (smallest unit, no live risk)**
- Remove `aria-disabled="true"` from Qoo10 + eBay tabs (`:2469`, `:2471`). Keep Alibaba disabled.
- `catExecuteSelectedSync()`: add explicit `qoo10`/`ebay` routing. Until their sync fns
  exist, route to a stub that shows "준비 안내" instead of falling through to Shopee.
- Verify: clicking Qoo10/eBay no longer shows "준비중"; 동기화 never triggers Shopee push.

**Step 2 — eBay price preview (read-only)**
- Extract `_v2Ebay*` pricing helpers to a scope reachable by `cat*` (D6). Load 'EX'
  country settings into `_catCountrySettingsByRegion` (or a dedicated cache).
- Add `catComputeEbayPrice(costKrw, weightG)`, `catBuildEbayHeaders()`, `catBuildEbayCells(product,...)`,
  `catEbaySummaryCells()`, and branches in the 6 conditional points (mirror Joom).
- Current price from `ebay_last_synced_price`; status from `ebay_status`/`ebay_offer_id`.
- Verify locally: eBay tab shows USD 현재가/신규가/Δ%/매핑, no console errors.

**Step 3 — eBay live sync**
- Add `update-price` action to ebay-bridge calling `bulkUpdatePriceQuantity` (D5/§R1):
  resolve offer set for the SKU (`ebay_offer_id` or `ebay_offer_ids[]`), fetch current
  `availableQuantity` per offer (getOffer/getOffers) so stock is not reset, then bulk-update
  price (USD, 2dp) for up to 25 offers/SKU.
- Add `catExecuteEbaySync()` mirroring `catExecuteJoomSync()` (`:16164-16288`): confirm()
  prompt, skip rows with no offer id, per-row error collection, persist
  `ebay_last_synced_price/at` + cost, single re-render at end.
- Verify: dry-run shape first; live push on 1 test SKU only after operator OK.

**Step 4 — Qoo10 price preview (read-only)**
- Migration: add `qoo10_last_synced_price numeric`, `qoo10_last_synced_at timestamptz` (D3).
- Add `catComputeQoo10Price()` (D1 stub), `catBuildQoo10Headers/Cells/SummaryCells`, branches.
- Currency JPY; current price from new column (null → "—").
- Verify locally: Qoo10 tab renders JPY columns, no errors.

**Step 5 — Qoo10 live sync**
- Confirm Qoo10 API-live status (D1/D9) with operator.
- Add `set-price` action to qoo10-bridge → `ItemsOrder.SetGoodsPriceQty` with `Price` only,
  no `Qty` (§R2). Add `catExecuteQoo10Sync()`: lookup-sku (→ ItemCode/goods_no) → set-price
  → persist `qoo10_last_synced_price/at` + cost, mirroring Joom error handling.
- Verify: live push gated on operator confirmation.

**Step 6 — Full regression**
- Shopee + Joom unchanged; switching tabs re-renders cleanly; selection/Δ summary correct.
- Codex adversarial review of the code; smoke tests; operator scenario.

---

## 5. Risks

- **Live mis-pricing (highest):** any wrong formula/currency pushes bad prices to a live
  marketplace. Mitigation: D9 gate, dry-run + single-SKU test, operator confirmation.
- **Qoo10 stock clobbering:** `edit-inventory` writes qty. Mitigation: D4 — use a
  price-only/RetailPrice method or fetch+preserve current qty.
- **Qoo10 formula is a stub:** `cost/10` JPY is not a real selling price. Mitigation: D1
  flag; do not enable Qoo10 live push until a real fee engine or explicit operator sign-off.
- **eBay function scope extraction** could regress the eBay registration modal. Mitigation:
  extract carefully, keep registration call sites intact, smoke-test registration preview.
- **Qoo10 API approval** may still be pending. Mitigation: confirm before Step 5 live.

---

## Revision (Adversarial review — 2026-06-04)

Codex credits were exhausted (reset 2026-06-08), so the adversarial review was run by an
independent reviewer agent that verified every claim against the code AND the official API
docs under `api-refs/`. **Verdict: REVISE** — direction and safety thesis correct (routing
guard, scope blocker, stub formula, live gate), but the original plan named the WRONG
live-push APIs for both platforms and missed variation listings. Steps 3 and 5 must be
implemented as revised below, not as originally written.

**§R1 — eBay: use `bulkUpdatePriceQuantity`, not a full-offer re-PUT.**
`createOrUpdateOfferForSku` PUTs the entire `offerBody` (`ebay-bridge:437`, body `:601-623`
with availableQuantity/listingPolicies/categoryId/description) — a price-only re-PUT would
clobber those. Correct: `POST /sell/inventory/v1/bulk_update_price_quantity`
(`api-refs/marketplaces/ebay/sell/inventory.yaml:484-518`), keyed by `offerId`, price+qty for
≤25 offers/SKU, revises live listing without re-publish. Requires `availableQuantity` per
offer → fetch current (getOffer/getOffers) or carry it so stock isn't reset. Add a new
`update-price` action to ebay-bridge.

**§R2 — Qoo10: use `ItemsOrder.SetGoodsPriceQty` (10024), not `EditGoodsInventory`.**
`EditGoodsInventory` (`qoo10-bridge:475-514`, `buildItemType:293-310`) edits per-option price
deltas bounded ±50% of base (doc `10018:20`), cannot change base price, and omitting stock
sends qty 0. The plan's "RetailPrice handler at :523" was a misread — `:516-569` is
`handleCreateListing`/`ItemsBasic.SetNewGoods` (creation). Correct: `ItemsOrder.SetGoodsPriceQty`
(doc `api-refs/.../10024-SetGoodsPriceQty.md`) with `Price` set and `Qty` omitted → updates
price, preserves stock. Add a new `set-price` action to qoo10-bridge.

**§R3 — Variation/multi-offer listings.** `catSelectedProducts()` (`:15736-15741`) returns
individual `products` rows. eBay variation products store `ebay_offer_ids text[]`
(migration `202606020003:55`), one offer per variant SKU (`ebay-bridge:751-774`); singular
`ebay_offer_id` only covers single-item listings. Resolve the full offer set per selected
row and bulk-update all (≤25/SKU). Qoo10 `SetGoodsPriceQty` sets the item base price
(covers single-SKU); per-option Qoo10 pricing is out of scope for v1.

**§R4 — Formula reuse: share via `price-engine.js`, don't extract `_v2Ebay*`.** The
`_v2Ebay*` helpers live inside the MASTER REGISTER IIFE (`(function(){` `:18020` … `})();`
`:22726`); registration consumes them at `:21765,21843,21903,22043,22677` and persists
`ebay_last_synced_price/at` at `:22174,22201`. Moving them risks breaking registration.
Instead add `calculateEbayPrice({costKrw,weightG,countrySettings})` (port of
`_v2EbayCalcUsdListing` `:20635-20658` + the US shipping-rate lookup it needs) and
`calculateQoo10Price` to `price-engine.js` beside `calculateJoomPrice` (`:200`); have BOTH
registration and `cat*` call the shared engine. **cat\* must also load the 'EX'
`country_settings` row and the eBay shipping-rate table** (`_v2LoadEbayExCountry:20491`,
`_v2EbayGetShippingRateKrw:20590`) into its scope or `calculateEbayPrice` returns 0
(it returns 0 when exchangeRate/shipping missing — `:20638,20640`).

**§R5 — Cron correction.** `sd-automation-cron` does NOT do price sync ("Price/cost change
detection is excluded", `sd-automation-cron/index.ts:150`) — it only builds a digest and
retries failed Shopee mutations. D8 is moot; manual-only stands.

**Idempotency / formatting (nice-to-have, adopt):** mirror `catExecuteJoomSync`'s per-row
error array + status persistence + single end re-render; add a `confirm()` before live push
like Joom (`:16171`); format USD 2dp (`toFixed(2)`) vs JPY integer (`Math.round`); both
`bulkUpdatePriceQuantity` and `SetGoodsPriceQty` are safe to re-run on already-synced rows.

**Verified accurate (no change):** Shopee fall-through routing (`:16299-16302`); tab
`aria-disabled` (`:2469/:2471`) + "준비중" CSS (`:880-886`); `mrQoo10BasePriceFromRows`
= `max(1, min(round(cost/10)))` default 2990 JPY (`:11455`); `_v2EbayCalcUsdListing` fee-based
USD (`:20635-20658`); eBay migration columns (`202605260001`); no existing Qoo10/eBay
branch in `cat*`.
