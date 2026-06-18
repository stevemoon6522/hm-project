# V2 Master Product Bulk Management Plan

Created: 2026-06-18
Status: planning
Scope: Shopee Dashboard V2 master product list and platform workbench UX

## Context

The V2 dashboard is moving toward a master-data-first workflow. That is the
right direction, but the master product table will not stay small. Once it
holds hundreds or thousands of K-pop album, goods, option, and platform-mapped
rows, a plain all-products table becomes an operational risk:

- operators scan too many rows before reaching today's work;
- checkbox selections can accidentally cross a hidden filter boundary;
- bulk actions can feel convenient while hiding large blast radius;
- missing image, cost, weight, category, or platform identifier issues are not
  first-class work queues;
- old releases and archived platform listings keep competing with active work.

Current V2 reference points:

- `v2/index.html` `loadData()` fetches products and rollups into browser state.
- `renderProducts()` filters in the browser by free-text search and lifecycle.
- Platform workbenches derive groups from the same master product state and
  already scope registration, delete, and SKU mapping by selected platform group.
- `platform_listing_rollups` is the right source for platform coverage summary.
- Existing plans `plans/project-goal.md`,
  `plans/master-first-platform-registration-plan.md`, and
  `plans/v2-master-data-platform-split.md` establish the master-data-first
  direction.

## Product Management Rule

The master product list should not be the operator's daily task list. It should
be the searchable source of truth. Daily work should start from focused queues:

1. Needs data cleanup
2. Needs platform registration
3. Needs SKU mapping/reconciliation
4. Needs price review
5. Failed or blocked platform actions
6. Recently changed products
7. Archived/discontinued products

The default screen should show actionable exceptions first, not every master
product.

## Target Information Architecture

### 1. Master Index

Purpose: find and inspect any product.

Required controls:

- server-side search by SKU, product name, option name, source URL, and platform
  item id;
- lifecycle filter: all, pre_order, ready_stock, archived/discontinued;
- product kind filter: album, goods, custom;
- platform coverage filter: missing, pending, listed, failed, stale;
- data quality filter: missing cost, missing weight, missing image, missing
  category, duplicate SKU risk;
- sort by created_at, updated_at, release date, source age, last platform sync;
- pagination or virtualized rows with stable count display.

Default page size: 50 rows. The UI may offer 100 or 200, but it must not render
thousands of rows into the DOM at once.

### 2. Work Queues

Purpose: reduce operator decisions to the next concrete task.

Queues:

- Data Required: products missing cost, weight, main image, lifecycle, or option
  identity.
- Platform Ready: products that pass data gates but are missing one or more
  target platform listings.
- Mapping Required: products with remote SKU hits, stale local mappings, or
  missing platform item/model identifiers.
- Price Review: products whose cost, FX, fee rule, or margin snapshot changed
  enough to require review.
- Failed Actions: failed registration, delete, price update, or sync attempts
  grouped by platform and error type.
- Recently Changed: created or edited in the last 7 days.
- Archive Candidates: old releases with no recent stock or platform activity.

Each queue should expose one primary action only. Example: "Map Joom SKU" in the
Joom mapping queue, not a row full of unrelated platform buttons.

### 3. Product Detail Drawer

Purpose: inspect one product without leaving the current queue.

The drawer should contain:

- canonical master fields;
- option rows and SKU identity;
- source evidence and last update timestamp;
- platform rollup summary;
- recent action log;
- data quality blockers;
- safe quick actions for the current queue only.

Heavy registration modals remain separate, but opening them should preserve the
selected product context.

## Bulk Selection Rules

Bulk operations are allowed only when the UI makes the scope explicit.

Rules:

1. A selected row count must always be visible.
2. "Select visible" selects only rows rendered on the current page/filter.
3. "Select all matching filter" is a separate action and must show the exact
   server-side match count before enabling.
4. Platform actions must stay scoped to the current platform tab or queue.
5. Single selected product actions should open the direct dashboard/modal.
6. Multi-selected destructive or platform-mutating actions require a summary
   preview with product count, platform, target ids, and blockers.
7. Selection must be cleared or revalidated when filters, page, lifecycle, or
   queue changes.
8. No action should silently operate on all products because no checkbox is
   selected, except when exactly one visible product remains after filtering.

The recently fixed platform register and SKU mapping flows match these rules:
single selection goes direct; multi-selection stays confirm-first; platform SKU
mapping receives `[currentPlatform]` rather than all platforms.

## Data Model Additions

These fields or views should be considered before UI scale work:

- `products.lifecycle_state`: continue using pre_order and ready_stock, add a
  separate archive/discontinued state or status if the business process needs
  it.
- `products.product_kind`: already useful for album/goods/custom filtering.
- `products.updated_at`: required for recent-change sorting if not reliable now.
- `products.last_reviewed_at`: optional, useful for stale data queues.
- `products.data_quality_status`: can be computed in a view before becoming a
  stored column.
- `platform_listing_rollups`: keep as the summary source for platform coverage.
- `platform_action_runs` or equivalent audit view: useful for failed action
  queues and retry grouping.

Prefer computed views first. Store new columns only when the value is edited by
an operator or needed for indexing/performance.

## Implementation Phases

### Phase 0 - Baseline and Guardrails

- Count current products, platform rollups, and missing data categories.
- Add regression tests for selection scope, single-visible fallback, and platform
  action narrowing.
- Document every master and platform button with owner, action type, mutation
  target, and recommended keep/remove decision.

Exit criteria:

- every current bulk/platform action has a named scope;
- no current action can widen from selected product to all platforms or all
  products without an explicit preview.

### Phase 1 - Server-Side Master Index

- Move master product search/filter/page to a server query or RPC.
- Return only the current page of rows plus total count.
- Keep platform rollups fetched by visible product ids.
- Add indexes for SKU, product_name, lifecycle_state, product_kind, updated_at,
  and any search expression used by the query.

Exit criteria:

- 1,000+ products do not freeze the browser;
- search and lifecycle/product-kind filters return in an operator-usable time;
- checkbox selections survive page render only when the selected ids remain in
  the current scope.

### Phase 2 - Queue Navigation

- Add a queue selector above the master index.
- Implement Data Required, Platform Ready, Mapping Required, Failed Actions, and
  Recently Changed first.
- Each queue should have one primary button aligned with the queue's task.
- Move lower-frequency utilities into row detail drawers or overflow menus.

Exit criteria:

- the default master screen shows actionable work, not a long neutral list;
- each queue has clear empty, loading, and error states;
- queue counts match DB/source-of-truth counts.

### Phase 3 - Detail Drawer and Action Context

- Add a right-side detail drawer for one selected master product.
- Show platform status, blockers, recent action history, and source evidence.
- Route queue-specific actions from the drawer to the existing platform modals.
- Keep destructive actions in the drawer only when they are scoped to one product.

Exit criteria:

- an operator can inspect and act on one product without losing the filtered
  queue context;
- row-level buttons are reduced to inspect/edit plus the queue primary action.

### Phase 4 - Archive and Hygiene Workflow

- Define archive/discontinued criteria.
- Add an Archive Candidates queue.
- Add bulk archive only with preview and exact count.
- Exclude archived products from default platform workbench views unless the
  operator explicitly filters for them.

Exit criteria:

- old releases stop crowding active work;
- archived products can still be found from Master Index search;
- platform cleanup/delete remains separate from master archive.

## Button Simplification Implications

The master list should keep:

- Edit master
- Inspect/detail
- Delete master, only behind explicit confirmation
- One queue-specific primary action

The master list should not expose:

- platform-specific registration buttons for every platform on every row;
- platform SKU mapping buttons that run outside the current platform context;
- duplicate retry buttons that open the same registration flow;
- bulk preview screens for single selected products;
- utility buttons that are only useful during rare recovery workflows.

Rare utilities should move to:

- detail drawer overflow menu;
- failed-action queue;
- admin/recovery section;
- command palette style search if needed later.

## Verification Plan

For each phase:

- Node regression tests for scope rules and selected-id preservation.
- Playwright smoke on authenticated V2 UI.
- Disposable product tests for mutating flows where a real bridge call is needed.
- DB verification that test rows are cleaned after each run.
- Live smoke after deployment on `https://shopee-dashboard-kohl.vercel.app/v2/`.

Performance checks:

- seed or mock at least 1,000 products;
- confirm first render, search, queue switch, and selection toggle do not lock
  the browser;
- confirm network payloads are page-sized, not full-table when server-side
  pagination lands.

## Recommended Next Work

1. Build the button inventory from `v2/index.html` and classify each button as
   keep, move, merge, or remove.
2. Add a DB-backed master index query with pagination.
3. Add the first two queues: Data Required and Platform Ready.
4. Move rare platform utilities into the product detail drawer or failed-action
   queue.
5. Add a seed/performance test for 1,000 master products before expanding more
   platform actions.
