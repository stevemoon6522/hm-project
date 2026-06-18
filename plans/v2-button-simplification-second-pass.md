# V2 Button Simplification Second Pass

Created: 2026-06-18
Status: planning
Scope: authenticated V2 UI button inventory and simplification plan

## Verification Source

This pass is based on the live authenticated V2 UI at:

- `https://shopee-dashboard-kohl.vercel.app/v2/`
- test account session active
- button inventory collected from visible DOM buttons by view

Relevant local code:

- `v2/index.html` `renderProducts()`
- `v2/index.html` `renderPlatformWorkbench(platform)`
- `v2/index.html` `platformOpenAction()`
- `v2/index.html` `platformSyncSelected()`
- `v2/index.html` `platformExecutePreview()`

## Current Visible Button Inventory

Navigation buttons are excluded from the counts below.

| View | Top-level buttons | Repeated row buttons | Main finding |
| --- | ---: | ---: | --- |
| Master | 9 | 0 | Recovery/destructive utilities are too prominent. |
| Shopee | 18 | 53 | Row actions repeat heavily; Shopee also has region chips and name sync. |
| Joom | 11 | 53 | Same register/edit/delete row repetition. |
| Qoo10 | 11 | 53 | Same register/edit/delete row repetition. |
| eBay | 11 | 53 | Same register/edit/delete row repetition. |
| Alibaba | 11 | 53 | Unsupported/disabled actions still occupy UI. |
| Daily Close | 1 | 0 | Acceptable. |
| Fee Settings | 10 | 0 | Reset utility is too exposed. |

The platform tabs are the largest problem: with only 10 master products visible,
each platform exposes roughly 64-71 non-navigation buttons. Most of that is
row-level repetition of the same three actions.

## Decisions Already Confirmed

These are now guardrails, not open questions:

1. Single selected platform registration opens the existing direct registration
   modal, not a bulk preview.
2. Multi-selected platform registration remains confirm-first.
3. Platform SKU mapping is scoped to selected product ids and the current
   platform only.
4. Joom delete was verified with a disposable real listing and cleans local
   mapping through the UI.
5. Shopee English name sync belongs in the Shopee platform context, not the
   master product list.

## Simplification Rules

1. One task surface should have one primary action.
2. Repeated row actions should move to either selection toolbar, row overflow,
   or the detail drawer.
3. Unsupported platform actions should be hidden, not shown disabled on every
   row.
4. Recovery utilities should live in a recovery/admin area, not the main daily
   workflow.
5. Single-product actions should avoid preview banners unless the action is
   destructive or irreversible.
6. Multi-product actions should show a compact summary preview with exact count,
   platform, and blockers.
7. Filters and tabs are not "actions" and may stay visible if they reduce scan
   time.

## Keep / Move / Remove Decisions

### Master Product View

Keep:

- global master registration entry
- custom master registration entry
- URL bulk registration entry
- lifecycle filter buttons
- `Refresh`, but convert to a compact refresh icon later

Move:

- empty-SKU select utility: move to the future Data Required queue or recovery menu. It is
  useful, but not a default daily action.
- selected master delete: move behind a danger-zone bulk menu or show only after selection.
  It should not be a permanently visible top-level button.

Do not add:

- platform registration buttons in the master list;
- platform SKU mapping in the master list;
- Shopee English sync in the master list.

### Platform Workbench Top Actions

Keep:

- status filters: all, listed, missing, pending, error;
- Shopee region chips;
- select visible items;
- clear selection, but only show when selection count is greater than zero;
- platform registration;
- platform price edit;
- platform delete;
- platform SKU mapping.

Move:

- Shopee English-name sync: keep in Shopee, but move into a selected-product
  detail drawer or overflow after the drawer exists. Until then, keep it as a
  selected-single action only.

Rename:

- platform registration: use dynamic labels:
  - no selection, exactly one visible product: direct register
  - one selected product: direct register
  - multiple selected products: selected register confirmation

Already implemented behavior mostly follows this; the label must be checked in
every platform after future refactors.

### Platform Row Actions

Current repeated row actions:

- register
- price edit
- delete
- edit master
- LED detail button
- expand/collapse

Keep visible per row:

- expand/collapse;
- LED/status button;
- master edit or detail open button.

Move out of visible row:

- row register
- row price edit
- row delete

Replacement:

- row click or checkbox selects the product;
- selected action toolbar handles register/edit/delete/SKU mapping;
- detail drawer can expose row-specific direct actions for operators who want a
  one-row flow.

Reason:

The row buttons duplicate the top action toolbar and create 30 extra buttons per
platform for 10 visible products. At 100 visible products they become a dense
wall of 300 repeated buttons.

### Alibaba

Current issue:

Alibaba shows the same platform action structure, but row actions are disabled
and the platform is not operationally ready.

Decision:

- Hide register/edit/delete/SKU mapping actions while Alibaba capability is not
  enabled.
- Show one informational action instead: settings check or Alibaba readiness.
- Keep status filters only if they help inspect existing data.

Do not show disabled row action buttons for every product.

### Fee Settings

Keep:

- marketplace/country tabs.

Move:

- fee reset from DB: move into an advanced reset dialog and make the label include
  the current target country. A DB restore/reset is too destructive to sit as a
  plain always-visible button.

### Daily Close

Keep:

- refresh.

No simplification needed now.

## Registration Preview Policy

Current operator concern:

Platform registration sometimes opens a bulk preview screen when a direct
registration dashboard would be faster.

Policy:

1. Single product: open the platform registration dashboard/modal directly.
2. One visible product after filtering: open directly.
3. Multiple selected products: show compact confirmation summary first.
4. Bulk preview should list only blockers and target count, not become a second
   dashboard.
5. Dry-run/payload preview inside registration modals should be optional unless
   the platform API requires it before live execution.

This policy is already partly implemented for platform tabs. The remaining work
is to remove row-level duplicates and keep future modals from reintroducing
forced preview steps for single-product work.

## Implementation Plan

### Phase 1 - Hide Unsupported and Recovery Buttons

- Hide Alibaba register/edit/delete/SKU mapping actions while disabled.
- Hide clear selection when selection count is zero.
- Move empty-SKU select and always-visible selected delete out of the master toolbar.
- Move fee reset into an advanced dialog.

Expected result:

- Master toolbar drops from 9 to roughly 6 visible controls.
- Alibaba platform tab drops from 64 visible controls to status filters plus
  one readiness action.

### Phase 2 - Remove Repeated Platform Row Actions

- Remove visible row register/price-edit/delete buttons from platform tables.
- Keep row status LED, expand, and edit/detail.
- Use selected action toolbar for platform actions.
- Add a row overflow/detail drawer only if direct one-row action speed suffers.

Expected result:

- Joom/Qoo10/eBay visible non-navigation buttons with 10 rows drop from about 64
  to about 34.
- Shopee drops from about 71 to about 41 because region chips remain.

### Phase 3 - Detail Drawer

- Add selected product drawer.
- Put rare single-product utilities there:
  - Shopee English name sync;
  - row-level direct register/edit/delete;
  - source evidence;
  - recent platform action history.

Expected result:

- primary tables become scan-first;
- uncommon utilities remain reachable without occupying every row.

### Phase 4 - Queue-Specific Actions

- Add Data Required, Platform Ready, Mapping Required, and Failed Actions queues
  from `plans/v2-master-product-bulk-management-plan.md`.
- Each queue exposes one primary action.
- Queue view controls the action labels and keeps the default toolbar small.

Expected result:

- operator starts from "what needs work", not "all possible buttons".

## Acceptance Criteria

- Master toolbar has no always-visible destructive action.
- Unsupported Alibaba actions are not visible as disabled repeated row buttons.
- Platform table rows do not show register/price-edit/delete as repeated buttons.
- Single selected register remains direct.
- Multi-selected register/delete remains confirm-first.
- Platform SKU mapping remains scoped to current platform.
- Authenticated Playwright inventory confirms reduced visible button counts.
- Existing platform registration, delete, and SKU mapping regression tests pass.

## Verification Plan

For every implementation phase:

- run `node tests/v2-product-list-regression.test.mjs`;
- run `node scripts/test-v2-platform-coverage.mjs`;
- run authenticated Playwright visible-button inventory;
- smoke one platform tab with no console warnings;
- for destructive/remote actions, use disposable products/listings only.

## Recommended Order

1. Phase 1 first: low-risk visibility changes and recovery-menu movement.
2. Phase 2 second: remove row action duplication and rely on selection toolbar.
3. Phase 3 third: add the drawer only if operators need row-level speed.
4. Phase 4 fourth: implement work queues after the master index pagination plan.
