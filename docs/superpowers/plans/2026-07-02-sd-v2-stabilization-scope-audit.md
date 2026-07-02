# SD V2 Stabilization Scope Audit - 2026-07-02

## Current Branch

- Repo: `C:\dev\shopee-dashboard`
- Branch: `codex/ebay-seller-hub-rate-table`
- Upstream: `origin/codex/ebay-seller-hub-rate-table`
- Worktree state: normal checkout, not a linked git worktree
- `git rev-parse --git-dir`: `.git`
- `git rev-parse --git-common-dir`: `.git`
- Superproject: none

Recent HEAD:

```text
17b39a2 (HEAD -> codex/ebay-seller-hub-rate-table, origin/codex/ebay-seller-hub-rate-table) Fix Shopify target margin repricing
0c56590 Integrate Shopify policy into fee filters
d663e49 chore: add ebay seller hub shipping rate table
47168db Fix Shopee price sync model preflight
1265ee0 Fix Shopee SKU mapping negative cache bypass
08fa710 feat: add Joom remote cleanup flow
371eb2a Harden eBay publish image payloads
6db62d3 Fix eBay registration detail images
12801fb Cache Shopee SKU not-listed lookups
8b0867c Speed up Shopee SKU mapping
deb5b1c Bound Shopee SKU lookup global scan
bd1046a Optimize Shopee registration read path
```

## Dirty Files By Bucket

### Cross-Cutting / Must Split Before Any Feature Commit

- `v2/index.html`
  - Current diff contains Joom remote cleanup modal and delete-reregister controls.
  - Current diff contains Shopify platform sync / archive / price policy logic.
  - Current diff contains Qoo10 representative image and weight logic.
  - Current diff contains Shopee/platform action UI changes.
  - This file is the main mixed-scope conflict point. It must not be committed under any single marketplace track without a line-by-line scoped review.
- `AGENTS.md`
  - Modified outside Plan 0. Treat as repo-instruction drift until reviewed.
- `tests/v2-product-list-regression.test.mjs`
  - Contains Shopify target sync regression additions and may overlap with platform list behavior.

### Joom Cleanup / Delete-Reregister

- `scripts/benchmark-joom-registration-latency.mjs`
- `scripts/test-v2-joom-registration-platform-mapping.mjs`
- `scripts/test-v2-joom-remote-cleanup-flow.mjs`
- `docs/superpowers/plans/2026-07-01-joom-delete-reregister.md` (untracked)
- `v2/index.html` partial ownership only:
  - `joomRemoteCleanup...` helpers
  - `joom-remote-cleanup-modal`
  - `data-joom-remote-dryrun`
  - `data-joom-remote-delete-reregister`

### Shopify Repricing / Policy / Platform Parity

- `edge-functions/shopify-bridge/index.ts`
- `supabase/functions/platform-publish/adapters/shopify.ts`
- `supabase/functions/shopify-bridge/index.ts`
- `scripts/test-shopify-price-policy-db-ui.mjs`
- `scripts/test-shopify-product-registration.mjs`
- `scripts/test-v2-price-sync-joom-preorder-fee-ui.mjs`
- `scripts/test-v2-shopify-platform-parity.mjs` (untracked)
- `supabase/migrations/202607020002_shopify_platform_parity.sql` (untracked)
- `v2/index.html` partial ownership only:
  - Shopify platform sync target handling
  - Shopify archive path
  - Shopify price policy and catalog price sync logic

### Qoo10 Master Content / Weight

- `supabase/functions/platform-publish/adapters/qoo10.ts`
- `supabase/functions/qoo10-bridge/index.ts`
- `tests/qoo10-mapping-regression.test.mjs`
- `scripts/test-v2-qoo10-master-content-weight.mjs` (untracked)
- `docs/superpowers/plans/2026-07-02-qoo10-master-content-weight.md` (untracked)
- `v2/index.html` partial ownership only:
  - Qoo10 root/master image selection
  - Qoo10 representative image reference
  - Qoo10 weight kg conversion

### Shopee Recurrence Guard Candidate

- No standalone modified Shopee bridge/test file is currently visible for the next proposed Shopee diagnostics track.
- Existing current branch commits already include:
  - `1265ee0 Fix Shopee SKU mapping negative cache bypass`
  - `47168db Fix Shopee price sync model preflight`
- If Plan 1 is approved next, it should start from a dedicated execution plan and a scoped diff. Do not reuse the current mixed `v2/index.html` diff without isolating the Shopee-specific hunks.

### eBay Image / Readback Candidate

- No currently modified eBay bridge/test file is visible in `git status`.
- Existing branch commits already include:
  - `6db62d3 Fix eBay registration detail images`
  - `371eb2a Harden eBay publish image payloads`
  - `d663e49 chore: add ebay seller hub shipping rate table`
- Plan 4 can proceed as read-only audit after Plan 0 because it should not write repo code or marketplace state.

### Repo Plans / Documentation

- `docs/superpowers/plans/2026-06-26-master-representative-image-separation.md` (untracked)
- `docs/superpowers/plans/2026-06-30-custom-master-copy-inventory-sku-scroll.md` (untracked)
- `docs/superpowers/plans/2026-07-01-joom-delete-reregister.md` (untracked)
- `docs/superpowers/plans/2026-07-02-qoo10-master-content-weight.md` (untracked)
- `docs/superpowers/plans/2026-07-02-sd-v2-stabilization-next-actions.md` (untracked)
- `docs/superpowers/plans/2026-07-02-sd-v2-stabilization-scope-audit.md` (this Plan 0 audit)

### Artifacts / Never Stage

- `.codex-artifacts/qoo10-v2-local-cli.png`
- `.codex-fable5/findings.json`
- `.codex-fable5/ledger.jsonl`
- `test-results/.last-run.json`
- `tests/v2-platform-search-focus.test.mjs` (untracked; classify before use)

## Files Excluded From This Approval

Plan 0 approves only scope audit and baseline non-live verification. It does not approve committing, deploying, or continuing any of these tracks:

- Joom delete-reregister implementation
- Shopify repricing, policy, or platform parity implementation
- Qoo10 master content or weight implementation
- Shopee diagnostic UI implementation
- eBay image/readback patch implementation
- Any production deploy
- Any marketplace live write
- Any staging of `.codex-artifacts/`, `.codex-fable5/`, `test-results/`, screenshots, or local test output

## Approved Track Candidate

### Approved Now

- Plan 0 only:
  - capture status,
  - classify dirty files,
  - write this scope audit,
  - run baseline non-live verification.

### Recommended Next Approval

1. Plan 4 read-only eBay detail image readback audit
   - Lowest write risk.
   - Does not need to touch current mixed `v2/index.html` if performed as lookup/readback only.
2. Plan 1 Shopee mapping / price sync diagnostics
   - High operational value, but must start with a dedicated execution plan and isolated file hunks.
3. Plan 3 Shopify fail-closed guard
   - Required before any Shopify repricing audit can be considered safe.
   - Must not be bundled with Qoo10 or Joom changes.
4. Plan 2 Joom delete-reregister UI
   - Useful, but high live-delete risk. UI-only approval and live target approval should remain separate.

## Risk If Committed Together

- `v2/index.html` currently mixes Joom, Shopify, Qoo10, Shopee/platform action, and search/focus work. A single commit from the current tree would obscure which behavior changed and make rollback unsafe.
- Shopify repricing and Qoo10 weight changes both touch platform publish paths. Shipping/price payload regressions could be misattributed if committed together.
- Joom delete-reregister contains irreversible remote-delete semantics. It must be reviewed separately from low-risk UI or readback audit changes.
- `.codex-fable5/`, `.codex-artifacts/`, and `test-results/` are local evidence/state, not product artifacts. Staging them would pollute the repo.
- Current branch name is eBay-specific, but dirty tree includes non-eBay work. Deploying from this branch without scope split would violate the approval gates in the SD V2 stabilization plan.

## Required Split Before Implementation

Before any next track is implemented:

1. Run `git status --short --branch` and `git diff --name-only`.
2. Confirm only files for the approved track will be edited or staged.
3. If `v2/index.html` is needed, inspect hunks and isolate only the approved track.
4. Do not stage `.codex-artifacts/`, `.codex-fable5/`, `test-results/`, or unrelated plan files.
5. Run focused tests for that track.
6. Run `npm run verify:v2-deploy-source` for V2 changes.
7. Use local render smoke for UI changes.
8. Commit only after the scoped diff is clean.
9. Push/deploy only after Steve explicitly approves deploy for that track.

## Plan 0 Command Evidence

Captured commands:

```bash
git status --short --branch
git diff --stat
git log --oneline --decorate --max-count=12
git diff --name-only
git diff --cached --name-only
git ls-files --others --exclude-standard
```

Key observations:

- No staged files were present.
- Modified tracked files: 16.
- Untracked paths include local artifacts, Fable5 findings state, Qoo10/Shopify tests and migration, and several plan documents.
- `git diff --stat` reports `16 files changed, 982 insertions(+), 116 deletions(-)` before this audit file.
- Git for Windows reports LF to CRLF warnings for several changed files. These are warnings, not whitespace errors by themselves.

## Baseline Non-Live Verification

Executed after writing this audit:

```bash
node scripts/test-sd-operating-efficiency-docs.mjs
npm run verify:v2-deploy-source
git diff --check
```

Results:

```text
SD operating efficiency docs and helper checks passed
V2 deployment guard passed for C:\dev\shopee-dashboard
git diff --check: no whitespace errors; LF to CRLF warnings only
```

Live write status: none.

Deploy status: not deployed. Plan 0 does not approve deployment.
