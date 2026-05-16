# SKU Bulk-Sync Plan (CBSC global SKU edits via existing "Shopee 동기화" button)

| | |
|---|---|
| Author | Opus 4.7 (Claude Code, main session) |
| Date | 2026-05-12 |
| Target | shopee-dashboard — `index.html` + `supabase/functions/shopee-bridge/index.ts` + migration |
| Trigger | User request: "SKU 열에 수정하고 싶은 데이터를 입력하고 체크 박스 선택하고 Shopee 동기화 버튼을 눌렀을때 자동으로 변경되게" |
| API docs | `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\` — must consult per feedback memory |

---

## 0. Goal (one paragraph)

When the operator edits values in the SKU column of the 상품 마스터 table, checks one or more rows, and clicks the existing **☑ Shopee 동기화** button, the new SKUs should be pushed to Shopee's CBSC global product catalog. One global push propagates to all 6 region shops (SG/TW/TH/MY/PH/BR). The same button continues to push prices (current behaviour); SKU sync is *additive*.

---

## 1. Scope (v1, ship today)

### In scope
- Single-row (no variants) products: push `global_item_sku` via `v2.global_product.update_global_item`.
- Multi-model (variant) products: push variant SKUs via `v2.global_product.update_global_model`, batched per parent `global_item_id`.
- Operator can mix selected rows across multiple parents — implementation groups them.
- Status bar splits into two counters: `Price X/Y · SKU A/B`.
- Local DB persists `last_synced_sku` + `last_synced_sku_at` per region to enable future diff detection (even though v1 always pushes — see "Always push" decision below).

### Out of scope (v2+)
- Editing `global_item_name`, `global_item_description`, `weight`, `dimension` via the same flow (covered separately in `ready-stock-wizard-plan.md` Phase B).
- Diff detection ("only push if SKU changed") — v1 always pushes for simplicity.
- Rate limiting beyond Shopee's defaults — Promise.allSettled handles it for now.
- Multi-region per-shop SKU override (CBSC routes through global only).
- Renaming via Shopee shop-level `product/update_item` SKU param.

---

## 2. Shopee API reference (must match these specs exactly)

### `update_global_item`
- File: `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.update_global_item.json`
- POST `/api/v2/global_product/update_global_item`
- Body: `{ global_item_id (REQ, int64), global_item_sku (opt, string), ... }`
- Use case in v1: non-variant rows (no `shop_model_id` mapping). One call per row.

### `update_global_model`
- File: `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.update_global_model.json`
- POST `/api/v2/global_product/update_global_model`
- Body: `{ global_item_id (REQ), global_model[] (REQ, array of { global_model_id, global_model_sku }), ... }`
- Use case in v1: variant rows. One call per parent (`global_item_id`), batches all checked models of that parent.

### `get_global_model_list`
- File: `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.get_global_model_list.json`
- GET `/api/v2/global_product/get_global_model_list?global_item_id=...`
- Response: `response.global_model[].global_model_id`, `global_model_sku`, `tier_index[]`
- Use case in v1: only as a one-time backfill helper to map `shop_model_id → global_model_id` per parent. The result is persisted to `product_shopee_listings.global_model_id` so subsequent SKU pushes don't need this lookup.

### Errors
- All four endpoints share the standard Shopee error envelope `{ error, message, warning, request_id }`. Specific error codes per endpoint live in the same JSON's `errors` section — code must surface `error + message` verbatim, never paraphrase.

---

## 3. Data model

### 3.1 New columns on `product_shopee_listings`

```sql
alter table product_shopee_listings
  add column if not exists global_model_id bigint,
  add column if not exists last_synced_sku text,
  add column if not exists last_synced_sku_at timestamptz;
```

- `global_model_id`: nullable; only populated for variant listings (where `shop_model_id is not null`). Populated via "🔗 Shopee 매핑 동기화" flow when the existing mapping run resolves the parent's models, OR lazily on the first bulk-SKU-sync attempt against a parent missing it.
- `last_synced_sku`: stores what we last successfully pushed. Even though v1 always pushes, this column primes future diff-only logic.
- `last_synced_sku_at`: timestamp of last successful push.

### 3.2 No new columns on `products`
The local `products.sku` field is the single source of truth for "operator's desired SKU". Inline edits already persist via existing `Storage.update`.

---

## 4. shopee-bridge edge function changes

Two new actions; both go in the same `index.ts` next to the existing `update_global_item` / `update_global_model` blocks (lines 1247–1279). These already exist — verify the request body shape matches the official spec and is unchanged.

### 4.1 New action `resolve_global_models` (GET)

Wraps `/api/v2/global_product/get_global_model_list` so the frontend can backfill `global_model_id` for one parent at a time.

```typescript
if (action === 'resolve_global_models' && req.method === 'GET') {
  const region = url.searchParams.get('region') || 'SG';
  const global_item_id = parseInt(url.searchParams.get('global_item_id') || '');
  if (!global_item_id) return jsonResp({ ok: false, error: 'global_item_id required' }, 400);
  const result = await merchantApiCall(region, '/api/v2/global_product/get_global_model_list', {
    method: 'GET',
    query: { global_item_id },
  });
  return jsonResp({
    ok: !result.error,
    region, global_item_id,
    global_model: (result.response?.global_model || []).map((m: any) => ({
      global_model_id: m.global_model_id,
      global_model_sku: m.global_model_sku || '',
      tier_index: m.tier_index || [],
    })),
    result,
  });
}
```

### 4.2 Verify existing `update_global_item` and `update_global_model`

Already present at lines 1247 and 1261. **No changes needed** — both already match the official spec. Confirm via diff against the JSON spec during implementation; do not modify request shape on intuition.

---

## 5. Mapping-sync extension (frontend, `_shopeeSyncMapping*` block)

The existing "🔗 Shopee 매핑 동기화" flow already pulls shop-level `model_id` per region via `list_items`. Extend it to also call `resolve_global_models` for each unique `global_item_id` it discovers, then match local rows to global models by **`tier_index` parity with shop `model_id`'s tier_index from `get_model_list`** (Shopee's tier_index is consistent across shop ↔ global for the same option position in CBSC).

Pseudocode:
```js
// After existing mapping upsert completes:
const parentsByRegion = groupBy(mappedListings, 'global_item_id');
for (const [global_item_id, listings] of parentsByRegion) {
  const region = listings[0].region;
  const j = await fetch(`${SHOPEE_BRIDGE}/resolve_global_models?region=${region}&global_item_id=${global_item_id}`);
  const { global_model } = await j.json();
  // local rows already have tier_index captured during get_model_list pass;
  // match by tier_index → write global_model_id to product_shopee_listings.
  ...
}
```

If `tier_index` matching fails (e.g., shop & global tier orders diverge — should not happen for CBSC but guard), fall back to matching by current `model_sku == global_model_sku` for the parent's models. If both fail, skip and warn.

---

## 6. Bulk-sync extension (`_shopeeBulkSync`, `index.html` line 2462)

### 6.1 New flow

```
1. Collect checkedIds (existing).
2. Build per-row push targets:
   2a. priceTargets — existing logic (region × row), unchanged.
   2b. skuTargets — group checked rows by `global_item_id` (NOT region).
       For each parent group:
         - if all rows in group have `shop_model_id is null` and `global_item_id` set: one update_global_item call, body { global_item_id, global_item_sku: row.sku }.
         - else (variant parent): one update_global_model call, body { global_item_id, global_model: rows.map(r => ({ global_model_id, global_model_sku: r.sku })) }.
         - if any variant row is missing `global_model_id`: fetch on-the-fly via /resolve_global_models, persist to product_shopee_listings, then proceed.
3. Promise.allSettled both priceTargets and skuTargets in parallel.
4. On success per skuTarget: Storage.upsertShopeeListing({ last_synced_sku: row.sku, last_synced_sku_at: now }) for every affected (row, region) pair.
5. Status bar:
     `Price ${priceOk}/${priceTotal} · SKU ${skuOk}/${skuTotal}` (each part green if 100%, amber if partial, red if 0/N).
```

### 6.2 Choosing region for global_product calls

`update_global_item` / `update_global_model` are merchant-scoped (CBSC), but the shopee-bridge wrapper still accepts a `region` arg to pick the API host. Use `SG` as default (Shopee uses the production-shopeemobile-com host for all CBSC merchant calls regardless of region passed). If the bridge expects a specific region for routing, pick whichever listing has the lowest position to keep it deterministic.

### 6.3 Skip conditions (silent, but counted)

- Row has no `global_item_id` for any region: skip with `noGlobal` reason.
- Variant row has no resolvable `global_model_id` even after on-the-fly fetch: skip with `noGlobalModel` reason.
- `row.sku` is empty or whitespace: skip with `emptySku` reason.

Skip counts surface in the JSON output panel below the status bar (existing `<pre>` block).

---

## 7. Error handling

For each Shopee call, if the response has `result.error`:
- Surface the verbatim `error + message + request_id` in the per-row status tooltip and the JSON output panel.
- Do NOT retry automatically in v1.
- The Shopee API doc JSON's `errors` section lists known codes. Add a comment in the new sync code pointing future debuggers there:
  ```js
  // Shopee error codes → see C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.update_global_*.json#errors
  ```

---

## 8. Tests

Add lightweight integration-style tests (browser DOM-free helpers) in a new `tests/sku-bulk-sync.spec.mjs` (Node, run via `node --test`):

1. `groupRowsByParent` — given a list of selected rows with mixed parents, returns the correct {global_item_id → rows[]} map.
2. `buildSkuPayload` — given a parent group, returns the correct `{ action: 'update_global_item' | 'update_global_model', body }`.
3. Empty-SKU rows are excluded with reason `emptySku`.
4. Missing-global-item rows are excluded with reason `noGlobal`.

(Frontend `_shopeeBulkSync` itself is hard to unit-test without DOM; the testable parts are the pure data-shaping helpers extracted from it.)

---

## 9. Rollout order (single PR / multi commits)

To honour the "first deploy must include audit" principle from the Codex review of the Phase B plan, every commit below ships independently usable + reversible:

1. **Migration** — add the three columns. Safe alone (no code reads them yet).
2. **shopee-bridge** — add `resolve_global_models`. Safe alone (no caller yet).
3. **Mapping-sync extension** — populate `global_model_id` during 🔗 매핑 동기화. Safe alone (just data prep).
4. **Bulk-sync extension + status bar + tests** — the actual feature. Now everything aligns.

If commit 4 has a bug, revert just that commit and the mapping data + bridge action remain harmlessly present.

---

## 10. Verification

1. Apply migration via Supabase MCP → confirm columns exist.
2. Deploy bridge with new action → curl probe `resolve_global_models?region=SG&global_item_id=<known>` returns `global_model[]` with non-empty `global_model_id`s.
3. Run 🔗 매핑 동기화 once → spot-check `product_shopee_listings.global_model_id` populated for at least one variant parent.
4. **Burnable test product**: pick one CBSC product whose SKU change is operationally safe to revert. Edit one variant's SKU inline, check the row, click ☑ Shopee 동기화. Verify:
   - Shopee Seller Centre shows new SKU on all 6 regions within ~30s.
   - DB `last_synced_sku` + `last_synced_sku_at` are populated.
   - Status bar shows `SKU 1/1` (green).
5. Revert the SKU manually on the burnable product to restore state.

If step 4 surfaces an error code, look it up in the JSON spec's `errors` section before patching.

---

## 11. Open questions for Codex review

1. **Tier-index matching robustness** — is `tier_index` guaranteed identical between shop `get_model_list` and global `get_global_model_list` for CBSC products? If not, fallback path?
2. **CBSC region routing** — does shopee-bridge currently route `merchantApiCall(region, ...)` for global_product calls correctly regardless of `region`? Or is there a "master" region we should hard-pin?
3. **Concurrency of update_global_model vs update_price** — both run via Promise.allSettled in the new flow. Any rate-limit concern when both fire in parallel? Should SKU sync precede price sync, or run after, to keep the audit trail clean?
4. **Idempotency on duplicate clicks** — if user double-clicks the sync button, both runs hit Shopee. Need a debounce on the button beyond `btn.disabled = true`?
5. **Empty global_model_id auto-fetch** — fetching `resolve_global_models` inside the bulk sync flow adds latency. Should this be enforced upstream (block sync if missing) instead?

---

## Revision (Codex)

(To be filled in by Codex review pass.)
