# Shopee Update Price Batch Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bridge-side `/update_price_batch` endpoint so V2 Shopee price sync can send one browser request while the Edge Function safely fans out to existing Shopee `v2.product.update_price` calls.

**Architecture:** Do not use Shopee `batch_update_outlet_price`; that API is Outlet/Mart scoped and remains outside normal V2 price sync. Extract the existing single `/update_price` mutation behavior into a shared bridge helper, then have both `/update_price` and `/update_price_batch` use the same idempotency hash, `failure_list` handling, mutation log format, and rollback metadata. Keep frontend SKU/model preflight unchanged, and only replace the transport layer after valid payloads have already been built.

**Tech Stack:** Supabase Edge Function TypeScript in `supabase/functions/shopee-bridge/index.ts` and mirrored `edge-functions/shopee-bridge/index.ts`, plain JavaScript in `v2/index.html`, Node `assert`/`vm` regression scripts, local Shopee API docs in `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product`.

---

## Evidence and Constraints

Local Shopee API docs checked first:

- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.update_price.json`
  - Official endpoint is `POST /api/v2/product/update_price`.
  - Required body fields are `item_id`, `price_list`, and `price_list[].original_price`.
  - `price_list[].model_id` is optional; V2 already sends `model_id: 0` for no-model items.
  - `price_list` sample says length should be between `1` and `50`.
  - Response may contain `response.failure_list[]`; a Shopee response with no top-level `error` can still contain per-model failures.
- `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.get_model_list.json`
  - Frontend preflight already uses model-list information to block wrong `item_id/model_id` combinations before mutation.
  - Recent fields such as `has_promotion`, `local_price`, and `local_promotion_price` explain why promotion and local-price errors must remain surfaced from Shopee responses.

Existing code constraints:

- Normal V2 price sync must stay on shop-level `v2.product.update_price`.
- Do not route normal V2 sync to `/api/v2/product/batch_update_outlet_price`.
- Keep `catEnsureSelectedShopeeListings()` and `catPreflightShopeePayloads()` in the browser before any live update call.
- Keep per-underlying-update mutation logs. A batch request must not collapse six regional Shopee mutations into one aggregate log only.
- Preserve the existing idempotency hash for single updates so `/update_price` and `/update_price_batch` skip the same already-successful payloads.
- Keep bridge copies identical: `supabase/functions/shopee-bridge/index.ts` and `edge-functions/shopee-bridge/index.ts`.

Expected improvement:

- Browser request overhead becomes one `/update_price_batch` fetch instead of up to six concurrent `/update_price` fetches for the normal SG/TW/TH/MY/PH/BR case.
- Shopee API time may still dominate. The timing log added in Phase 1 remains the measurement source for whether update time improves after deployment.

---

## File Structure

- Modify: `supabase/functions/shopee-bridge/index.ts`
  - Add `UPDATE_PRICE_BATCH_PARALLELISM` and `UPDATE_PRICE_BATCH_MAX_UPDATES`.
  - Add strict batch row normalizer.
  - Extract existing `/update_price` behavior into `executeShopUpdatePriceMutation()`.
  - Refactor `/update_price` route to call the helper.
  - Add `/update_price_batch` route that validates rows and uses `mapWithConcurrency()`.

- Modify: `edge-functions/shopee-bridge/index.ts`
  - Keep byte-for-byte identical with the Supabase function copy after bridge edits.

- Modify: `v2/index.html`
  - Add frontend batch-route helpers near existing Shopee price sync helpers.
  - Change `catRunShopeePriceUpdates()` to prefer `/update_price_batch`.
  - Keep existing per-batch/per-payload fallback path for route unavailable, network failure, and logistics repair retries.

- Modify: `scripts/test-v2-shopee-bulk-price-stability.mjs`
  - Add bridge static assertions for `/update_price_batch`.
  - Add VM tests for frontend batch-route response attribution, unavailable-route fallback, and per-model `failure_list` attribution.

- Modify: `scripts/test-shopee-bridge-image-hardening.mjs`
  - Extend bridge-copy and `update_price` assertions to include the shared helper and new batch route.

- Modify: `scripts/test-shopee-batch-price-probe.mjs`
  - Keep the existing guard that normal V2 sync must not use `batch_update_outlet_price`.
  - Add an explicit assertion that `/update_price_batch` internally calls `/api/v2/product/update_price`, not `/api/v2/product/batch_update_outlet_price`.

- No DB migration is required.

---

### Task 1: Add Regression Expectations Before Implementation

**Files:**

- Modify: `scripts/test-v2-shopee-bulk-price-stability.mjs`
- Modify: `scripts/test-shopee-bridge-image-hardening.mjs`
- Modify: `scripts/test-shopee-batch-price-probe.mjs`

- [x] **Step 1: Add bridge assertions in `scripts/test-v2-shopee-bulk-price-stability.mjs`**

Replace the two existing bridge assertions:

```js
assert.match(bridgeSource, /if \(action === 'update_price' && req\.method === 'POST'\)[\s\S]*insertMutationLog\({[\s\S]*action: 'update_price'/, 'Shopee update_price bridge route must log via service-role Edge function');
assert.match(bridgeSource, /shop_update_price_batch_complete/, 'Shopee update_price_batch route must audit aggregate batch completion');
```

with:

```js
assert.match(bridgeSource, /async function executeShopUpdatePriceMutation\(/, 'Shopee update_price bridge logic must be shared by single and batch routes');
assert.match(bridgeSource, /if \(action === 'update_price' && req\.method === 'POST'\)[\s\S]*executeShopUpdatePriceMutation\(/, 'Shopee single update_price route must call the shared mutation helper');
assert.match(bridgeSource, /if \(action === 'update_price_batch' && req\.method === 'POST'\)[\s\S]*mapWithConcurrency\(/, 'Shopee update_price_batch route must fan out with bounded bridge-side concurrency');
assert.doesNotMatch(
  bridgeSource,
  /shop_update_price_idempotent_skip/,
  'Shopee update_price bridge route must not skip a live price call based only on historical payload_hash matches',
);
assert.match(bridgeSource, /shop_update_price_batch_complete/, 'Shopee update_price_batch route must audit aggregate batch completion');
assert.match(bridgeSource, /UPDATE_PRICE_BATCH_PARALLELISM = 6/, 'Shopee update_price_batch route should keep the six active regions in one bounded bridge-side wave');
```

- [x] **Step 2: Add frontend transport assertions in `scripts/test-v2-shopee-bulk-price-stability.mjs`**

Add these assertions after the current `catBuildShopeeUpdateBatches` checks:

```js
assert.match(priceSync, /async function catPostShopeePriceBridgeBatch\(batches\)/, 'Shopee price sync must have a bridge-side batch transport helper');
assert.match(priceSync, /SHOPEE_BRIDGE \+ '\/update_price_batch'/, 'Shopee price sync must call the bridge-side update_price_batch route');
assert.match(priceSync, /catExecuteShopeeUpdateBatchesViaBridge\(batches\)/, 'Shopee price sync must prefer the bridge-side batch route after preflight');
assert.match(priceSync, /catExecuteShopeeUpdateBatch\(batch\)/, 'Shopee price sync must keep the existing per-item fallback path');
```

- [x] **Step 3: Add bridge-copy assertions in `scripts/test-shopee-bridge-image-hardening.mjs`**

Add after the existing `updatePriceBlock` assertions:

```js
assert(edge.includes("if (action === 'update_price_batch' && req.method === 'POST')"), 'shopee-bridge must expose update_price_batch');
assert(edge.includes('executeShopUpdatePriceMutation'), 'shopee-bridge must share update_price mutation execution between single and batch routes');
assert(edge.includes('UPDATE_PRICE_BATCH_PARALLELISM'), 'shopee-bridge must bound update_price_batch fan-out concurrency');
```

- [x] **Step 4: Extend `scripts/test-shopee-batch-price-probe.mjs` to protect endpoint choice**

Add after the existing V2 assertions that mention `batch_update_outlet_price`:

```js
const updatePriceBatchBlock = sliceBetween(
  supabaseBridge,
  "if (action === 'update_price_batch' && req.method === 'POST')",
  "if (action === 'update_item_logistics' && req.method === 'POST')",
);
assert.ok(updatePriceBatchBlock.includes("'/api/v2/product/update_price'") || supabaseBridge.includes("'/api/v2/product/update_price'"), 'update_price_batch must fan out to shop-level v2.product.update_price');
assert.ok(!updatePriceBatchBlock.includes("'/api/v2/product/batch_update_outlet_price'"), 'update_price_batch must not use the Outlet/Mart-only Shopee batch_update_outlet_price endpoint');
assert.ok(v2.includes("SHOPEE_BRIDGE + '/update_price_batch'"), 'V2 normal price sync should use the bridge-side update_price_batch wrapper');
assert.ok(!v2.includes("SHOPEE_BRIDGE + '/batch_update_outlet_price'"), 'V2 normal price sync must not call the Outlet/Mart-only bridge route');
```

- [x] **Step 5: Run the focused tests and verify they fail**

Run:

```powershell
node scripts\test-v2-shopee-bulk-price-stability.mjs
node scripts\test-shopee-bridge-image-hardening.mjs
node scripts\test-shopee-batch-price-probe.mjs
```

Expected:

- `test-v2-shopee-bulk-price-stability` fails because `/update_price_batch` frontend and bridge helpers do not exist yet.
- `test-shopee-bridge-image-hardening` fails because the new route/helper do not exist yet.
- `test-shopee-batch-price-probe` fails because V2 does not call `/update_price_batch` yet.

---

### Task 2: Extract Shared Bridge Update Price Mutation Helper

**Files:**

- Modify: `supabase/functions/shopee-bridge/index.ts`
- Modify: `edge-functions/shopee-bridge/index.ts`

- [x] **Step 1: Add constants near other bridge constants**

Add near the existing top-level mutation constants:

```ts
const UPDATE_PRICE_BATCH_PARALLELISM = 6;
const UPDATE_PRICE_BATCH_MAX_UPDATES = 60;
```

Reason:

- `6` matches the active operating Shopee regions.
- `60` allows up to ten selected products across six regions in one browser request while still keeping one Edge invocation bounded.

- [x] **Step 2: Add a shared row validator before the route handler**

Add before `runV2MutationAction()`:

```ts
function normalizeUpdatePriceRegion(value: unknown): string {
  return String(value || 'SG').trim().toUpperCase();
}

function normalizeUpdatePriceRow(input: any, fallbackRegion = 'SG') {
  const region = normalizeUpdatePriceRegion(input?.region || fallbackRegion);
  const itemId = Number.parseInt(String(input?.item_id ?? input?.itemId ?? ''), 10);
  const priceList = Array.isArray(input?.price_list) ? input.price_list : [];
  const clientRef = input?.client_ref || input?.clientRef || null;

  if (!region) return { ok: false, error: 'region required' };
  if (!Number.isFinite(itemId) || itemId <= 0) return { ok: false, error: 'item_id required' };
  if (!Array.isArray(priceList) || priceList.length < 1) return { ok: false, error: 'price_list required' };
  if (priceList.length > 50) return { ok: false, error: 'price_list length must be between 1 and 50' };

  const normalizedPriceList = priceList.map((entry: any, index: number) => {
    const originalPrice = Number(entry?.original_price);
    if (!Number.isFinite(originalPrice) || originalPrice <= 0) {
      return { ok: false, error: `price_list[${index}].original_price required` };
    }
    const row: any = { original_price: originalPrice };
    if (entry?.model_id !== undefined && entry?.model_id !== null && entry?.model_id !== '') {
      const modelId = Number(entry.model_id);
      if (!Number.isFinite(modelId) || modelId < 0) {
        return { ok: false, error: `price_list[${index}].model_id invalid` };
      }
      row.model_id = modelId;
    }
    return { ok: true, row };
  });

  const invalid = normalizedPriceList.find((entry: any) => !entry.ok);
  if (invalid) return { ok: false, error: invalid.error };

  return {
    ok: true,
    row: {
      region,
      item_id: itemId,
      price_list: normalizedPriceList.map((entry: any) => entry.row),
      client_ref: clientRef,
    },
  };
}

function normalizeUpdatePriceBatchRows(body: any) {
  const rows = Array.isArray(body?.updates)
    ? body.updates
    : (Array.isArray(body?.batches) ? body.batches : (Array.isArray(body?.items) ? body.items : []));
  if (!Array.isArray(rows) || rows.length < 1) {
    return { ok: false, status: 400, error: 'updates required' };
  }
  if (rows.length > UPDATE_PRICE_BATCH_MAX_UPDATES) {
    return { ok: false, status: 400, error: `updates length must be <= ${UPDATE_PRICE_BATCH_MAX_UPDATES}` };
  }
  const normalized = rows.map((row: any, index: number) => {
    const result = normalizeUpdatePriceRow(row, body?.region || 'SG');
    if (!result.ok) return { ok: false, index, error: result.error };
    return { ok: true, index, row: result.row };
  });
  const invalid = normalized.find((entry: any) => !entry.ok);
  if (invalid) {
    return { ok: false, status: 400, error: `updates[${invalid.index}]: ${invalid.error}` };
  }
  return { ok: true, rows: normalized.map((entry: any) => entry.row) };
}
```

- [x] **Step 3: Add the shared mutation executor before the route handler**

Add after `normalizeUpdatePriceBatchRows()`:

```ts
async function executeShopUpdatePriceMutation(params: {
  accountKey: string;
  region: string;
  itemId: number;
  priceList: any[];
  body: any;
  clientRef?: string | null;
}) {
  const action = 'update_price';
  const requestPayload = {
    account_key: params.accountKey,
    item_id: params.itemId,
    price_list: params.priceList,
  };
  const payloadHash = await sha256Hex({
    action,
    account_key: params.accountKey,
    region: params.region,
    request_payload: requestPayload,
  });

  const started = Date.now();
  const result = await shopApiCall(params.region, '/api/v2/product/update_price', {
    method: 'POST',
    body: {
      item_id: params.itemId,
      price_list: params.priceList,
    },
    account_key: params.accountKey,
  });
  const durationMs = Date.now() - started;
  const failureList = Array.isArray(result?.response?.failure_list) ? result.response.failure_list : [];
  const ok = !result?.error && failureList.length === 0;
  const errorMsg = result?.error
    ? `${result.error || ''} ${result.message || ''}`.trim()
    : (failureList.length ? 'update_price failure_list: ' + JSON.stringify(failureList).slice(0, 500) : null);
  const log = await insertMutationLog({
    action,
    region: params.region,
    payloadHash,
    requestPayload,
    status: ok ? 'ok' : 'error',
    response: result,
    errorMsg,
    requestId: result?.request_id || null,
    durationMs,
    body: {
      ...params.body,
      account_key: params.accountKey,
      region: params.region,
      item_id: params.itemId,
      price_list: params.priceList,
      client_ref: params.clientRef || null,
    },
  });
  return {
    ok,
    account_key: params.accountKey,
    region: params.region,
    item_id: params.itemId,
    client_ref: params.clientRef || null,
    sent_price_list: params.priceList,
    failure_list: failureList,
    result,
    payload_hash: payloadHash,
    log_id: log.id || null,
    rollback_policy: V2_ROLLBACK_POLICY,
  };
}
```

- [x] **Step 4: Refactor the single `/update_price` route to use the helper**

Replace the existing `if (action === 'update_price' && req.method === 'POST')` block with:

```ts
    if (action === 'update_price' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      const normalized = normalizeUpdatePriceRow(body, body.region || 'SG');
      if (!normalized.ok) return jsonResp({ ok: false, error: normalized.error }, 400);
      const row = normalized.row;
      const result = await executeShopUpdatePriceMutation({
        accountKey: reqAccountKey,
        region: row.region,
        itemId: row.item_id,
        priceList: row.price_list,
        body,
        clientRef: row.client_ref,
      });
      return jsonResp(result);
    }
```

- [x] **Step 5: Copy the edited Supabase function to the edge mirror**

Run:

```powershell
Copy-Item -LiteralPath supabase\functions\shopee-bridge\index.ts -Destination edge-functions\shopee-bridge\index.ts
```

- [x] **Step 6: Run focused tests**

Run:

```powershell
node scripts\test-shopee-bridge-image-hardening.mjs
node scripts\test-v2-shopee-bulk-price-stability.mjs
```

Expected:

- `test-shopee-bridge-image-hardening` may still fail on missing `/update_price_batch`.
- `test-v2-shopee-bulk-price-stability` may still fail on missing frontend batch helper.
- No syntax error should appear while reading bridge source.

- [ ] **Step 7: Commit the bridge helper extraction**

Run:

```powershell
git add supabase/functions/shopee-bridge/index.ts edge-functions/shopee-bridge/index.ts scripts/test-v2-shopee-bulk-price-stability.mjs scripts/test-shopee-bridge-image-hardening.mjs scripts/test-shopee-batch-price-probe.mjs
git commit -m "refactor: share Shopee update price bridge mutation" -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

### Task 3: Add Bridge-Side `/update_price_batch`

**Files:**

- Modify: `supabase/functions/shopee-bridge/index.ts`
- Modify: `edge-functions/shopee-bridge/index.ts`

- [x] **Step 1: Add the batch route immediately before `update_item_logistics`**

Insert between the single `/update_price` route and the `/update_item_logistics` route:

```ts
    if (action === 'update_price_batch' && req.method === 'POST') {
      const body = await req.json();
      const reqAccountKey = normalizeAccountKey(body.account_key || body.accountKey || accountKey);
      const normalized = normalizeUpdatePriceBatchRows(body);
      if (!normalized.ok) {
        return jsonResp({ ok: false, error: normalized.error }, normalized.status || 400);
      }

      const started = Date.now();
      const results = await mapWithConcurrency(normalized.rows, UPDATE_PRICE_BATCH_PARALLELISM, async (row: any) => {
        try {
          return await executeShopUpdatePriceMutation({
            accountKey: reqAccountKey,
            region: row.region,
            itemId: row.item_id,
            priceList: row.price_list,
            body,
            clientRef: row.client_ref,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            account_key: reqAccountKey,
            region: row.region,
            item_id: row.item_id,
            client_ref: row.client_ref || null,
            sent_price_list: row.price_list,
            failure_list: [],
            error: message,
            rollback_policy: V2_ROLLBACK_POLICY,
          };
        }
      });
      const failureCount = results.filter((result: any) => result?.ok !== true).length;
      const response = {
        ok: failureCount === 0,
        account_key: reqAccountKey,
        results,
        ok_count: results.length - failureCount,
        failure_count: failureCount,
        duration_ms: Date.now() - started,
        rollback_policy: V2_ROLLBACK_POLICY,
      };
      audit('shop_update_price_batch_complete', {
        account_key: reqAccountKey,
        update_count: results.length,
        ok_count: response.ok_count,
        failure_count: failureCount,
        duration_ms: response.duration_ms,
      });
      return jsonResp(response);
    }
```

Important response behavior:

- Return HTTP `200` for processed batches even when `failure_count > 0`; row-level failures are represented by `ok: false` on individual results and aggregate `ok: false`.
- Return HTTP `400` only for malformed input, because the frontend needs structured per-row results for Shopee failures.

- [x] **Step 2: Copy the edited Supabase function to the edge mirror**

Run:

```powershell
Copy-Item -LiteralPath supabase\functions\shopee-bridge\index.ts -Destination edge-functions\shopee-bridge\index.ts
```

- [x] **Step 3: Run bridge-focused tests**

Run:

```powershell
node scripts\test-shopee-bridge-image-hardening.mjs
node scripts\test-shopee-batch-price-probe.mjs
```

Expected:

- `test-shopee-bridge-image-hardening` passes the bridge-copy assertions.
- `test-shopee-batch-price-probe` still fails until frontend points to `/update_price_batch`.

- [ ] **Step 4: Commit the batch route**

Run:

```powershell
git add supabase/functions/shopee-bridge/index.ts edge-functions/shopee-bridge/index.ts
git commit -m "feat: add Shopee update price batch bridge route" -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

### Task 4: Add Frontend Batch Transport With Fallback

**Files:**

- Modify: `v2/index.html`
- Modify: `scripts/test-v2-shopee-bulk-price-stability.mjs`

- [x] **Step 1: Add batch request row builder after `catBuildShopeeUpdateBatches()`**

Add:

```js
  function catBuildShopeeUpdateBatchRequestRows(batches) {
    return (batches || []).map(function(batch, index) {
      const clientRef = batch.clientRef || [batch.region, batch.itemId, index].join(':');
      batch.clientRef = clientRef;
      return {
        client_ref: clientRef,
        region: batch.region,
        item_id: batch.itemId,
        price_list: batch.payload && Array.isArray(batch.payload.price_list)
          ? batch.payload.price_list
          : [],
      };
    });
  }
```

- [x] **Step 2: Add batch route result helpers after `catPostShopeePriceBatch()`**

Add:

```js
  function catShopeeBatchRouteResultMessage(result, fallback) {
    if (!result) return fallback || 'unknown';
    const failureList = catBridgePriceFailureList(result);
    if (failureList.length) return JSON.stringify(failureList.slice(0, 3));
    if (result.error) return result.error;
    if (result.result?.error || result.result?.message) {
      return [result.result.error, result.result.message].filter(Boolean).join(' ');
    }
    return catBridgePriceMessage(result, fallback);
  }

  function catBridgeBatchRouteUnavailable(status, json, errorMsg) {
    const text = String(errorMsg || json?.error || json?.message || '').toLowerCase();
    return status === 404 || status === 405 || /not found|unsupported action|unknown action/.test(text);
  }
```

- [x] **Step 3: Add bridge batch POST helper after those helpers**

Add:

```js
  async function catPostShopeePriceBridgeBatch(batches) {
    const rows = catBuildShopeeUpdateBatchRequestRows(batches);
    let json = null;
    let ok = false;
    let errorMsg = null;
    let status = 0;
    try {
      const response = await fetch(SHOPEE_BRIDGE + '/update_price_batch', {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          account_key: SHOPEE_DEFAULT_ACCOUNT_KEY,
          updates: rows,
        }),
      });
      status = response.status;
      json = await response.json().catch(function() { return { ok: false, error: 'HTTP ' + response.status }; });
      ok = response.ok && json && Array.isArray(json.results);
      if (!ok) errorMsg = catBridgePriceMessage(json, 'HTTP ' + response.status);
    } catch (e) {
      errorMsg = e.message || String(e);
    }
    return {
      ok: ok,
      json: json,
      status: status,
      errorMsg: errorMsg,
      unavailable: catBridgeBatchRouteUnavailable(status, json, errorMsg),
    };
  }
```

- [x] **Step 4: Add result attribution helper after the POST helper**

Add:

```js
  async function catExecuteShopeeUpdateBatchesViaBridge(batches) {
    if (!batches || !batches.length) return { usedBatchRoute: true, rows: [] };
    const batchRoute = await catPostShopeePriceBridgeBatch(batches);
    if (!batchRoute.ok) {
      if (batchRoute.unavailable) return { usedBatchRoute: false, rows: [] };
      const failedRows = [];
      for (const batch of batches) {
        for (const payload of batch.items) {
          failedRows.push({
            p: payload,
            ok: false,
            json: batchRoute.json,
            errorMsg: batchRoute.errorMsg || 'update_price_batch failed',
            preRetry: null,
          });
        }
      }
      return { usedBatchRoute: true, rows: failedRows };
    }

    const resultByClientRef = new Map();
    (batchRoute.json.results || []).forEach(function(result) {
      if (result && result.client_ref) resultByClientRef.set(String(result.client_ref), result);
    });

    const rows = [];
    for (const batch of batches) {
      const result = resultByClientRef.get(String(batch.clientRef)) || null;
      if (!result) {
        for (const payload of batch.items) {
          rows.push({
            p: payload,
            ok: false,
            json: batchRoute.json,
            errorMsg: 'update_price_batch missing result for ' + batch.clientRef,
            preRetry: null,
          });
        }
        continue;
      }

      const failures = catBridgePriceFailureList(result);
      if (failures.length) {
        for (const payload of batch.items) {
          const itemError = catShopeeBatchFailureMessage(result, payload);
          if (!itemError) {
            rows.push({ p: payload, ok: true, json: result, errorMsg: null, preRetry: null });
          } else if (catShopeePriceErrorNeedsLogisticsRepair(itemError)) {
            const single = await catPostShopeePricePayload(payload);
            rows.push(Object.assign({ p: payload }, single));
          } else {
            rows.push({ p: payload, ok: false, json: result, errorMsg: itemError, preRetry: null });
          }
        }
        continue;
      }

      if (result.ok !== true) {
        const message = catShopeeBatchRouteResultMessage(result, 'update_price_batch row failed');
        if (catShopeePriceErrorNeedsLogisticsRepair(message)) {
          for (const payload of batch.items) {
            const single = await catPostShopeePricePayload(payload);
            rows.push(Object.assign({ p: payload }, single));
          }
        } else {
          for (const payload of batch.items) {
            rows.push({ p: payload, ok: false, json: result, errorMsg: message, preRetry: null });
          }
        }
        continue;
      }

      for (const payload of batch.items) {
        rows.push({ p: payload, ok: true, json: result, errorMsg: null, preRetry: null });
      }
    }
    return { usedBatchRoute: true, rows: rows };
  }
```

- [x] **Step 5: Update `catRunShopeePriceUpdates()` to prefer the batch route**

Replace:

```js
  async function catRunShopeePriceUpdates(payloads) {
    const batches = catBuildShopeeUpdateBatches(payloads);
    const results = [];
    for (let i = 0; i < batches.length; i += SHOPEE_PRICE_UPDATE_PARALLELISM) {
      const chunk = batches.slice(i, i + SHOPEE_PRICE_UPDATE_PARALLELISM);
      const chunkResults = await Promise.all(chunk.map(function(batch) {
        return catExecuteShopeeUpdateBatch(batch);
      }));
      chunkResults.forEach(function(batchRows) {
        batchRows.forEach(function(row) { results.push(row); });
      });
    }
    return results;
  }
```

with:

```js
  async function catRunShopeePriceUpdates(payloads) {
    const batches = catBuildShopeeUpdateBatches(payloads);
    const bridgeBatch = await catExecuteShopeeUpdateBatchesViaBridge(batches);
    if (bridgeBatch.usedBatchRoute) return bridgeBatch.rows;

    const results = [];
    for (let i = 0; i < batches.length; i += SHOPEE_PRICE_UPDATE_PARALLELISM) {
      const chunk = batches.slice(i, i + SHOPEE_PRICE_UPDATE_PARALLELISM);
      const chunkResults = await Promise.all(chunk.map(function(batch) {
        return catExecuteShopeeUpdateBatch(batch);
      }));
      chunkResults.forEach(function(batchRows) {
        batchRows.forEach(function(row) { results.push(row); });
      });
    }
    return results;
  }
```

- [x] **Step 6: Add a VM test for successful bridge batch attribution**

Add a harness in `scripts/test-v2-shopee-bulk-price-stability.mjs`:

```js
async function runBridgeBatchSuccessHarness() {
  const context = {
    Array,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    Set,
    String,
    URLSearchParams,
    console,
    globalThis: null,
    AUTH_HEADERS: { Authorization: 'Bearer test' },
    SHOPEE_BRIDGE: 'https://bridge.test',
    SHOPEE_DEFAULT_ACCOUNT_KEY: 'starphotocard',
    fetchCalls: [],
  };
  context.globalThis = context;
  context.fetch = async function(url, options) {
    context.fetchCalls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async function() {
        return {
          ok: true,
          results: [
            { ok: true, client_ref: 'SG:412:0', region: 'SG', item_id: 412, log_id: 'sg-log', result: { response: { success_list: [{ model_id: 1, original_price: 18.26 }] } } },
            { ok: true, client_ref: 'TW:530:1', region: 'TW', item_id: 530, log_id: 'tw-log', result: { response: { success_list: [{ model_id: 2, original_price: 418 }] } } },
          ],
        };
      },
    };
  };
  vm.createContext(context);
  const harness = `
    ${extractFunction(v2, 'catBridgePriceFailureList')}
    ${extractFunction(v2, 'catBridgePriceMessage')}
    ${extractFunction(v2, 'catShopeePriceEntryModelKey')}
    ${extractFunction(v2, 'catShopeePayloadModelKey')}
    ${extractFunction(v2, 'catShopeeBatchFailureMessage')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatches')}
    ${extractFunction(v2, 'catShopeePriceErrorNeedsLogisticsRepair')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatchRequestRows')}
    ${extractFunction(v2, 'catShopeeBatchRouteResultMessage')}
    ${extractFunction(v2, 'catBridgeBatchRouteUnavailable')}
    ${extractFunction(v2, 'catPostShopeePriceBridgeBatch')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatchesViaBridge')}
    ${extractFunction(v2, 'catRunShopeePriceUpdates')}
    (async function() {
      globalThis.rows = await catRunShopeePriceUpdates([
        { sku: 'SKU-SG', region: 'SG', itemId: 412, modelId: 1, bridgeUrl: SHOPEE_BRIDGE + '/update_price', payload: { region: 'SG', item_id: 412, price_list: [{ model_id: 1, original_price: 18.26 }] } },
        { sku: 'SKU-TW', region: 'TW', itemId: 530, modelId: 2, bridgeUrl: SHOPEE_BRIDGE + '/update_price', payload: { region: 'TW', item_id: 530, price_list: [{ model_id: 2, original_price: 418 }] } },
      ]);
    })();
  `;
  await new vm.Script(harness, { filename: 'v2-shopee-bridge-batch-success-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify({ rows: context.rows, fetchCalls: context.fetchCalls }));
}
```

Add assertions near other harness assertions:

```js
const bridgeBatchSuccess = await runBridgeBatchSuccessHarness();
assert.equal(bridgeBatchSuccess.fetchCalls.length, 1, 'bridge batch route should send one browser fetch for multiple update_price batches');
assert.equal(bridgeBatchSuccess.fetchCalls[0].url, 'https://bridge.test/update_price_batch');
assert.equal(bridgeBatchSuccess.fetchCalls[0].body.updates.length, 2, 'bridge batch route should include each region/item update as one row');
assert.equal(bridgeBatchSuccess.rows.length, 2, 'bridge batch route response should expand back to per-payload results');
assert.equal(bridgeBatchSuccess.rows[0].ok, true, 'first bridge batch row should be successful');
assert.equal(bridgeBatchSuccess.rows[1].json.log_id, 'tw-log', 'second bridge batch row should retain the bridge mutation log id');
```

- [x] **Step 7: Add a VM test for unavailable-route fallback**

Add a second harness:

```js
async function runBridgeBatchUnavailableFallbackHarness() {
  const context = {
    Array,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    Set,
    String,
    URLSearchParams,
    console,
    globalThis: null,
    AUTH_HEADERS: { Authorization: 'Bearer test' },
    SHOPEE_BRIDGE: 'https://bridge.test',
    SHOPEE_DEFAULT_ACCOUNT_KEY: 'starphotocard',
    fetchCalls: [],
  };
  context.globalThis = context;
  context.fetch = async function(url, options) {
    context.fetchCalls.push({ url, body: JSON.parse(options.body) });
    if (String(url).endsWith('/update_price_batch')) {
      return { ok: false, status: 404, json: async function() { return { ok: false, error: 'unknown action' }; } };
    }
    return { ok: true, status: 200, json: async function() { return { ok: true, log_id: 'single-log', result: { response: { failure_list: [] } } }; } };
  };
  vm.createContext(context);
  const harness = `
    ${extractFunction(v2, 'catBridgePriceOk')}
    ${extractFunction(v2, 'catBridgePriceFailureList')}
    ${extractFunction(v2, 'catBridgePriceMessage')}
    ${extractFunction(v2, 'catShopeePriceEntryModelKey')}
    ${extractFunction(v2, 'catShopeePayloadModelKey')}
    ${extractFunction(v2, 'catShopeeBatchFailureMessage')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatches')}
    ${extractFunction(v2, 'catShopeePriceErrorNeedsLogisticsRepair')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatchRequestRows')}
    ${extractFunction(v2, 'catShopeeBatchRouteResultMessage')}
    ${extractFunction(v2, 'catBridgeBatchRouteUnavailable')}
    ${extractFunction(v2, 'catPostShopeePricePayload')}
    ${extractFunction(v2, 'catPostShopeePriceBatch')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatch')}
    ${extractFunction(v2, 'catPostShopeePriceBridgeBatch')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatchesViaBridge')}
    ${extractFunction(v2, 'catRunShopeePriceUpdates')}
    (async function() {
      globalThis.rows = await catRunShopeePriceUpdates([
        { sku: 'SKU-SG', region: 'SG', itemId: 412, modelId: 1, bridgeUrl: SHOPEE_BRIDGE + '/update_price', payload: { region: 'SG', item_id: 412, price_list: [{ model_id: 1, original_price: 18.26 }] } },
      ]);
    })();
  `;
  await new vm.Script(harness, { filename: 'v2-shopee-bridge-batch-fallback-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify({ rows: context.rows, fetchCalls: context.fetchCalls }));
}
```

Add assertions:

```js
const bridgeBatchFallback = await runBridgeBatchUnavailableFallbackHarness();
assert.equal(bridgeBatchFallback.fetchCalls.length, 2, 'unavailable bridge batch route should fall back to existing update_price transport');
assert.equal(bridgeBatchFallback.fetchCalls[0].url, 'https://bridge.test/update_price_batch');
assert.equal(bridgeBatchFallback.fetchCalls[1].url, 'https://bridge.test/update_price');
assert.equal(bridgeBatchFallback.rows[0].ok, true, 'fallback update_price transport should preserve successful result shape');
```

- [x] **Step 8: Run the frontend focused test**

Run:

```powershell
node scripts\test-v2-shopee-bulk-price-stability.mjs
```

Expected: PASS or a concrete harness dependency failure to fix before continuing.

- [ ] **Step 9: Commit the frontend batch transport**

Run:

```powershell
git add v2/index.html scripts/test-v2-shopee-bulk-price-stability.mjs
git commit -m "feat: use Shopee update price batch bridge route" -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

### Task 5: Verification, Deploy, and Live Smoke

**Files:**

- No additional source files unless verification exposes a defect.

- [x] **Step 1: Run focused regression scripts**

Run:

```powershell
node scripts\test-v2-shopee-bulk-price-stability.mjs
node scripts\test-shopee-bridge-image-hardening.mjs
node scripts\test-shopee-batch-price-probe.mjs
```

Expected:

- `v2 Shopee bulk price stability checks passed`
- `shopee bridge image hardening checks passed`
- `Shopee batch price probe guards passed`

- [x] **Step 2: Run broader Shopee/V2 regression tests**

Run:

```powershell
node --test tests\shopee-sku-lookup-regression.test.mjs tests\v2-shopee-sku-mapping-regression.test.mjs tests\v2-product-list-regression.test.mjs
```

Expected: all selected Node tests pass.

- [x] **Step 3: Run deployment source guard**

Run:

```powershell
npm run verify:v2-deploy-source
```

Expected:

```text
V2 deployment guard passed for C:\dev\shopee-dashboard-shopee-sku-price-fix
```

- [x] **Step 4: Run whitespace/diff guard**

Run:

```powershell
git diff --check
```

Expected: no output.

- [ ] **Step 5: Local rendered app smoke**

Run:

```powershell
npx --yes http-server . -p 4174 -c-1
```

Open:

```text
http://127.0.0.1:4174/v2/
```

Verify:

- V2 loads with no console errors.
- Shopee price tab opens.
- Selecting the BOYNEXTDOOR `RANDOM` row still calculates the edited Cost preview.
- Network panel shows a single `/update_price_batch` request during sync after the Edge function is deployed locally or in production.

- [ ] **Step 6: Deploy Edge Function first**

Run:

```powershell
supabase functions deploy shopee-bridge --project-ref mgqlwgnmwegzsjelbrih
```

Expected:

- Deployment exits `0`.
- Supabase function version is updated before Vercel frontend starts calling `/update_price_batch`.

- [ ] **Step 7: Push and deploy Vercel**

Run:

```powershell
git push origin HEAD:main
vercel deploy --prod --yes --scope moon-jeonghos-projects
```

Expected:

- Push succeeds.
- Vercel returns a production deployment URL.

- [ ] **Step 8: Production live smoke with actual price change**

Use Chrome logged-in session:

1. Open `https://shopee-dashboard-kohl.vercel.app/v2/`.
2. Shopee tab -> search `SWEET HOME`.
3. Select `[READY STOCK] BOYNEXTDOOR 1st Studio Album [HOME] (SWEET HOME ver.)`.
4. Open price-edit view.
5. Expand group and select only `RANDOM`.
6. Change Cost `13281 -> 14281`.
7. Click sync.
8. Confirm Network has one `/update_price_batch` request.
9. Confirm toast reports six successful Shopee updates.
10. Confirm console timing line includes `update=...ms` and `persist=...ms`.
11. Confirm Shopee-side current price reflects the changed value for all six active regions.
12. Restore Cost `14281 -> 13281`.
13. Click sync again.
14. Confirm the restore also uses one `/update_price_batch` request and succeeds.

Record both timing lines:

```text
[CAT live] Shopee price sync timing: inline=...ms mapping=...ms preflight=...ms update=...ms persist=...ms
```

Success criteria:

- The changed value is actually reflected through Shopee, not only in local DB state.
- Both change and restore succeed.
- `/update_price_batch` is used in production.
- No browser console app errors appear.
- If update time remains high, the bottleneck is Shopee API response time rather than browser fan-out overhead; keep the route because it centralizes logging and makes later bridge-level retries possible.

- [x] **Step 8a: Live RANDOM option model-id correction discovered during smoke**

Production smoke for `[READY STOCK] BOYNEXTDOOR 1st Studio Album [HOME] (SWEET HOME ver.)` / `RANDOM` showed the batch route returned success and local DB prices changed, but Shopee `shop_model_list` still showed stale remote prices for SG/TH/BR. Root cause: `product_shopee_listings.shop_model_id` was stale for those regions, and the new preflight trust TTL skipped remote `get_model_list` validation for fresh mapped variant rows.

Additional fix:

- Variant price payloads now always fetch/verify the remote shop model list per item/region.
- If local `shop_model_id` does not match the selected SKU/option/tier, preflight rewrites `model_id` and `price_list` to the matching remote model before `/update_price_batch`.
- Item-level no-model rows can still use the fresh-mapping trust path.
- Regression test added for fresh but stale `RANDOM` model mapping correction.

- [x] **Step 8b: Live restore exposed payload-hash skip and stale tier fallback**

Second production smoke after Step 8a showed two more issues:

- Bridge `executeShopUpdatePriceMutation()` skipped a live Shopee API call when the same `payload_hash` had a historical `ok` mutation log. That is unsafe for price sync because external Shopee state can change after the previous success. The bridge now always calls `v2.product.update_price`; `payload_hash` remains log correlation only.
- `catShopeeModelMatchesProduct()` and `catShopeeModelMatchesPayloadSku()` accepted a stale local `variation_tier_index` match even when remote `model_sku`/`model_name` explicitly disagreed with the selected SKU/option. The matcher now refuses tier fallback when explicit SKU/option identity is available on both sides and does not match.
- Regression tests cover no pre-call idempotent skip, duplicate-log `previous_log_id` propagation, and RANDOM-vs-SUNGHO explicit identity mismatch beating stale tier data.

- [ ] **Step 9: Final commit if verification fixes were needed**

If verification required extra fixes after the Task 4 commit, run:

```powershell
git add v2/index.html supabase/functions/shopee-bridge/index.ts edge-functions/shopee-bridge/index.ts scripts/test-v2-shopee-bulk-price-stability.mjs scripts/test-shopee-bridge-image-hardening.mjs scripts/test-shopee-batch-price-probe.mjs docs/superpowers/plans/2026-06-26-shopee-update-price-batch.md
git commit -m "fix: stabilize Shopee update price batch sync" -m "Co-Authored-By: Codex <codex@openai.com>"
```

If no extra fixes were needed, add the plan to the closest relevant commit before pushing:

```powershell
git add docs/superpowers/plans/2026-06-26-shopee-update-price-batch.md
git commit -m "docs: plan Shopee update price batch bridge" -m "Co-Authored-By: Codex <codex@openai.com>"
```

---

## Rollback Plan

- Frontend has an unavailable-route fallback. If production bridge deployment lags or returns 404/405, V2 falls back to the existing `/update_price` path.
- If the new route causes unexpected row-level attribution issues, revert the frontend commit first. The bridge route can remain deployed because no existing caller depends on it.
- If the bridge helper extraction causes single `/update_price` regression, revert the bridge commits and redeploy `shopee-bridge` before reverting frontend.
- Do not enable or test `batch_update_outlet_price` for normal V2 price sync during rollback.

---

## Self-Review

- Spec coverage: covers bridge-side `/update_price_batch`, single-route refactor, frontend caller switch, fallback behavior, tests, deploy order, and live actual-price verification.
- API-doc coverage: plan references the local `v2.product.update_price` and `v2.product.get_model_list` docs and avoids web-only assumptions.
- Placeholder scan: completed; no placeholder markers or vague follow-up steps remain.
- Type consistency: bridge response uses `client_ref`, `results`, `ok_count`, `failure_count`; frontend helpers consume those exact fields.
- Safety check: mutation logs remain per underlying `update_price` call, and batch route does not call Shopee `batch_update_outlet_price`.
