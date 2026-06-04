# eBay Price-Sync Phase 2 (live sync) — Implementation Plan

Last updated: 2026-06-04
Author: Opus (Claude Code)
Task: Wire the live "동기화" action for the eBay tab in the V2 가격 동기화 view, so selecting
eBay rows and clicking 동기화 pushes the computed USD price to the live eBay listing — mirroring
the existing `catExecuteJoomSync` flow. Qoo10 is OUT of scope here (awaiting operator's formula +
API-status decisions).

## Operating Rule

Smallest units, validation gate between each. After any change, review locally first.
**Production deploy (edge function + V2) ONLY after Steve explicitly says so** (AGENTS.md gate).
This pushes real prices to a live marketplace — confirm() before push, dry-run + single-SKU test
before any batch, no auto-deploy.

Codex is available again (operator confirmed 2026-06-04) → adversarial reviews go through Codex.

---

## 1. What already exists (verified)

- Phase 1 (committed `d369376`): eBay tab active, USD preview via `calculateEbayPrice`
  (`v2/price-engine.js`), current price from `products.ebay_last_synced_price`, and a safe routing
  guard where `catExecuteSelectedSync` 'ebay' case currently just shows a "preview only" toast
  (`v2/index.html` ~16531).
- DB (project `mgqlwgnmwegzsjelbrih`): `products` has `ebay_sku, ebay_offer_id, ebay_status,
  ebay_last_synced_price, ebay_last_synced_at, ebay_marketplace_id, ebay_category_id` — confirmed
  via SQL. **No migration needed for Phase 2 eBay.**
- ebay-bridge (`supabase/functions/ebay-bridge/index.ts`): helper `ebayFetch(path, init)` handles
  OAuth token + headers (`:118`). `createOrUpdateOfferForSku` (`:411`) does full-offer PUT — NOT to
  be reused for price-only. `handleLookupItem` (`:841`) already calls
  `GET /sell/inventory/v1/offer?sku=...&marketplace_id=...` (getOffers) and returns offers with
  `offerId`, `status` (PUBLISHED/…), `listingId`. Router (`:991-1034`) actions: healthz, lookup-item,
  lookup-group, publish, publish-variation. Browser calls are allowed (auth boundary =
  `requireAuthenticatedUser`; the internal bridge token is NOT required for lookup/publish).
- Joom template: `catExecuteJoomSync` (`v2/index.html:16164-16288`) — confirm(), per-row loop,
  lookup → update-price → persist `*_last_synced_price/at` + cost via `catPersistProductCost`,
  per-row `errors[]`, single re-render, toast.

## 2. Official API basis (api-refs — read, not assumed)

`api-refs/marketplaces/ebay/sell/inventory.yaml`:
- `POST /bulk_update_price_quantity` (`bulkUpdatePriceQuantity`, `:484-518`): updates price and/or
  quantity of up to 25 offers for ONE SKU/product per request entry; **published offers are revised
  as live listings**; "not designed to work with unpublished offers" (use updateOffer for those).
- Request `BulkPriceQuantity` (`:6987`): `{ requests: [ PriceQuantity ] }`.
- `PriceQuantity` (`:10544`): `{ offers: [OfferPriceQuantity], shipToLocationAvailability?, sku? }`.
  `sku`/`shipToLocationAvailability` only needed when changing total ship-to-home qty.
- `OfferPriceQuantity` (`:10177`): `{ offerId, price?: Amount, availableQuantity?: int }`.
  **CRITICAL: "Either the availableQuantity field or the price container is required, but not
  necessarily both."** → A price-only update sends `{ offerId, price }` and OMITS
  `availableQuantity` → **stock is left untouched. We do NOT need to fetch current quantity.**
- `Amount`: `{ value: "32.99", currency: "USD" }` (string value).

## 3. Design

### 3a. New ebay-bridge action: `update-price` (POST)
Request body: `{ sku: string, priceUsd: number, marketplaceId?: "EBAY_US" }`.
Steps (handler `handleUpdatePrice`):
1. `validateSku(sku)`; require `priceUsd` finite and > 0 (else 400).
2. `getOffers`: `ebayFetch('/sell/inventory/v1/offer?sku=' + enc(sku) + '&marketplace_id=' + mkt)`.
   - 404 / empty → `{ ok:false, error:'no_offer_for_sku' }`.
3. Select **PUBLISHED** offers (`status === 'PUBLISHED'`). If none published but offers exist →
   `{ ok:false, error:'offer_not_published' }` (price-sync only revises live listings; do NOT
   silently updateOffer a draft).
4. Build price-only request:
   `{ requests: [ { offers: publishedOffers.map(o => ({ offerId:o.offerId, price:{ value:String(priceUsd.toFixed(2)), currency:'USD' } })) } ] }`
   (all published offers for this SKU in one request entry; ≤25; chunk if ever >25).
5. `ebayFetch('/sell/inventory/v1/bulk_update_price_quantity', { method:'POST', body })`.
   - On 200, inspect `BulkPriceQuantityResponse.responses[]` for per-offer `statusCode`/`errors`.
   - Return `{ ok, offerIds, listingId, price: priceUsd }` or `{ ok:false, error, upstream }`.
6. Wire into router next to publish (no internal-token requirement; `requireAuthenticatedUser`
   remains the boundary). Add `Content-Type: application/json` (ebayFetch already sets it).

### 3b. New V2 function: `catExecuteEbaySync()` (mirror `catExecuteJoomSync`)
1. `await catFlushSelectedInlineEdits({ persistWeight:true })`; `products = catSelectedProducts()`.
2. Guard: empty → toast; else `confirm('eBay 가격을 실동기화합니다 … 대상 N건 … 진행할까요?')`.
3. `EBAY_BRIDGE = SHOPEE_BRIDGE.replace('/shopee-bridge','/ebay-bridge')` (same pattern as Joom).
4. Per product:
   - `sku = product.ebay_sku || product.sku`; skip with error if no `ebay_sku` ("eBay 미등록").
   - `newCost`, `weightG`; `priceUsd = catComputeEbayPrice(newCost, weightG)`; skip if null/≤0.
   - POST `${EBAY_BRIDGE}/update-price` `{ sku, priceUsd }` with `AUTH_HEADERS`.
   - On ok: `catPersistProductCost(id, newCost, now)` + `products.update({ ebay_last_synced_price:
     priceUsd, ebay_last_synced_at: now })`; mirror into in-memory `product`. On fail: push to `errors`.
5. `applyAndRenderCatalog()`; toast summary (`eBay 가격 동기화 완료 (N건)` / first error).

### 3c. Routing
`catExecuteSelectedSync` 'ebay' case: replace the Phase-1 "preview only" toast with
`catExecuteEbaySync()`. Qoo10 case stays the stub toast. Shopee/Joom unchanged. Default still safe.

## 4. Decisions (defaults)

| # | Decision | Default |
|---|----------|---------|
| E1 | Stock preservation | Offer-only price payload (no availableQuantity / shipToLocationAvailability / sku). Per spec this leaves qty alone, but **must be confirmed by a single-SKU before/after qty smoke test** (§RC1) — not assumed. |
| E2 | Offer resolution | getOffers by `ebay_sku`, keep `PUBLISHED && FIXED_PRICE`; if caller passed `offerId` (`products.ebay_offer_id`) require it in that set and use only it; zero → fail, >1 → fail ambiguous (§RC3). Never touch auction offers. |
| E3 | Unpublished offers | Skip with `offer_not_published` (price-sync revises live listings only) |
| E4 | Variation products | Each variant = its own `products` row with its own `ebay_sku` → per-row update covers them. ONE SKU per `update-price` call (§RC2); no cross-SKU batching. |
| E5 | Marketplace | EBAY_US only |
| E6 | Migration | None (columns exist) |
| E7 | Deploy | Edge fn + V2 deploy only on Steve's explicit go; dry-run + 1-SKU live test first |

## 5. Steps (each with verify gate)

1. **ebay-bridge `update-price`** → `deno check` the function; unit-reason the request shape vs the
   yaml schema. Verify gate: Codex review of the handler + no deploy yet.
2. **`catExecuteEbaySync` + routing** in V2 → local render, switch to eBay tab, confirm 동기화 now
   routes to eBay (not the stub) and still never to Shopee. No live call in local review (or test
   against a single known SKU only with operator present).
3. **Codex adversarial review** of the full diff (bridge + V2).
4. **Operator gate**: dry-run/single-SKU live test with Steve, then deploy on his go.

## 6. Risks

- **Wrong/stale price to live listing** — mitigated by reusing the verified `calculateEbayPrice`
  (parity-tested in Phase 1), confirm() dialog, single-SKU test before batch.
- **Clobbering stock** — mitigated by offer-only price payload (E1); spec-permitted but VERIFY with a
  single-SKU before/after qty smoke test before any batch (§RC1).
- **Touching an auction listing** — avoided by FIXED_PRICE-only + offerId-match resolution (§RC3).
- **False success on partial failure** — avoided by strict per-offer `responses[]` check (§RC4).
- **Revising a draft/unpublished offer** — avoided by E3 (published-only).
- **Rate limit** — eBay allows 250 revisions/listing/day; batch sizes are small; fine.
- **Token/auth** — reuses the working `getValidAccessToken`/`ebayFetch` path that registration uses.

## Revision (Codex — 2026-06-04) — AUTHORITATIVE; supersedes conflicting text above

**Verdict: REVISE.** Codex (restored) reviewed against code + `inventory.yaml`. Apply all of:

**§RC1 — Soften the stock claim; PROVE it with a smoke test.** The YAML *permits* a price-only
shape (`OfferPriceQuantity` `:10195-10197`: availableQuantity OR price), but "runtime never
zeroes/resets qty" is NOT provable from the YAML. So: send an **offer-only** payload with NO
`availableQuantity`, NO `shipToLocationAvailability`, NO request-level `sku`. THEN, before any batch,
do a **single-SKU before/after quantity smoke test** (getOffers qty → update-price → getOffers qty
unchanged) with the operator. Treat stock-preservation as "expected per spec, must be verified live",
not "eliminated".

**§RC2 — One SKU per call.** The operation note (`inventory.yaml:491-492`, `:516-517`) says only one
SKU per call. Do NOT batch multiple different-SKU offers across `requests[]`. Our per-row sync loops
per product anyway → **one `update-price` call per selected row (one SKU)**. The bridge handles one
SKU per request.

**§RC3 — Resolve offer safely: FIXED_PRICE + offerId match, fail on ambiguity.** A SKU can have both
an auction and a fixed-price offer (`inventory.yaml:3793-3796`, `:10378-10391`; offer `format`
`:7330-7334`). The bridge must: getOffers(sku, EBAY_US) → keep offers with
`status==='PUBLISHED' && format==='FIXED_PRICE'`. If the caller passed `offerId`, require it to be in
that set and use ONLY it. If no offerId passed: exactly one match → use it; zero → `offer_not_found`;
>1 → `ambiguous_offers` (fail, do not guess). Never touch auction offers.

**§RC4 — Strict success check (partial failure).** `bulkUpdatePriceQuantity` returns HTTP 200 with a
per-offer `responses[]` (`inventory.yaml:7005-7013`, `:10597-10624`). Success ONLY when HTTP 200 AND
every `responses[]` entry has `statusCode===200` AND no `errors`. Otherwise return ok:false with the
per-offer error. Mirror the lookup path's 401/403/429 passthrough (`ebay-bridge/index.ts:854-858`).

**§RC5 — Require `ebay_sku`; NO fallback to internal sku.** `product.sku` ≠ `ebay_sku`; falling back
would push to the wrong/nonexistent offer. `catExecuteEbaySync` uses `sku = product.ebay_sku` and
HARD-SKIPS rows where it's null (error: "eBay 미등록"). Pass `offerId: product.ebay_offer_id` (if
present) for §RC3 disambiguation.

**§RC6 — Add columns to BOTH product selects.** Phase 1 added ebay_offer_id/status/last_synced_price
but NOT `ebay_sku`/`ebay_marketplace_id`/`ebay_last_synced_at`. Add all three to the primary and
fallback `select=` in `fetchCatalogData`. **Verified via SQL (project `mgqlwgnmwegzsjelbrih`): all
seven eBay columns exist** (`ebay_sku, ebay_offer_id, ebay_marketplace_id, ebay_status,
ebay_last_synced_price, ebay_last_synced_at, ebay_category_id`) — adding them won't 400 the catalog,
and NO migration is needed (Codex's "unverifiable" caveat resolved).

**§RC7 — Amount shape.** `price: { value: priceUsd.toFixed(2), currency: 'USD' }` (value is a string,
currency required — `inventory.yaml:6737-6750`). Bridge rejects non-finite or ≤0 priceUsd.

**§RC8 — Line numbers shifted by Phase 1.** Do NOT trust the line refs in §1/§3; grep. Current:
`catExecuteJoomSync` ≈ `v2/index.html:16388-16512`, eBay route stub ≈ `:16533-16535`,
`catSelectedProducts` ≈ `:15960`. Sonnet must grep to locate, not trust these.

Net: design is sound; these tighten safety (no auction touch, strict success, right identifier) and
correct the stock-claim epistemics. After implementation: Codex code review → operator single-SKU
live smoke test (incl. before/after qty) → deploy only on Steve's go.
