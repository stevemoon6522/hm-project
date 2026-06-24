# eBay Change Apply Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dedicated eBay `변경 적용` modal that lists master-change details per product and applies only valid rows from one `적용` button.

**Architecture:** Keep the existing single-file V2 app structure. Add a small state object, modal renderer, item view-model helpers, and an executor that reuses `platformApplyMasterSync` while skipping invalid groups. The old inline preview remains for generic selected actions, but the needs-update toolbar shortcut routes to the new modal.

**Tech Stack:** Plain HTML/CSS/JavaScript in `v2/index.html`, Node static assertion scripts, Vercel static deployment.

---

### Task 1: Lock The New Toolbar Contract

**Files:**
- Modify: `scripts/test-v2-platform-master-sync.mjs`
- Modify: `v2/index.html`

- [ ] **Step 1: Write the failing test**

Add these assertions after the existing `data-platform-master-sync-needed` assertion:

```js
assertIncludes(html, 'function platformOpenMasterSyncDialog', 'needs-update modal opener');
assertIncludes(html, 'function platformMasterSyncDialogHtml', 'needs-update modal renderer');
assertIncludes(html, 'function platformExecuteMasterSyncDialog', 'needs-update modal executor');
assertIncludes(html, 'data-platform-master-sync-dialog-apply', 'needs-update modal apply button');
assertIncludes(html, '>변경 적용</button>', 'needs-update toolbar label');
if (html.includes("platformOpenAction(platform, 'master_sync', platformNeedsUpdateKeys(platform))")) {
  throw new Error('needs-update toolbar shortcut must open the dedicated modal instead of inline preview');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-v2-platform-master-sync.mjs`

Expected: failure for missing `platformOpenMasterSyncDialog`.

- [ ] **Step 3: Implement the toolbar route**

In `v2/index.html`, change the needs-update label calculation to:

```js
const needsUpdateMasterSyncLabel = '변경 적용';
```

Change the click handler to:

```js
root.querySelector('[data-platform-master-sync-needed]')?.addEventListener('click', () => {
  platformOpenMasterSyncDialog(platform, platformNeedsUpdateKeys(platform));
});
```

- [ ] **Step 4: Add minimal modal state and stubs**

Add:

```js
function platformOpenMasterSyncDialog(platform, explicitKeys = null) {
  if (platform === 'alibaba') return;
  const keys = (explicitKeys || platformNeedsUpdateKeys(platform)).filter(Boolean);
  if (!keys.length) {
    showToast('마스터 변경이 필요한 상품이 없습니다.', 'warn');
    return;
  }
  state.platformMasterSyncDialog = {
    platform,
    keys,
    running: false,
    results: {},
    openedAt: new Date().toISOString(),
  };
  renderPlatformWorkbench(platform);
}

function platformMasterSyncDialogHtml(platform) {
  return '';
}

async function platformExecuteMasterSyncDialog() {
}
```

Render the modal after the toolbar:

```js
${platformMasterSyncDialogHtml(platform)}
```

- [ ] **Step 5: Run test to verify it passes the contract**

Run: `node scripts/test-v2-platform-master-sync.mjs`

Expected: pass.

### Task 2: Render Clear Change Details

**Files:**
- Modify: `scripts/test-v2-platform-master-sync.mjs`
- Modify: `v2/index.html`

- [ ] **Step 1: Write the failing test**

Add assertions:

```js
assertIncludes(html, 'function platformMasterSyncDialogItems', 'needs-update dialog item builder');
assertIncludes(html, 'platformMasterSyncDialogSummary', 'needs-update dialog summary');
assertIncludes(html, '적용 가능', 'applicable status label');
assertIncludes(html, '확인 필요', 'attention status label');
assertIncludes(html, '변경 대상', 'change target summary label');
assertIncludes(html, '설명 길이', 'description length label');
assertIncludes(html, 'SET 순서', 'SET order label');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-v2-platform-master-sync.mjs`

Expected: failure for missing `platformMasterSyncDialogItems`.

- [ ] **Step 3: Implement dialog item helpers**

Add helpers that use existing master-sync functions:

```js
function platformMasterSyncDialogItems(platform) {
  const dialog = state.platformMasterSyncDialog;
  if (!dialog || dialog.platform !== platform) return [];
  return platformSelectedGroups(platform, dialog.keys).map((group) => {
    const rows = group.rows || [];
    const validation = platformMasterSyncValidation(platform, group);
    const fields = platformMasterSyncFieldLabels(platform, group);
    const description = platform === 'shopee'
      ? platformMasterSyncShopeeDescription(group)
      : (platform === 'qoo10' ? platformMasterSyncQoo10Description(group) : platformMasterSyncPlainDescription(group));
    const optionCount = platformMasterSyncOptionImageRows(group).length;
    const warnings = validation.warnings.slice();
    if (platform === 'ebay' && rows.length > 1) warnings.push('SET 순서: SET 옵션은 마지막으로 정렬됩니다.');
    return {
      key: platformGroupKey(group),
      group,
      rows,
      title: platformGroupTitle(group),
      sku: platformGroupSku(group),
      fields,
      validation,
      canApply: validation.errors.length === 0,
      mainImageCount: platformMasterSyncMainImage(rows) ? 1 : 0,
      detailImageCount: platformMasterSyncDetailImages(rows).length,
      optionImageCount: optionCount,
      descriptionLength: String(description || '').length,
      warnings,
    };
  });
}

function platformMasterSyncDialogSummary(items) {
  const applicable = items.filter((item) => item.canApply).length;
  return { total: items.length, applicable, blocked: items.length - applicable };
}
```

- [ ] **Step 4: Implement modal HTML**

Render:

```js
function platformMasterSyncDialogHtml(platform) {
  const dialog = state.platformMasterSyncDialog;
  if (!dialog || dialog.platform !== platform) return '';
  const items = platformMasterSyncDialogItems(platform);
  const summary = platformMasterSyncDialogSummary(items);
  const rowsHtml = items.map((item) => platformMasterSyncDialogItemHtml(item, dialog)).join('');
  return `
    <div class="modal-overlay show platform-master-sync-dialog" aria-hidden="false">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="platform-master-sync-dialog-title" style="width:min(1120px,100%);">
        <div class="modal-header">
          <div>
            <h2 id="platform-master-sync-dialog-title">${text(PLATFORM_LABELS[platform] || platform)} 변경 적용</h2>
            <div class="muted" style="font-size:12px;margin-top:3px;">변경 대상 ${summary.total}개 · 적용 가능 ${summary.applicable}개 · 확인 필요 ${summary.blocked}개</div>
          </div>
          <button type="button" data-platform-master-sync-dialog-close>닫기</button>
        </div>
        <div class="modal-body">
          <div class="platform-master-sync-dialog-list">${rowsHtml}</div>
        </div>
        <div class="modal-footer">
          <button type="button" class="primary" data-platform-master-sync-dialog-apply ${dialog.running || !summary.applicable ? 'disabled' : ''}>적용</button>
        </div>
      </div>
    </div>`;
}
```

- [ ] **Step 5: Run test**

Run: `node scripts/test-v2-platform-master-sync.mjs`

Expected: pass.

### Task 3: Execute Valid Items Only

**Files:**
- Modify: `scripts/test-v2-platform-master-sync.mjs`
- Modify: `v2/index.html`

- [ ] **Step 1: Write the failing test**

Add assertions:

```js
assertIncludes(html, 'if (!item.canApply) {', 'needs-update dialog skips invalid groups');
assertIncludes(html, 'platformApplyMasterSync(platform, item.group)', 'needs-update dialog applies valid groups');
assertIncludes(html, "status: 'skipped'", 'needs-update dialog skipped result');
assertIncludes(html, "status: 'success'", 'needs-update dialog success result');
assertIncludes(html, "status: 'error'", 'needs-update dialog error result');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-v2-platform-master-sync.mjs`

Expected: failure for missing skip-invalid executor.

- [ ] **Step 3: Implement executor**

Add:

```js
async function platformExecuteMasterSyncDialog() {
  const dialog = state.platformMasterSyncDialog;
  if (!dialog || dialog.running) return;
  const platform = dialog.platform;
  const items = platformMasterSyncDialogItems(platform);
  dialog.running = true;
  dialog.results = dialog.results || {};
  renderPlatformWorkbench(platform);
  let attempted = false;
  for (const item of items) {
    if (!item.canApply) {
      dialog.results[item.key] = { status: 'skipped', ok: false, message: item.validation.errors[0] || '확인 필요' };
      continue;
    }
    dialog.results[item.key] = { status: 'running', ok: null, message: '적용 중' };
    renderPlatformWorkbench(platform);
    try {
      const json = await platformApplyMasterSync(platform, item.group);
      attempted = true;
      dialog.results[item.key] = { status: 'success', ok: json.ok !== false, message: json.message || '변경 적용 완료' };
    } catch (e) {
      attempted = true;
      dialog.results[item.key] = { status: 'error', ok: false, message: e?.message || String(e) };
    }
    renderPlatformWorkbench(platform);
  }
  dialog.running = false;
  if (attempted) await loadData();
  renderPlatformWorkbench(platform);
  renderProducts();
}
```

- [ ] **Step 4: Wire close and apply buttons**

In `bindPlatformWorkbench`:

```js
root.querySelector('[data-platform-master-sync-dialog-close]')?.addEventListener('click', () => {
  state.platformMasterSyncDialog = null;
  renderPlatformWorkbench(platform);
});
root.querySelector('[data-platform-master-sync-dialog-apply]')?.addEventListener('click', () => platformExecuteMasterSyncDialog());
```

- [ ] **Step 5: Run test**

Run: `node scripts/test-v2-platform-master-sync.mjs`

Expected: pass.

### Task 4: Verify And Deploy

**Files:**
- Modify: `v2/index.html`
- Modify: `scripts/test-v2-platform-master-sync.mjs`

- [ ] **Step 1: Run static checks**

Run:

```powershell
node scripts/test-v2-platform-master-sync.mjs
node scripts/test-v2-ebay-master-sync.mjs
node scripts/test-v2-platform-test-cycle.mjs
node scripts/test-v2-custom-master-register.mjs
npm run verify:v2-deploy-source
git diff --check
```

Expected: all exit 0.

- [ ] **Step 2: Run local browser smoke**

Serve the worktree on a temporary local port and open `/v2/`. Verify the eBay toolbar shows `변경 적용`, the click opens `eBay 변경 적용`, and the modal has one primary `적용` button.

- [ ] **Step 3: Commit and push**

```powershell
git add v2/index.html scripts/test-v2-platform-master-sync.mjs docs/superpowers/specs/2026-06-25-ebay-change-apply-modal.md docs/superpowers/plans/2026-06-25-ebay-change-apply-modal.md
git commit -m "Add eBay change apply modal" -m "Co-Authored-By: Codex <codex@openai.com>"
git push origin codex/ebay-change-apply-modal:main
```

- [ ] **Step 4: Deploy and live-smoke**

Run:

```powershell
vercel deploy --prod --yes --scope moon-jeonghos-projects
```

Then verify `https://shopee-dashboard-kohl.vercel.app/v2/` shows the modal workflow without console errors.

## Self-Review

- Spec coverage: button label, modal workflow, visible change details, single apply button, skip-invalid execution, validation, commit, push, and deploy are covered.
- Placeholder scan: no placeholder markers remain.
- Type consistency: helper names and data keys match across tasks.
