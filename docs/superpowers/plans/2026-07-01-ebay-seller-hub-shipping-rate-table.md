# eBay Seller Hub Shipping Rate Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encode the approved eBay Seller Hub international shipping Cost groups where Europe is lifted by at least USD 3.40 and non-Europe rows remain at the current approved costs.

**Architecture:** Keep the approved Seller Hub table in one small script module, export CSV/Markdown artifacts from that module, and add a static test that prevents accidental country/cost drift. Do not change the eBay listing price formula; this task targets Seller Hub shipping Cost grouping.

**Tech Stack:** Node.js ESM scripts, eBay Account API reference at `C:\dev\api-refs\marketplaces\ebay\sell\account.yaml`, existing `scripts/` utilities.

---

### Task 1: Add Regression Test

**Files:**
- Create: `C:\dev\shopee-dashboard\scripts\test-ebay-seller-hub-rate-table-groups.mjs`

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import {
  EBAY_SELLER_HUB_RATE_TABLE_GROUPS,
  buildSellerHubRateTableRows,
} from './ebay-seller-hub-rate-table-groups.mjs';

const rows = buildSellerHubRateTableRows();
const byCost = new Map(rows.map((row) => [row.costUsd, row.countryCodes]));

assert.deepEqual([...byCost.keys()], [0, 3.99, 4.99, 7.99, 8.99, 9.99, 11.99, 13.99, 14.99, 17.99, 18.99]);
assert.deepEqual(byCost.get(3.99), ['BG', 'FR', 'DE', 'IT', 'NL', 'ES', 'GB']);
assert.deepEqual(byCost.get(8.99), ['HR', 'DK', 'GR', 'LT', 'PL', 'RO', 'SI', 'SE']);
assert.deepEqual(byCost.get(11.99), ['AT', 'BE', 'CZ', 'EE', 'FI', 'HU', 'IE', 'LV', 'LU', 'NO', 'PT']);
assert.deepEqual(byCost.get(13.99), ['SK', 'CH']);
assert.deepEqual(byCost.get(18.99), ['CY', 'MT']);

const allCodes = rows.flatMap((row) => row.countryCodes);
assert.equal(new Set(allCodes).size, allCodes.length, 'country codes must not be duplicated');
assert.equal(EBAY_SELLER_HUB_RATE_TABLE_GROUPS.every((group) => Number.isFinite(group.costUsd)), true);

console.log('eBay Seller Hub shipping rate table group tests passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-ebay-seller-hub-rate-table-groups.mjs`
Expected: FAIL with module not found for `ebay-seller-hub-rate-table-groups.mjs`.

### Task 2: Add Approved Rate Table Module And Exporter

**Files:**
- Create: `C:\dev\shopee-dashboard\scripts\ebay-seller-hub-rate-table-groups.mjs`
- Create: `C:\dev\shopee-dashboard\scripts\export-ebay-seller-hub-rate-table.mjs`

- [ ] **Step 1: Implement approved groups**

Create a module exporting:
- `EBAY_SELLER_HUB_RATE_TABLE_GROUPS`
- `buildSellerHubRateTableRows()`
- `formatSellerHubMarkdownTable()`

Use the approved Cost rows: 0.00, 3.99, 4.99, 7.99, 8.99, 9.99, 11.99, 13.99, 14.99, 17.99, 18.99.

- [ ] **Step 2: Implement export script**

Create a script that writes:
- `tmp/ebay-seller-hub-rate-table-2026-07-01.csv`
- `tmp/ebay-seller-hub-rate-table-2026-07-01.md`

### Task 3: Verify And Commit

**Files:**
- Test: `C:\dev\shopee-dashboard\scripts\test-ebay-seller-hub-rate-table-groups.mjs`
- Test: `C:\dev\shopee-dashboard\scripts\export-ebay-seller-hub-rate-table.mjs`

- [ ] **Step 1: Run focused tests**

Run:
```bash
node scripts/test-ebay-seller-hub-rate-table-groups.mjs
node scripts/export-ebay-seller-hub-rate-table.mjs
```

Expected:
```text
eBay Seller Hub shipping rate table group tests passed
```

- [ ] **Step 2: Commit only this task's files**

Run:
```bash
git add docs/superpowers/plans/2026-07-01-ebay-seller-hub-shipping-rate-table.md scripts/test-ebay-seller-hub-rate-table-groups.mjs scripts/ebay-seller-hub-rate-table-groups.mjs scripts/export-ebay-seller-hub-rate-table.mjs
git commit -m "chore: add ebay seller hub shipping rate table"
```
