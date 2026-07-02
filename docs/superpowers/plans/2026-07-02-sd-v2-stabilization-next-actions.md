# SD V2 Stabilization Approval Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 2026-07-02 SD V2 daily KPI findings into separately approvable, review-gated work tracks that reduce recurring failures without mixing unrelated marketplace work.

**Architecture:** Treat this document as the approval gate, not as a worker execution script. Each approved implementation track must either use a dedicated Superpowers execution plan with exact steps or be converted into one before code changes. Current dirty worktree changes are not assumed to belong to the same task, and no deploy can happen until the approved diff is cleanly scoped.

**Tech Stack:** Static V2 app (`v2/index.html`), Supabase Edge Functions TypeScript, Node regression scripts, local marketplace API docs under `C:\dev\api-refs\marketplaces`, Obsidian KPI/runbook notes under `C:\Users\STEVE\Documents\MVPICK`.

---

## Current Context

Daily KPI source:

- `C:\Users\STEVE\Documents\MVPICK\00_Inbox\SD 운영 효율 KPI 로그 - 2026-07.md`
- Entry: `2026-07-02 02:00 KST — 3회차 / 14회차`

Repository state observed before writing this plan:

- Branch: `codex/ebay-seller-hub-rate-table`
- Current dirty tree includes Shopee-adjacent, Joom, Shopify, Qoo10, V2 UI, tests, `.codex-artifacts/`, and `test-results/` changes.
- Do not implement any plan until dirty-tree scope is classified. Do not revert user or agent changes.

Local docs already checked or required:

- Shopee:
  - `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.search_item.json`
  - `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.get_model_list.json`
  - `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\product\v2.product.update_price.json`
  - `C:\dev\api-refs\marketplaces\shopee\docs_ai\apis\global_product\v2.global_product.get_published_list.json`
- Joom:
  - `C:\dev\api-refs\marketplaces\joom\openapi.yaml`
  - `C:\dev\api-refs\marketplaces\joom\api-catalog.md`
- Shopify:
  - `C:\dev\api-refs\marketplaces\shopify\README.md`
  - `C:\dev\api-refs\marketplaces\shopify\product-create.graphql.md`
  - `C:\dev\api-refs\marketplaces\shopify\product-variants-bulk-update.graphql.md`
  - `C:\dev\api-refs\marketplaces\shopify\inventory-item-update.graphql.md`
- eBay:
  - `C:\dev\api-refs\marketplaces\ebay\sell\inventory.yaml`
  - `C:\dev\shopee-dashboard\docs\wiki\ebay-master-content-sync.md`
  - `C:\dev\shopee-dashboard\docs\platform-test-cycle.md`

## Approval Summary

Recommended approval order:

1. Approve Plan 0 first. It is the scope-safety gate and should not change product behavior.
2. Approve Plan 1 next, but require a dedicated implementation plan before code changes. Shopee mapping/price sync is the current strongest recurring signature.
3. Approve Plan 4 as a read-only audit. It collects evidence without live writes.
4. Approve Plan 3 only as a Shopify fail-closed safety patch plus dry-run audit. The current bridge must not be treated as read-only-safe until the dry-run guard is explicit.
5. Approve Plan 2 only when a Joom stale/duplicate SKU target is selected or when Steve explicitly approves implementing the UI flow without executing live deletes.

---

## Fable5 Strict Approval Gates

These gates apply before any track is implemented, committed, pushed, deployed, or used for marketplace write operations.

### Gate A: Scoped Worktree

Run:

```bash
git status --short --branch
git diff --name-only
git diff --cached --name-only
git ls-files --others --exclude-standard
```

Pass criteria:

- Only files explicitly listed in the approved track may be modified or staged.
- `.codex-artifacts/`, `.codex-fable5/`, `test-results/`, temporary files, and unrelated Qoo10/Shopify/Joom/eBay changes must not be staged.
- If `v2/index.html` contains changes for more than one approved track, stop and split scope before implementation.

### Gate B: No Live Writes By Default

Pass criteria:

- Shopee/Joom/eBay/Shopify write APIs are not called during audit-only tracks.
- Any live write requires an explicit named target and a separate approval line.
- Shopify `reprice-products` must be fail-closed before use: omitted `dry_run` must not mutate remote variants, and live repricing must require both `dry_run: false` and an explicit confirm token.

### Gate C: Rendered UI Evidence

For any V2 UI change, run local render smoke with a real browser check, not only static tests.

Use this Windows-safe server pattern:

```powershell
$proc = Start-Process -FilePath "npx.cmd" -ArgumentList @("serve","-l","4173",".") -WorkingDirectory "C:\dev\shopee-dashboard" -WindowStyle Hidden -PassThru
try {
  Start-Sleep -Seconds 3
  Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:4173/v2/" | Select-Object StatusCode
} finally {
  Stop-Process -Id $proc.Id -Force
}
```

Pass criteria:

- HTTP status is 200.
- Browser/Playwright check confirms no initial console errors.
- A screenshot or explicit visual observation confirms changed controls do not overlap existing UI.

### Gate D: Evidence Output

Every approved track must write one evidence note.

Use one of:

- `C:\Users\STEVE\Documents\MVPICK\00_Inbox\Review - 2026-07-02 SD V2 stabilization <track>.md`
- Existing KPI log: `C:\Users\STEVE\Documents\MVPICK\00_Inbox\SD 운영 효율 KPI 로그 - 2026-07.md`

The evidence must include:

- checked local API doc paths,
- exact commands run,
- pass/fail output summary,
- live write status,
- deploy status,
- next residual risk.

### Gate E: Deploy Lock

Deploy is blocked unless all are true:

- Gate A passes after final edits.
- Focused tests pass.
- `npm run verify:v2-deploy-source` passes for V2 changes.
- Local render smoke passes for UI changes.
- The commit contains only the approved track.
- Steve approved deploy for that track.

Use a scoped commit message, then push/deploy:

```bash
git add <approved-files-only>
git commit -m "<scoped English commit message>" -m "Co-Authored-By: Codex <codex@openai.com>"
git push
vercel deploy --prod --yes
```

Live smoke after deploy:

- `https://shopee-dashboard-kohl.vercel.app/v2/` returns HTTP 200.
- Live source or browser observation confirms the approved change is present.

---

## Plan 0: Dirty Tree Scope Split And Baseline

**Purpose:** Prevent unrelated Qoo10/Shopify/eBay/Joom/V2 changes from being committed or deployed as one opaque bundle.

**Files:**

- Read: `C:\dev\shopee-dashboard`
- No product-code changes.
- Create/update after approval: `C:\dev\shopee-dashboard\docs\superpowers\plans\2026-07-02-sd-v2-stabilization-scope-audit.md`

**Steps:**

- [ ] **Step 1: Capture current status**

Run:

```bash
git status --short --branch
git diff --stat
git log --oneline --decorate --max-count=12
```

Expected:

- Current branch and dirty-file list are visible.
- No file content is changed.

- [ ] **Step 2: Classify dirty files into delivery buckets**

Use these buckets:

- Shopee recurrence guard: `v2/index.html`, `tests/shopee-sku-lookup-regression.test.mjs`, `scripts/test-v2-shopee-bulk-price-stability.mjs`, `tests/v2-product-list-regression.test.mjs`
- Joom cleanup/delete-reregister: `v2/index.html`, `scripts/test-v2-joom-remote-cleanup-flow.mjs`, `docs/superpowers/plans/2026-07-01-joom-delete-reregister.md`
- Shopify repricing/policy: `supabase/functions/shopify-bridge/index.ts`, `edge-functions/shopify-bridge/index.ts`, `supabase/functions/platform-publish/adapters/shopify.ts`, `scripts/test-shopify-price-policy-db-ui.mjs`, `scripts/test-shopify-product-registration.mjs`
- eBay image/readback: `supabase/functions/ebay-bridge/index.ts`, `edge-functions/ebay-bridge/index.ts`, `scripts/test-v2-ebay-kpop-listing-flow.mjs`, `scripts/test-v2-ebay-register-button-bridge.mjs`
- Qoo10 or unrelated current work: any Qoo10 files, `.codex-artifacts/`, `test-results/`, unrelated plans

Expected:

- A clear list of which files are safe to touch for the approved plan.
- If the same file belongs to several buckets, pause and review the diff before editing.

- [ ] **Step 3: Write the scope audit note**

Create or update `docs/superpowers/plans/2026-07-02-sd-v2-stabilization-scope-audit.md` with this structure:

```markdown
# SD V2 Stabilization Scope Audit - 2026-07-02

## Current Branch

## Dirty Files By Bucket

## Files Excluded From This Approval

## Approved Track Candidate

## Risk If Committed Together

## Required Split Before Implementation
```

- [ ] **Step 4: Run baseline non-live validation**

Run:

```bash
node scripts/test-sd-operating-efficiency-docs.mjs
npm run verify:v2-deploy-source
git diff --check
```

Expected:

- `SD operating efficiency docs and helper checks passed`
- `V2 deployment guard passed`
- `git diff --check` has no whitespace error; LF/CRLF warnings are acceptable.

**Approval decision:** Required before any implementation. This plan is safe to approve first.

---

## Plan 1: Shopee SKU Mapping And Price Sync Recurrence Guard

**Purpose:** Make the already-fixed MEOVV class easier to diagnose on the next recurrence: operator-triggered SKU mapping should visibly bypass stale negative cache, and price sync should visibly report remote `get_model_list` preflight decisions.

**Approval status:** Approve this as the next implementation candidate only after Plan 0. Before touching code, convert this section into a dedicated execution plan with exact tests and code snippets.

**Files:**

- Modify: `C:\dev\shopee-dashboard\v2\index.html`
- Modify: `C:\dev\shopee-dashboard\tests\shopee-sku-lookup-regression.test.mjs`
- Modify: `C:\dev\shopee-dashboard\scripts\test-v2-shopee-bulk-price-stability.mjs`
- Modify only if the scoped diff proves it already covers the changed UI path: `C:\dev\shopee-dashboard\tests\v2-product-list-regression.test.mjs`
- Update after implementation: `C:\Users\STEVE\Documents\MVPICK\10_Projects\shopee-dashboard\Shopee SKU mapping negative cache.md`

**Steps:**

- [ ] **Step 1: Create a dedicated Shopee execution plan**

Create `docs/superpowers/plans/2026-07-02-shopee-mapping-price-sync-diagnostics.md`.

That plan must name exact insertion points in:

- `coverageLookupShopeePublishedBySku`
- `catFetchShopeeSkuLookupHits`
- `catPreflightShopeePayloads`
- `catBuildShopeePriceEntry`

It must include the exact assertions to add before implementation.

- [ ] **Step 2: Add regression expectations before code changes**

Add checks that lock these behaviors:

- V2 SKU mapping button passes `ignore_negative_cache=1`.
- V2 does not add `remote=1` or `global_scan=1` for the normal operator button.
- Price sync preflight exposes whether a payload was:
  - item-level no-model allowed,
  - single remote model upgraded,
  - stale model corrected,
  - ambiguous multi-model blocked.

Run:

```bash
node --test tests/shopee-sku-lookup-regression.test.mjs
node scripts/test-v2-shopee-bulk-price-stability.mjs
```

Expected before implementation:

- Existing tests pass.
- New assertions fail only for missing operator-visible status text or summary tokens.

- [ ] **Step 3: Implement operator-visible diagnostics**

In `v2/index.html`:

- Add a compact status line in the Shopee SKU mapping result area showing:
  - `negative cache bypass: on`
  - lookup source per region, e.g. `product_shopee_listings`, `search_item`, `global_published_model_list`, `product_shopee_listings_negative_cache`
- Add a compact price-sync preflight summary in the dry-run/modal result showing:
  - remote model readback count
  - corrected `shop_model_id` count
  - blocked ambiguous model count

Do not change the actual Shopee write path unless a test proves the current algorithm regressed.

- [ ] **Step 4: Run focused validation**

Run:

```bash
node --test tests/shopee-sku-lookup-regression.test.mjs
node scripts/test-v2-shopee-bulk-price-stability.mjs
node --test tests/v2-product-list-regression.test.mjs
npm run verify:v2-deploy-source
git diff --check
```

Expected:

- Shopee SKU lookup regression passes.
- Shopee bulk price stability passes.
- V2 product list regression passes.
- Deployment guard passes.

- [ ] **Step 5: Render/local smoke before deploy**

Use Gate C.

Expected:

- `/v2/` loads.
- Shopee tab UI text does not overlap.
- No console error during initial load.

- [ ] **Step 6: Commit, push, deploy only after approval**

Commit message:

```bash
git commit -m "Improve Shopee mapping and price sync diagnostics" -m "Co-Authored-By: Codex <codex@openai.com>"
```

Deployment after Steve approval must pass Gate E.

Live smoke:

- `https://shopee-dashboard-kohl.vercel.app/v2/` returns HTTP 200.
- Live source contains the new diagnostic labels.

**Approval decision:** Recommended as the first behavioral change.

---

## Plan 2: Joom Delete-Reregister Safety Flow

**Purpose:** Safely handle stale or duplicate Joom SKUs by deleting the old remote listing and publishing the current dashboard SKU only after dry-run validation.

**Existing detailed plan:** `C:\dev\shopee-dashboard\docs\superpowers\plans\2026-07-01-joom-delete-reregister.md`

**Approval status:** This track is not approved by this wrapper alone. Approval must explicitly name either `UI implementation only` or `UI implementation + a specific Joom remote target for live delete`.

**Files:**

- Modify: `C:\dev\shopee-dashboard\v2\index.html`
- Create: `C:\dev\shopee-dashboard\scripts\test-v2-joom-delete-reregister-flow.mjs`
- Modify: `C:\dev\shopee-dashboard\scripts\test-v2-platform-coverage.mjs`
- Existing related test: `C:\dev\shopee-dashboard\scripts\test-v2-joom-remote-cleanup-flow.mjs`

**Non-negotiable safety rules:**

- No Joom live delete in implementation tests.
- Delete-reregister must be Joom-only.
- UI must require explicit old remote target selection or override.
- Current dashboard SKU dry-run must pass before delete.
- Publish must happen only after delete succeeds.
- If publish fails after delete, the UI must show a partial-failure state.

**Steps:**

- [ ] **Step 1: Reconfirm local Joom API docs**

Read:

```text
C:\dev\api-refs\marketplaces\joom\openapi.yaml
C:\dev\api-refs\marketplaces\joom\api-catalog.md
```

Confirm:

- `/products/update` is not a safe SKU rename path.
- `/products/remove` removes product and variants.
- Removed products cannot be restored.

- [ ] **Step 2: Re-review the existing Joom plan before execution**

Use:

```text
C:\dev\shopee-dashboard\docs\superpowers\plans\2026-07-01-joom-delete-reregister.md
```

Before execution, verify the detailed plan still matches the current `v2/index.html` remote cleanup implementation. Current code already contains `joomRemoteCleanup...` helpers and the partial failure marker `remote_cleanup_publish_failed_after_delete`; if the detailed plan expects `delete_reregister_publish_failed_after_delete`, reconcile the naming before implementation.

Run the planned tests:

```bash
node scripts/test-v2-joom-delete-reregister-flow.mjs
node scripts/test-v2-joom-remote-cleanup-flow.mjs
node scripts/test-v2-platform-coverage.mjs
npm run verify:v2-deploy-source
git diff --check
```

Expected:

- New delete-reregister flow checks pass.
- Existing remote cleanup flow remains ordered as preflight -> dry-run -> delete -> publish.

- [ ] **Step 3: Execute the existing Joom plan task-by-task only after Step 2 passes**

Use the detailed plan path above as the execution source. Do not call live Joom delete during tests.

- [ ] **Step 4: Local render smoke**

Expected:

- Joom workbench shows delete-reregister only for Joom.
- Dry-run button is available before live action.
- Danger action is visually distinct.
- No persistent top panel is added above the registration table.

- [ ] **Step 5: Commit and deploy only after Steve approves live-readiness**

Commit message:

```bash
git commit -m "Add Joom delete and reregister flow" -m "Co-Authored-By: Codex <codex@openai.com>"
```

Live execution is separate from deployment approval:

- Deploying the UI is allowed after tests and live smoke.
- Actually deleting a Joom listing requires a named target SKU/product ID approval.

**Approval decision:** Approve implementation if the UI flow is needed now; defer live delete until a target product is named.

---

## Plan 3: Shopify Target Margin 0 Percent Dry-Run Audit

**Purpose:** Make Shopify repricing fail-closed first, then confirm that `target_margin_pct=0` produces expected prices before any live `productVariantsBulkUpdate`.

**Approval status:** Do not approve this as read-only audit yet. The current bridge treats `dry_run === true` as the only dry-run path, so an omitted flag can become live. First approved change must be a fail-closed guard.

**Files:**

- Review/possibly modify: `C:\dev\shopee-dashboard\supabase\functions\shopify-bridge\index.ts`
- Review/possibly modify: `C:\dev\shopee-dashboard\edge-functions\shopify-bridge\index.ts`
- Review/possibly modify: `C:\dev\shopee-dashboard\v2\index.html`
- Modify tests if needed: `C:\dev\shopee-dashboard\scripts\test-shopify-price-policy-db-ui.mjs`
- Modify tests if needed: `C:\dev\shopee-dashboard\scripts\test-shopify-product-registration.mjs`
- Modify tests if needed: `C:\dev\shopee-dashboard\scripts\test-v2-price-sync-joom-preorder-fee-ui.mjs`

**Steps:**

- [ ] **Step 1: Reconfirm local Shopify docs**

Read:

```text
C:\dev\api-refs\marketplaces\shopify\README.md
C:\dev\api-refs\marketplaces\shopify\product-create.graphql.md
C:\dev\api-refs\marketplaces\shopify\product-variants-bulk-update.graphql.md
```

Confirm:

- Current Shopify price policy is USD, KRW/USD 1460, target margin 0%, payment fee 1%, transaction fee 10%.
- `productVariantsBulkUpdate` requires `write_products`.
- Use dry-run first; do not update remote prices until approved.

- [ ] **Step 2: Add fail-closed regression before using the audit path**

Add or confirm tests that require:

- `action === 'reprice-products'`
- omitted `dry_run` is treated as dry-run, not live,
- live run requires `dry_run: false`,
- live run also requires an explicit confirm token such as `confirm: 'APPLY_SHOPIFY_REPRICE'`,
- `productVariantsBulkUpdate` is not called unless both live conditions are met.

Run:

```bash
node scripts/test-shopify-product-registration.mjs
```

Expected before implementation:

- The new fail-closed assertion fails if the bridge still uses only `body?.dry_run === true`.

- [ ] **Step 3: Implement fail-closed guard if the test fails**

Required behavior in `supabase/functions/shopify-bridge/index.ts`:

```ts
const dryRun = body?.dry_run !== false;
const liveConfirmed = body?.dry_run === false && body?.confirm === 'APPLY_SHOPIFY_REPRICE';
if (!dryRun && !liveConfirmed) {
  return jsonResp({ ok: false, error: 'shopify_reprice_confirm_required' }, 409);
}
```

Mirror the contract token in `edge-functions/shopify-bridge/index.ts` if that file is a source mirror used by tests.

- [ ] **Step 4: Add or confirm dry-run evidence path**

Expected existing behavior in `supabase/functions/shopify-bridge/index.ts`:

- `action === 'reprice-products'`
- `body.dry_run === true`
- dry-run returns planned rows and does not call `productVariantsBulkUpdate`.
- live run mirrors confirmed price into `platform_listings.remote_price`.

If missing, add regression assertions before implementation.

- [ ] **Step 5: Run Shopify-focused tests**

Run:

```bash
node scripts/test-shopify-price-policy-db-ui.mjs
node scripts/test-shopify-product-registration.mjs
node scripts/test-v2-price-sync-joom-preorder-fee-ui.mjs
npm run verify:v2-deploy-source
git diff --check
```

Expected:

- Shopify price policy DB/UI checks pass.
- Shopify product registration checks pass.
- Fee UI checks pass.

- [ ] **Step 6: Run one or two dry-run samples**

Use the internal Shopify bridge dry-run path with `dry_run: true` and `target_margin_pct: 0`. The request must be copied into the evidence note with secrets redacted.

Expected:

- No remote update.
- Planned price is based on `cost_krw / 1460 / (1 - 0.11)`.
- Shipping is excluded.
- Result lists previous remote price and planned remote price.

- [ ] **Step 7: Decide live repricing separately**

Live update requires explicit approval after dry-run output is reviewed.

**Approval decision:** Approve only the fail-closed guard and dry-run audit first. Do not approve live repricing in the same step unless sample outputs are acceptable.

---

## Plan 4: eBay Detail Image Readback Audit

**Purpose:** Determine whether eBay detail image issues are still live defects or already covered by current image payload hardening.

**Approval status:** Read-only audit is safe after Plan 0 because it uses lookup routes only. If readback proves a current defect, create a separate implementation plan before patching code.

**Files:**

- Review/possibly modify: `C:\dev\shopee-dashboard\supabase\functions\ebay-bridge\index.ts`
- Review/possibly modify: `C:\dev\shopee-dashboard\edge-functions\ebay-bridge\index.ts`
- Review/possibly modify: `C:\dev\shopee-dashboard\v2\index.html`
- Existing tests:
  - `C:\dev\shopee-dashboard\scripts\test-v2-ebay-kpop-listing-flow.mjs`
  - `C:\dev\shopee-dashboard\scripts\test-v2-ebay-register-button-bridge.mjs`
  - `C:\dev\shopee-dashboard\scripts\test-v2-marketplace-layered-image.mjs`

**Steps:**

- [ ] **Step 1: Reconfirm local eBay API docs**

Read:

```text
C:\dev\api-refs\marketplaces\ebay\sell\inventory.yaml
C:\dev\shopee-dashboard\docs\wiki\ebay-master-content-sync.md
```

Confirm:

- `PUT /inventory_item/{sku}` writes product images for single inventory item flows.
- `PUT /inventory_item_group/{inventoryItemGroupKey}` writes group default photos for variation groups.
- Current runbook expects layered representative image plus detail images, not option images, for group default photos.

- [ ] **Step 2: Run static image payload tests**

Run:

```bash
node scripts/test-v2-ebay-kpop-listing-flow.mjs
node scripts/test-v2-ebay-register-button-bridge.mjs
node scripts/test-v2-marketplace-layered-image.mjs
npm run verify:v2-deploy-source
git diff --check
```

Expected:

- eBay K-pop listing flow static checks pass.
- eBay register button bridge checks pass.
- Marketplace layered image checks pass.

- [ ] **Step 3: Select concrete readback targets**

Choose one of these sources and record it in the evidence note:

- an operator-named eBay SKU or inventory group,
- a recent mapped eBay row from `platform_listings`,
- a disposable listing created by a previous documented eBay test cycle.

Do not create a new eBay listing for this audit.

- [ ] **Step 4: Perform readback audit without writing**

Use existing eBay bridge read routes:

- `/lookup-item?sku=...`
- `/lookup-group?inventory_group_key=...`

Expected:

- Readback returns inventory item or group image URL counts.
- If image count is lower than expected, classify the gap:
  - V2 preview did not include detail images.
  - Bridge publish payload dropped detail images.
  - eBay accepted fewer images than sent.
  - Existing live listing predates the fix.

- [ ] **Step 5: Write audit evidence**

Write:

```text
C:\Users\STEVE\Documents\MVPICK\00_Inbox\Review - 2026-07-02 SD V2 eBay detail image readback audit.md
```

Required fields:

- target SKU or inventory group,
- expected representative/detail image count,
- readback image count,
- whether the live listing predates the hardening commits,
- conclusion: no code change, or new implementation plan required.

- [ ] **Step 6: Decide whether code changes are needed**

Only implement a patch if readback proves a current defect. If static tests and live readback agree, record as closed evidence in the KPI log without changing code.

**Approval decision:** Recommended as read-only audit first.

---

## Completion Rules For Any Approved Plan

Every approved implementation plan must end with:

- Focused tests passing.
- `npm run verify:v2-deploy-source` passing for V2 changes.
- Local render or local HTTP smoke for web/UI changes.
- A scoped commit with `Co-Authored-By: Codex <codex@openai.com>` when code or repo docs changed.
- No commit when a read-only audit makes no repo changes; record evidence in Obsidian instead.
- Push and production deploy only after the approved plan includes deploy and Gate E passes.
- Live smoke check after deploy.
- Obsidian KPI/runbook update under `C:\Users\STEVE\Documents\MVPICK`; do not use GitHub Wiki unless explicitly requested.

## Adversarial Review Findings - 2026-07-02

Fable5 strict review found and resolved these plan issues:

- F001: The prior document was not self-contained enough for direct Superpowers execution. Resolution: this document is now explicitly an approval gate; Plan 1 requires a dedicated execution plan, and Plan 2 requires re-review of the existing detailed plan before execution.
- F002: Shopify repricing audit lacked a fail-closed dry-run guard. Resolution: Plan 3 now requires a fail-closed regression and guard before dry-run audit use.
- F003: Deployment instructions could deploy from a mixed dirty branch. Resolution: Gate A and Gate E block deploy unless the diff is scoped and approved.
- F004: Browser/local smoke steps were not executable. Resolution: Gate C provides a Windows-safe local server pattern and browser evidence criteria.
- F005: Read-only audits lacked concrete target and evidence output rules. Resolution: Gate D and Plan 4 require target selection and evidence-note output.

## Self-Review

- Spec coverage: Covers all five next actions from the 2026-07-02 KPI report: Shopee recurrence, Joom delete-reregister, Shopify target margin, eBay detail image readback, and dirty-tree scope separation.
- Placeholder scan: The remaining high-level sections are intentionally approval gates, not worker execution steps. Tracks that require code changes must be converted into dedicated execution plans before implementation.
- Type/path consistency: File paths match the current repository and local API reference locations observed before writing this plan.
