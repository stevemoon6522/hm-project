# Master Multi-Select Platform Registration Design

Status: draft for Steve review
Date: 2026-06-29
Project: Shopee Dashboard V2

## Corrected Intent

This feature is not a bundle SKU, set product, WMS component stock model, or one platform listing with several selected master products as options.

The target behavior is: in one platform tab, select 2-3 existing master products and register them in one operator workflow. Each selected master product is still published as its own independent listing on that platform.

Example for the Shopee tab:

- Master A -> independent Shopee listing A
- Master B -> independent Shopee listing B
- Master C -> independent Shopee listing C

The first version must not publish to several platforms at once. Operators run the workflow platform by platform because Shopee, Joom, Qoo10, and eBay still have different validation and failure modes.

## Goals

- Allow 2-3 selected master products in a platform tab to enter one batch registration workflow.
- Keep every selected master product independent in the target platform.
- Reuse the existing single-product platform registration logic as much as possible.
- Show per-product preflight status before starting.
- Execute per product, not all-or-nothing.
- Keep successful items recorded even when later items fail.
- Allow failed items to be retried without re-registering successful items.
- Collect failed cases into a Wiki-ready failure log so follow-up fixes can be requested from real examples.

## Non-Goals

- No multi-platform simultaneous publish in version 1.
- No new bundle SKU or composite SKU.
- No WMS stock decomposition or component decrement model.
- No merging selected master products into a single platform listing or variation group.
- No large queue/job system for 10+ product publishing in version 1.
- No bypass of existing platform-specific confirmation, dry-run, or validation gates.

## Current Code Context

The V2 platform tabs already have selection and preview entry points:

- `platformOpenAction(platform, action, explicitKeys)`
- `platformOpenPreview(platform, action, explicitKeys)`
- `platformExecutePreview()`
- `platformSelectedGroups(platform, explicitKeys)`
- `platformOpenExistingModal(platform, group)`
- platform-specific registration modals:
  - Shopee: `openRegisterShopeeSingleModal`, `openRegisterShopeeGroupModal`
  - Joom: `openRegisterJoomGroupModal`
  - Qoo10: `openRegisterQoo10GroupModal`
  - eBay: `openRegisterEbayGroupModal`

The current preview executor can process dispatcher-capable platforms directly, but registration for Shopee/Joom/Qoo10/eBay is intentionally routed through existing validation modals. That constraint should stay in version 1.

## Recommended Architecture

Add a small UI batch controller above the existing platform-specific registration paths.

The controller owns batch state and per-product status, but it does not reinvent platform publish payloads. For each selected product group, it calls the same platform-specific registration entry point that the single-row `등록` button already uses.

Batch state shape:

```js
state.platformBatchRegistration = {
  id: string,
  platform: 'shopee' | 'joom' | 'qoo10' | 'ebay',
  keys: string[],
  createdAt: string,
  running: boolean,
  currentKey: string | null,
  items: [
    {
      key: string,
      productIds: string[],
      sku: string,
      title: string,
      status: 'pending' | 'preflight_failed' | 'ready' | 'running' | 'succeeded' | 'failed' | 'skipped',
      preflightErrors: string[],
      preflightWarnings: string[],
      startedAt: string | null,
      finishedAt: string | null,
      platformItemId: string | null,
      platformListingId: string | null,
      errorCode: string | null,
      errorMsg: string | null,
      retryable: boolean
    }
  ]
}
```

For grouped option products already represented by one `product_group_id`, one selected platform group still counts as one registration target. Its existing modal can continue to register that group as one platform listing with options. The new feature is about selecting several independent registration targets at once, not changing what each target means internally.

## UX Flow

1. Operator opens one platform tab, for example Shopee.
2. Operator selects 2-3 registration targets.
3. Operator clicks `등록`.
4. If only one target is selected, keep the existing single-target behavior.
5. If 2-3 targets are selected, show a batch registration panel.
6. The panel lists each target with SKU, title, current platform status, preflight result, and retry state.
7. `시작` runs the targets one by one.
8. The current product opens/uses the existing platform registration flow.
9. After a product succeeds or fails, the batch panel updates that item and moves to the next ready item.
10. At the end, the panel shows success count, failure count, and a Wiki failure log block when there are failures.

Selection guardrails:

- 0 selected: show "등록할 상품을 선택하세요."
- 1 selected: current single-product flow.
- 2-3 selected: batch flow.
- More than 3 selected: block with "현재 일괄 등록은 최대 3개까지 지원합니다."

## Execution Semantics

Version 1 should execute sequentially.

- Do not fire parallel platform create requests.
- Do not stop the whole batch when one product fails.
- Skip products that fail preflight until the operator fixes them.
- Do not rerun products already marked succeeded in the same batch.
- Allow retry for failed/skipped items only.
- Refresh platform listing state after each item or after the full batch, depending on the platform cost.

This keeps operational behavior close to today's one-by-one registration while reducing repeated manual selection and giving a consolidated result view.

## Failure Logging And Wiki Workflow

Failure cases must be collected separately from success cases.

The batch panel should build a redacted Markdown failure log with this structure:

```md
# SD Platform Batch Registration Failures - YYYY-MM-DD

- Platform:
- Batch ID:
- Operator:
- Started:
- Finished:

## Summary

- Selected:
- Succeeded:
- Failed:
- Skipped:

## Failed Items

### SKU / Product title

- master_product_id:
- product_group_id:
- platform:
- action: register
- stage: preflight | modal_open | dry_run | publish | mapping | unknown
- error_code:
- error_msg:
- preflight_errors:
- preflight_warnings:
- platform_item_id:
- platform_listing_id:
- retry_status: pending
- follow_up_needed:
```

Because the deployed web app cannot directly write to Steve's local Obsidian vault, version 1 should provide one or both of these operator-safe outputs:

- `Copy Wiki Log` button: copies the Markdown block to clipboard.
- `Download .md` button: downloads the Markdown file.

When Codex is handling a follow-up session, the Markdown should be saved to the local Wiki target:

`C:\Users\STEVE\Documents\MVPICK\00_Inbox\SD Platform Batch Registration Failures - YYYY-MM.md`

If failure tracking becomes frequent, a later version can add Supabase tables such as `platform_batch_runs` and `platform_batch_run_items`, then generate the Wiki log from persisted rows. That is not required for version 1.

## Error Handling

Per item statuses:

- `preflight_failed`: local validation found missing fields before opening the platform registration flow.
- `failed`: an existing modal, dry-run, publish request, or mapping update failed.
- `succeeded`: the platform listing was created and local mapping was updated.
- `skipped`: operator skipped the item or it was already succeeded in this batch.

Batch-level errors should be limited to UI/controller failures, for example missing selected groups or invalid platform action. Platform failures belong to individual items.

Every failed item should keep enough context for a future fix request without exposing secrets:

- Include SKU, title, product IDs, platform, stage, error code, and message.
- Include request shape summaries only when redacted.
- Do not include access tokens, service-role keys, auth headers, cookies, or full marketplace credentials.

## Testing Plan

Add static and pure-function regression tests first:

- batch selection limit: 0, 1, 2, 3, 4 selected targets
- selected target normalization from platform group keys
- item status transitions
- failure log Markdown generation
- retry filter only includes failed/skipped items, not succeeded items
- existing single-target `등록` path still opens the current modal
- multi-target path does not call multi-platform execution

Then run existing relevant V2 tests:

- `node scripts/test-v2-platform-coverage.mjs`
- `node scripts/test-v2-platform-master-sync.mjs`
- `node scripts/test-v2-shopee-registration-platform-mapping.mjs`
- `node scripts/test-v2-joom-registration-platform-mapping.mjs`
- `node scripts/test-v2-qoo10-registration-platform-mapping.mjs`
- `node scripts/test-v2-ebay-platform-listing-mapping.mjs`
- `npm run verify:v2-deploy-source`

Before deploy, verify the rendered `/v2/` app locally and smoke-check the live URL after deployment.

## Implementation Boundary

Version 1 should touch only:

- platform tab UI state and preview panel rendering
- a batch registration controller/helper layer
- failure log Markdown generator
- small hooks from existing platform registration flows into batch status updates
- focused regression tests

It should not rewrite platform adapters or marketplace API calls unless a specific failure discovered during testing requires a narrow fix.

## Resolved Version 1 Decisions

- The first batch runner uses modal-stepped sequential execution for Shopee, Joom, Qoo10, and eBay. It opens the existing registration flow for one target at a time and records that target's result before moving to the next. Hidden auto-submit is out of scope for version 1.
- Version 1 should provide both `Copy Wiki Log` and `Download .md` when failures exist.
- Version 1 focuses on Shopee, Joom, Qoo10, and eBay. Shopify remains on its existing direct dispatcher path and does not drive this design.
