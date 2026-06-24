# eBay Change Apply Modal Spec

## Goal

Replace the inline eBay master-change preview with a focused modal workflow. The toolbar button must read `변경 적용`, open a dedicated dialog, show clearly which master data will change for each product, and let the operator apply only valid changes from a single `적용` button.

## Approved Workflow

1. The eBay platform toolbar shows `변경 적용` instead of `수정 필요 N개 적용`.
2. The button is enabled when the current filters have at least one `needs_update` group and disabled otherwise.
3. Clicking `변경 적용` opens a modal dialog rather than inserting a preview block into the platform page.
4. The modal header shows `eBay 변경 적용` and a concise summary: total change targets, applicable targets, and targets requiring attention.
5. Each product row/card shows:
   - SKU/group key and product title.
   - Status badge: `적용 가능`, `확인 필요`, `적용 중`, `성공`, or `실패`.
   - Changed data fields such as product description, representative image, detail images, option images, and SET-last variation ordering.
   - Counts for representative image, detail images, option images, option/SKU count, and description length.
   - Validation errors and warnings.
6. The modal footer contains one primary `적용` button. Secondary close controls are allowed only as dialog controls.
7. Pressing `적용` runs `platformApplyMasterSync` only for applicable groups. Groups with validation errors are skipped and remain visible with their reason.
8. Results appear in the same modal. Data is reloaded after at least one applicable group is attempted.
9. Existing inline `platformPreviewHtml` remains available for other actions, but the `변경 적용` toolbar shortcut must not use it.

## Non-Goals

- Do not redesign the full platform workbench.
- Do not change the eBay bridge API contract.
- Do not force invalid eBay rows through the API.
- Do not remove the existing selected-item `마스터 변경 적용` action unless it is naturally replaced later.

## Error Policy

Use "apply possible only": rows with validation errors are marked `확인 필요` and skipped. Valid rows are applied immediately when the operator clicks `적용`.

## Verification

- Static tests must assert the new button label, modal functions, skip-invalid execution path, and that the old needs-update shortcut no longer calls `platformOpenAction(platform, 'master_sync', ...)`.
- Browser smoke must verify that the live eBay toolbar shows `변경 적용`, opens the modal, and the modal contains the `적용` button without console errors.
