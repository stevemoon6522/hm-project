# Shopee Price Sync Latency Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the time between clicking the V2 Shopee price-sync button and seeing completion, without weakening SKU/model safety checks or Shopee mutation auditability.

**Architecture:** Keep the existing browser-orchestrated flow and Shopee bridge `/update_price` endpoint. Improve latency by increasing safe region concurrency from 4 to 6, bulk-persisting post-update DB rows, and adding lightweight timing evidence so future slowdowns are measurable instead of guessed.

**Tech Stack:** Plain JavaScript in `v2/index.html`, Supabase JS client, existing Supabase Edge Function `shopee-bridge`, Node `assert`/`vm` regression scripts.

---

## Evidence and Constraints

Observed live test on `2026-06-26`:

- Product option: `D2-BOY-HOME-SWE-RANDOM`
- Changed Cost `13281 -> 14281`, synced 6 Shopee regions, then restored `14281 -> 13281`.
- Changed-price sync completed successfully but took about `7.5s`.
- Restore sync completed successfully and took about `2.5s`.

Local Shopee API docs checked:

- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.update_price.json`
  - `POST /api/v2/product/update_price`
  - Required body: `item_id`, `price_list`, `price_list[].original_price`
  - Optional: `price_list[].model_id`
  - `price_list` sample says length should be between `1` and `50`
  - No explicit API rate limit is present in the local normalized doc.
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.get_model_list.json`
  - Used by preflight/model verification when local mappings are not trusted.

Important safety constraint:

- Do not remove `catEnsureSelectedShopeeListings()` or `catPreflightShopeePayloads()`. They are the guardrails that prevent wrong `item_id/model_id` price updates.
- Do not skip mutation logging. The bridge already inserts mutation logs and frontend avoids double-write when `log_id` exists.
- Keep Shopee update concurrency bounded. The first safe target is `6`, matching the active operating regions `SG/TW/TH/MY/PH/BR`.

---

## File Structure

- Modify: `v2/index.html`
  - `SHOPEE_PRICE_UPDATE_PARALLELISM`
  - `catExecuteShopeeLive()`
  - Add helpers near `catInsertShopeePriceLog()` / `catApplyShopeeListingCache()`
  - Add small internal timing helper near Shopee price sync helpers
- Modify: `scripts/test-v2-shopee-bulk-price-stability.mjs`
  - Update static concurrency assertion
  - Add executable VM tests for post-sync persistence batching and timing output shape
- No Edge Function changes in Phase 1.

Future Phase 2 candidate if Phase 1 is still not enough:

- Add `supabase/functions/shopee-bridge/index.ts` route `/update_price_batch` that accepts multiple region/item payloads and handles mutation logging server-side in one browser request.
- This is intentionally not part of Phase 1 because it changes the client/bridge contract and needs broader live smoke coverage.

---

### Task 1: Add Latency Regression Expectations

**Files:**

- Modify: `scripts/test-v2-shopee-bulk-price-stability.mjs`

- [ ] **Step 1: Update the concurrency assertion**

Replace:

```js
assert.match(priceSync, /const SHOPEE_PRICE_UPDATE_PARALLELISM = 4/, 'Shopee live price sync must cap region update concurrency');
```

with:

```js
assert.match(priceSync, /const SHOPEE_PRICE_UPDATE_PARALLELISM = 6/, 'Shopee live price sync should run the six active Shopee regions in one bounded wave');
```

- [ ] **Step 2: Add static assertions for the new post-sync persistence helper**

Add after the existing `catInsertShopeePriceLog` assertion:

```js
assert.match(priceSync, /async function catPersistShopeeSyncResults\(updateResults,\s*now\)/, 'Shopee live sync must batch post-update DB persistence after update_price returns');
assert.match(liveSync, /const persistResult = await catPersistShopeeSyncResults\(updateResults,\s*now\)/, 'Shopee live sync must delegate logs, listing upserts, and cost persistence to the batched helper');
assert.doesNotMatch(liveSync, /for \(const result of updateResults\)[\s\S]*await db\.from\('product_shopee_listings'\)\.upsert/, 'Shopee live sync must not upsert listing rows sequentially per region after update_price');
```

- [ ] **Step 3: Add a VM harness for post-sync persistence batching**

Add this helper near the existing VM harness helpers:

```js
async function runPersistResultsHarness() {
  const context = {
    Date,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    Set,
    String,
    console,
    globalThis: null,
    SHOPEE_DEFAULT_ACCOUNT_KEY: 'starphotocard',
    dbCalls: [],
    cacheRows: [],
  };
  context.globalThis = context;
  context._catCache = { listings: context.cacheRows, products: [
    { id: 'random', sku: 'D2-BOY-HOME-SWE-RANDOM', cost_krw: 13281 },
  ] };
  context.db = {
    from(table) {
      return {
        insert(row) {
          context.dbCalls.push({ table, method: 'insert', row });
          return Promise.resolve({ error: null });
        },
        upsert(rows) {
          context.dbCalls.push({ table, method: 'upsert', rows });
          return Promise.resolve({ error: null });
        },
        update(fields) {
          return {
            eq(column, value) {
              context.dbCalls.push({ table, method: 'update', fields, eq: { column, value } });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  vm.createContext(context);

  const harness = `
  ${extractFunction(v2, 'catApplyShopeeListingCache')}
  ${extractFunction(v2, 'catInsertShopeePriceLog')}
  ${extractFunction(v2, 'catPersistProductCost')}
  ${extractFunction(v2, 'catPersistShopeeSyncResults')}
  (async function() {
    const updateResults = [
      {
        ok: true,
        json: { ok: true, log_id: 'edge-log-sg' },
        errorMsg: null,
        p: {
          productId: 'random',
          sku: 'D2-BOY-HOME-SWE-RANDOM',
          region: 'SG',
          itemId: 41232027442,
          modelId: 346113183677,
          globalItemId: 54504712282,
          globalModelId: 346113183677,
          newCost: 14281,
          price: 18.26,
          payloadHash: 'dry:abc',
          payload: { region: 'SG', item_id: 41232027442, price_list: [{ model_id: 346113183677, original_price: 18.26 }] },
          listing: { status: 'mapped' },
        },
      },
      {
        ok: true,
        json: { ok: true, log_id: 'edge-log-tw' },
        errorMsg: null,
        p: {
          productId: 'random',
          sku: 'D2-BOY-HOME-SWE-RANDOM',
          region: 'TW',
          itemId: 53062837241,
          modelId: 366113187448,
          globalItemId: 54504712282,
          globalModelId: 366113187448,
          newCost: 14281,
          price: 418,
          payloadHash: 'dry:def',
          payload: { region: 'TW', item_id: 53062837241, price_list: [{ model_id: 366113187448, original_price: 418 }] },
          listing: { status: 'mapped' },
        },
      },
    ];
    globalThis.result = await catPersistShopeeSyncResults(updateResults, '2026-06-26T00:00:00.000Z');
  })();
  `;

  await new vm.Script(harness, { filename: 'v2-shopee-persist-results-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify({
    result: context.result,
    dbCalls: context.dbCalls,
    cacheRows: context.cacheRows,
  }));
}
```

- [ ] **Step 4: Add assertions for the persistence harness**

Add near the bottom with the existing async harness assertions:

```js
const persistHarness = await runPersistResultsHarness();
assert.equal(persistHarness.result.okCount, 2, 'batched persistence should count successful Shopee region updates');
assert.deepEqual(persistHarness.result.errors, [], 'batched persistence should not report errors for successful rows');
assert.equal(
  persistHarness.dbCalls.filter((call) => call.table === 'product_shopee_listings' && call.method === 'upsert').length,
  1,
  'listing rows should be persisted with one bulk upsert instead of one upsert per region',
);
assert.equal(
  persistHarness.dbCalls.filter((call) => call.table === 'products' && call.method === 'update').length,
  1,
  'product cost should be persisted once per product even when multiple regions succeed',
);
assert.equal(persistHarness.cacheRows.length, 2, 'local listing cache should be updated for each successful region');
```

- [ ] **Step 5: Run the test and verify it fails**

Run:

```powershell
node scripts\test-v2-shopee-bulk-price-stability.mjs
```

Expected: FAIL because `SHOPEE_PRICE_UPDATE_PARALLELISM` is still `4` and `catPersistShopeeSyncResults()` does not exist.

---

### Task 2: Increase Safe Region Update Parallelism

**Files:**

- Modify: `v2/index.html`

- [ ] **Step 1: Change the concurrency cap**

Replace:

```js
const SHOPEE_PRICE_UPDATE_PARALLELISM = 4;
```

with:

```js
const SHOPEE_PRICE_UPDATE_PARALLELISM = 6;
```

Reason: V2 operates six active Shopee regions, and the local `v2.product.update_price` doc has no explicit rate limit while supporting a `price_list` length of `1..50`. Six keeps the request wave bounded but avoids a second wave for the normal SG/TW/TH/MY/PH/BR case.

- [ ] **Step 2: Run the focused test**

Run:

```powershell
node scripts\test-v2-shopee-bulk-price-stability.mjs
```

Expected: still FAIL only on missing batched persistence helper assertions.

---

### Task 3: Batch Post-Update Persistence

**Files:**

- Modify: `v2/index.html`

- [ ] **Step 1: Add listing row builder**

Add after `catApplyShopeeListingCache()`:

```js
function catShopeeListingUpsertRowFromPayload(p, nowIso) {
  return {
    product_id: p.productId,
    account_key: SHOPEE_DEFAULT_ACCOUNT_KEY,
    region: p.region,
    global_item_id: p.globalItemId || p.listing?.global_item_id || null,
    global_model_id: p.globalModelId || p.listing?.global_model_id || null,
    shop_item_id: p.itemId,
    shop_model_id: p.modelId || null,
    last_synced_price: p.price,
    last_synced_at: nowIso,
    status: p.listing?.status || 'mapped',
  };
}
```

- [ ] **Step 2: Add batched persistence helper**

Add after `catInsertShopeePriceLog()`:

```js
async function catPersistShopeeSyncResults(updateResults, now) {
  const errors = [];
  const okPayloads = [];
  const logTasks = [];
  const costByProduct = new Map();

  for (const result of updateResults) {
    const p = result.p;
    const json = result.json || null;
    const ok = result.ok === true;
    const errorMsg = result.errorMsg || null;

    if (result.preRetry) {
      logTasks.push(catInsertShopeePriceLog(p, 'error', result.preRetry.json, result.preRetry.errorMsg));
    }
    logTasks.push(catInsertShopeePriceLog(p, ok ? 'ok' : 'error', json, errorMsg));

    if (!ok) {
      errors.push(p.sku + ' ' + p.region + ': ' + errorMsg);
      continue;
    }

    okPayloads.push(p);
    if (!costByProduct.has(String(p.productId))) {
      costByProduct.set(String(p.productId), { productId: p.productId, sku: p.sku, newCost: p.newCost });
    }
  }

  await Promise.all(logTasks);

  if (okPayloads.length) {
    const listingRows = okPayloads.map(function(p) {
      return catShopeeListingUpsertRowFromPayload(p, now);
    });
    const { error: upsertErr } = await db.from('product_shopee_listings')
      .upsert(listingRows, { onConflict: SHOPEE_LISTING_CONFLICT });
    if (upsertErr) {
      for (const p of okPayloads) {
        errors.push(p.sku + ' ' + p.region + ': DB listing update ' + upsertErr.message);
      }
    } else {
      okPayloads.forEach(function(p) {
        catApplyShopeeListingCache(p, now);
      });
    }
  }

  const costResults = await Promise.all(Array.from(costByProduct.values()).map(async function(row) {
    const persisted = await catPersistProductCost(row.productId, row.newCost, now);
    return { row: row, persisted: persisted };
  }));
  for (const result of costResults) {
    if (!result.persisted.ok) {
      errors.push(result.row.sku + ': cost update ' + result.persisted.error);
    }
  }

  return {
    okCount: okPayloads.length,
    errors: errors,
  };
}
```

- [ ] **Step 3: Replace the sequential post-update loop in `catExecuteShopeeLive()`**

Replace the block starting at:

```js
const updateResults = await catRunShopeePriceUpdates(preflight.valid);
for (const result of updateResults) {
```

through the matching `okCount++` loop end with:

```js
const updateResults = await catRunShopeePriceUpdates(preflight.valid);
showToast('Shopee 가격 반영 완료, DB 기록 저장 중...', '');
const persistResult = await catPersistShopeeSyncResults(updateResults, now);
okCount = persistResult.okCount;
errors.push.apply(errors, persistResult.errors);
```

Then remove this now-unused local variable:

```js
const costPersisted = new Set();
```

- [ ] **Step 4: Run focused test**

Run:

```powershell
node scripts\test-v2-shopee-bulk-price-stability.mjs
```

Expected: PASS.

---

### Task 4: Add Lightweight Timing Evidence

**Files:**

- Modify: `v2/index.html`
- Modify: `scripts/test-v2-shopee-bulk-price-stability.mjs`

- [ ] **Step 1: Add timing helper**

Add near Shopee price-sync helper functions:

```js
function catSyncTimingStart() {
  return {
    startedAt: (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(),
    steps: [],
  };
}

function catSyncTimingMark(timing, label) {
  if (!timing) return;
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  timing.steps.push({
    label: label,
    elapsedMs: Math.round(now - timing.startedAt),
  });
}

function catSyncTimingSummary(timing) {
  if (!timing || !timing.steps.length) return '';
  return timing.steps.map(function(step) {
    return step.label + '=' + step.elapsedMs + 'ms';
  }).join(' ');
}
```

- [ ] **Step 2: Mark Shopee live sync phases**

In `catExecuteShopeeLive()`, add:

```js
const timing = catSyncTimingStart();
```

after:

```js
let skippedCount = 0;
const errors = [];
```

Then add marks:

```js
catSyncTimingMark(timing, 'inline');
```

after `await catFlushSelectedInlineEdits({ persistWeight: false });`

```js
catSyncTimingMark(timing, 'mapping');
```

after `await catEnsureSelectedShopeeListings();`

```js
catSyncTimingMark(timing, 'preflight');
```

after `const preflight = await catPreflightShopeePayloads(payloads);`

```js
catSyncTimingMark(timing, 'update');
```

after `const updateResults = await catRunShopeePriceUpdates(preflight.valid);`

```js
catSyncTimingMark(timing, 'persist');
console.info('[CAT live] Shopee price sync timing:', catSyncTimingSummary(timing));
```

after `const persistResult = await catPersistShopeeSyncResults(updateResults, now);`

- [ ] **Step 3: Add static timing assertions**

In `scripts/test-v2-shopee-bulk-price-stability.mjs`, add:

```js
assert.match(priceSync, /function catSyncTimingStart\(/, 'Shopee live sync must expose lightweight timing instrumentation');
assert.match(liveSync, /catSyncTimingMark\(timing,\s*'mapping'\)/, 'Shopee live sync timing must measure mapping hydration');
assert.match(liveSync, /catSyncTimingMark\(timing,\s*'preflight'\)/, 'Shopee live sync timing must measure preflight');
assert.match(liveSync, /catSyncTimingMark\(timing,\s*'update'\)/, 'Shopee live sync timing must measure update_price calls');
assert.match(liveSync, /catSyncTimingMark\(timing,\s*'persist'\)/, 'Shopee live sync timing must measure DB persistence');
```

- [ ] **Step 4: Run focused test**

Run:

```powershell
node scripts\test-v2-shopee-bulk-price-stability.mjs
```

Expected: PASS.

---

### Task 5: Full Verification and Live Smoke

**Files:**

- No additional code changes.

- [ ] **Step 1: Run focused scripts**

Run:

```powershell
node scripts\test-v2-shopee-bulk-price-stability.mjs
node scripts\test-v2-price-sync-v1-parity.mjs
```

Expected:

- `v2 Shopee bulk price stability checks passed`
- `v2 price sync V1 parity checks passed`

- [ ] **Step 2: Run broader Node regression set touched by recent Shopee mapping work**

Run:

```powershell
node --test tests\shopee-sku-lookup-regression.test.mjs tests\v2-shopee-sku-mapping-regression.test.mjs tests\v2-product-list-regression.test.mjs
```

Expected: all tests pass.

- [ ] **Step 3: Run deployment guard**

Run:

```powershell
npm run verify:v2-deploy-source
```

Expected:

```text
V2 deployment guard passed for C:\dev\shopee-dashboard-shopee-sku-price-fix
```

- [ ] **Step 4: Local browser smoke**

Run local static server from the worktree:

```powershell
npx --yes http-server . -p 4174 -c-1
```

Open:

```text
http://127.0.0.1:4174/v2/
```

Verify:

- V2 loads with no console errors.
- Shopee price sync tab opens.
- Selecting `D2-BOY-HOME-SWE-RANDOM` and changing Cost still updates preview values before live sync.

- [ ] **Step 5: Production live smoke after deploy**

Use Chrome logged-in session:

1. Open `https://shopee-dashboard-kohl.vercel.app/v2/`.
2. Shopee tab -> search `SWEET HOME`.
3. Select `[READY STOCK] BOYNEXTDOOR 1st Studio Album [HOME] (SWEET HOME ver.)`.
4. Open `가격 수정`.
5. Expand group, leave only `RANDOM` selected.
6. Change Cost `13281 -> 14281`.
7. Click `동기화`.
8. Confirm toast: `Shopee 가격 동기화 완료 (6건)`.
9. Confirm row shows updated current prices:
   - SG `18.26 -> 18.26`
   - TW `418 -> 418`
   - TH `542 -> 542`
   - MY `57.79 -> 57.79`
   - PH `837 -> 837`
   - BR `85.61 -> 85.61`
10. Restore Cost `14281 -> 13281`.
11. Click `동기화`.
12. Confirm final row shows:
   - SG `17.10 -> 17.10`
   - TW `391 -> 391`
   - TH `509 -> 509`
   - MY `54.10 -> 54.10`
   - PH `784 -> 784`
   - BR `81.35 -> 81.35`

Record the console timing line:

```text
[CAT live] Shopee price sync timing: inline=...ms mapping=...ms preflight=...ms update=...ms persist=...ms
```

Success criterion:

- Normal 6-region single-option sync should complete in one update wave.
- If the timing line still shows most time in `update`, Phase 2 should move to bridge-side `/update_price_batch`.
- If timing line shows most time in `mapping` or `preflight`, Phase 2 should add stronger trusted mapping timestamps and avoid repeated model-list lookups.

---

## Commit Plan

Make one scoped commit after verification:

```powershell
git add v2/index.html scripts/test-v2-shopee-bulk-price-stability.mjs docs/superpowers/plans/2026-06-26-shopee-price-sync-latency.md
git commit -m "perf: reduce Shopee price sync latency" -m "Co-Authored-By: Codex <codex@openai.com>"
```

Then push/deploy per project instructions:

```powershell
git push origin HEAD:main
supabase functions deploy shopee-bridge --project-ref mgqlwgnmwegzsjelbrih
vercel deploy --prod --yes --scope moon-jeonghos-projects
```

Note: Supabase function deploy is not required for Phase 1 code changes, but run it only if the execution branch includes any bridge changes. If only `v2/index.html` and scripts changed, skip Supabase deploy.

---

## Self-Review

- Spec coverage: addresses click-to-completion latency through region concurrency, post-update DB batching, and timing evidence.
- API safety: keeps `catEnsureSelectedShopeeListings()`, `catPreflightShopeePayloads()`, mutation logging, and bounded concurrency.
- No placeholders: every code-editing step has concrete replacement/addition snippets.
- Type consistency: new helper returns `{ okCount, errors }`, and `catExecuteShopeeLive()` consumes exactly those names.
