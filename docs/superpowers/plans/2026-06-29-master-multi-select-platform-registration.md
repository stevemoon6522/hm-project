# Master Multi-Select Platform Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In one platform tab, let the operator select 2-3 master product targets and register them as independent platform listings one by one, with per-item results and Wiki-ready failure logging.

**Architecture:** Add a small guided batch controller inside the existing V2 platform tab UI. It reuses the current single-target platform registration modals for Shopee, Joom, Qoo10, and eBay, records per-item status after operator confirmation, and produces a redacted Markdown failure log. It does not change marketplace adapters, WMS stock logic, or the platform-publish contract.

**Tech Stack:** Static V2 HTML/JavaScript app (`v2/index.html`), Supabase-backed existing platform registration flows, Node-based static regression tests under `scripts/`, Vercel static deployment guard.

---

## File Structure

- Modify: `v2/index.html`
  - Add `state.platformBatchRegistration`.
  - Add pure batch helper functions near the existing platform preview helpers.
  - Route platform `register` actions with 2-3 selected targets into the new batch panel.
  - Render a batch panel in each platform tab.
  - Bind panel actions for start, open current modal, confirm success, record failure, retry failures, copy Wiki log, download Wiki log, and close.
- Create: `scripts/test-v2-platform-batch-registration.mjs`
  - Static contract checks for new UI hooks.
  - VM checks for pure helper behavior.
  - Regression checks that single-target registration still routes through the existing modal path.
- Existing verification commands:
  - `node scripts/test-v2-platform-batch-registration.mjs`
  - `node scripts/test-v2-platform-coverage.mjs`
  - `node scripts/test-v2-platform-master-sync.mjs`
  - `node scripts/test-v2-shopee-registration-platform-mapping.mjs`
  - `node scripts/test-v2-joom-registration-platform-mapping.mjs`
  - `node scripts/test-v2-qoo10-registration-platform-mapping.mjs`
  - `node scripts/test-v2-ebay-platform-listing-mapping.mjs`
  - `npm run verify:v2-deploy-source`

Do not create a backend batch endpoint in this implementation. The existing platform-specific modals stay the source of truth for dry-run, final confirmation, and platform submission.

---

### Task 1: Add The Failing Batch Registration Test

**Files:**
- Create: `scripts/test-v2-platform-batch-registration.mjs`

- [ ] **Step 1: Create the failing test file**

Add this complete file:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');

function sliceBetween(source, start, end) {
  const s = source.indexOf(start);
  assert.notEqual(s, -1, `missing start token: ${start}`);
  const e = source.indexOf(end, s);
  assert.ok(e > s, `missing end token after ${start}`);
  return source.slice(s, e);
}

for (const token of [
  'platformBatchRegistration: null',
  'function platformBatchSupportedPlatform',
  'function platformBatchSelectionMode',
  'function platformStartBatchRegistration',
  'function platformBatchRegistrationHtml',
  'function platformBatchOpenCurrent',
  'function platformBatchConfirmCurrentSuccess',
  'function platformBatchRecordCurrentFailure',
  'function platformBatchFailureLogMarkdown',
  'function platformBatchCopyFailureLog',
  'function platformBatchDownloadFailureLog',
  'data-platform-batch-start',
  'data-platform-batch-open-current',
  'data-platform-batch-confirm-success',
  'data-platform-batch-record-failure',
  'data-platform-batch-copy-log',
  'data-platform-batch-download-log',
]) {
  assert(html.includes(token), `missing batch registration token: ${token}`);
}

assert(
  html.includes('if (batchHtml)') && html.includes('${batchHtml}'),
  'platform workbench must render the batch registration panel',
);

const actionSource = sliceBetween(
  html,
  'async function platformOpenAction(platform, action, explicitKeys = null)',
  'function platformGroupProductIds(group)',
);

assert(
  actionSource.includes("const batchMode = platformBatchSelectionMode(platform, action, groups);"),
  'register action must evaluate batch selection mode',
);
assert(
  actionSource.includes("if (batchMode === 'too_many')"),
  'register action must block more than 3 selected targets',
);
assert(
  actionSource.includes("if (batchMode === 'batch')"),
  'register action must route 2-3 selected targets to the batch controller',
);
assert(
  actionSource.includes('await platformOpenExistingModal(platform, groups[0]);'),
  'single target registration must keep the existing modal path',
);

const helperSource = sliceBetween(
  html,
  'function platformBatchSupportedPlatform',
  'function platformStartBatchRegistration',
);

const context = {
  console,
};
vm.runInNewContext(`
${helperSource}
globalThis.supported = ['shopee', 'joom', 'qoo10', 'ebay'].map(platformBatchSupportedPlatform);
globalThis.unsupported = ['shopify', 'alibaba', 'unknown'].map(platformBatchSupportedPlatform);
globalThis.noneMode = platformBatchSelectionMode('shopee', 'register', []);
globalThis.singleMode = platformBatchSelectionMode('shopee', 'register', [{ key: 'A' }]);
globalThis.batchMode = platformBatchSelectionMode('shopee', 'register', [{ key: 'A' }, { key: 'B' }]);
globalThis.threeMode = platformBatchSelectionMode('ebay', 'register', [{ key: 'A' }, { key: 'B' }, { key: 'C' }]);
globalThis.tooManyMode = platformBatchSelectionMode('joom', 'register', [{ key: 'A' }, { key: 'B' }, { key: 'C' }, { key: 'D' }]);
globalThis.editMode = platformBatchSelectionMode('shopee', 'edit', [{ key: 'A' }, { key: 'B' }]);
globalThis.shopifyMode = platformBatchSelectionMode('shopify', 'register', [{ key: 'A' }, { key: 'B' }]);
`, context);

assert.deepEqual(context.supported, [true, true, true, true], 'Shopee/Joom/Qoo10/eBay must support v1 guided batch registration');
assert.deepEqual(context.unsupported, [false, false, false], 'Shopify/Alibaba/unknown must not use this v1 batch path');
assert.equal(context.noneMode, 'none');
assert.equal(context.singleMode, 'single');
assert.equal(context.batchMode, 'batch');
assert.equal(context.threeMode, 'batch');
assert.equal(context.tooManyMode, 'too_many');
assert.equal(context.editMode, 'single');
assert.equal(context.shopifyMode, 'single');

const logSource = sliceBetween(
  html,
  'function platformBatchFailureLogMarkdown',
  'async function platformBatchCopyFailureLog',
);

const logContext = {};
vm.runInNewContext(`
${logSource}
const batch = {
  id: 'batch-20260629-001',
  platform: 'shopee',
  createdAt: '2026-06-29T01:00:00.000Z',
  finishedAt: '2026-06-29T01:05:00.000Z',
  items: [
    { sku: 'SKU-A', title: 'Product A', status: 'succeeded', productIds: ['p1'], preflightErrors: [], preflightWarnings: [] },
    {
      sku: 'SKU-B',
      title: 'Product B',
      status: 'failed',
      key: 'key-b',
      productIds: ['p2'],
      productGroupId: 'g2',
      stage: 'publish',
      errorCode: 'PLATFORM_VALIDATION_ERROR',
      errorMsg: 'price is missing',
      preflightErrors: ['cost_krw is missing'],
      preflightWarnings: ['image is small'],
      platformItemId: '',
      platformListingId: '',
      retryable: true,
    },
  ],
};
globalThis.log = platformBatchFailureLogMarkdown(batch);
`, logContext);

assert(logContext.log.includes('# SD Platform Batch Registration Failures - 2026-06-29'), 'failure log must include dated title');
assert(logContext.log.includes('- Platform: shopee'), 'failure log must include platform');
assert(logContext.log.includes('- Batch ID: batch-20260629-001'), 'failure log must include batch id');
assert(logContext.log.includes('- Succeeded: 1'), 'failure log must count successes');
assert(logContext.log.includes('- Failed: 1'), 'failure log must count failures');
assert(logContext.log.includes('### SKU-B / Product B'), 'failure log must include failed SKU title');
assert(logContext.log.includes('- stage: publish'), 'failure log must include failure stage');
assert(logContext.log.includes('- error_code: PLATFORM_VALIDATION_ERROR'), 'failure log must include error code');
assert(logContext.log.includes('- error_msg: price is missing'), 'failure log must include error message');
assert(!logContext.log.includes('SKU-A / Product A\\n\\n- master_product_id'), 'success items must not appear in Failed Items');

console.log('v2 platform batch registration checks passed');
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
node scripts/test-v2-platform-batch-registration.mjs
```

Expected: failure containing `missing batch registration token: platformBatchRegistration: null`.

- [ ] **Step 3: Commit the failing test**

```powershell
git add scripts/test-v2-platform-batch-registration.mjs
git commit -m "test: cover platform batch registration"
```

Expected: commit succeeds with only the new test file staged.

---

### Task 2: Add Batch State And Pure Helpers

**Files:**
- Modify: `v2/index.html`
- Test: `scripts/test-v2-platform-batch-registration.mjs`

- [ ] **Step 1: Add state**

In the `const state = { ... }` block near `platformPreview: null`, add:

```js
    platformBatchRegistration: null,
```

Keep it near the existing platform UI state:

```js
    platformFilters: {},
    platformPreview: null,
    platformBatchRegistration: null,
    platformMasterSyncDialog: null,
```

- [ ] **Step 2: Add pure batch helper functions**

Insert this block after `function platformActionGroups(platform, explicitKeys = null) { ... }` and before `function openShopeeNameSyncPanel()`:

```js
  function platformBatchSupportedPlatform(platform) {
    return ['shopee', 'joom', 'qoo10', 'ebay'].includes(String(platform || '').toLowerCase());
  }

  function platformBatchSelectionMode(platform, action, groups = []) {
    if (action !== 'register') return 'single';
    if (!platformBatchSupportedPlatform(platform)) return 'single';
    const count = Array.isArray(groups) ? groups.length : 0;
    if (count <= 0) return 'none';
    if (count === 1) return 'single';
    if (count <= 3) return 'batch';
    return 'too_many';
  }

  function platformBatchStatusFromValidation(validation = {}) {
    return Array.isArray(validation.errors) && validation.errors.length ? 'preflight_failed' : 'ready';
  }

  function platformBatchIsoDate(value) {
    const date = value ? new Date(value) : new Date();
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  }

  function platformBatchMarkdownValue(value) {
    const textValue = String(value == null || value === '' ? '-' : value);
    return textValue.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim() || '-';
  }

  function platformBatchMarkdownArray(values) {
    const arr = Array.isArray(values) ? values : [];
    return arr.length ? arr.map(platformBatchMarkdownValue).join('; ') : '-';
  }

  function platformBatchFailureItems(batch = {}) {
    return (Array.isArray(batch.items) ? batch.items : []).filter((item) => (
      item && ['failed', 'preflight_failed'].includes(String(item.status || ''))
    ));
  }

  function platformBatchFailureLogMarkdown(batch = {}) {
    const items = Array.isArray(batch.items) ? batch.items : [];
    const failed = platformBatchFailureItems(batch);
    const succeeded = items.filter((item) => item?.status === 'succeeded').length;
    const skipped = items.filter((item) => item?.status === 'skipped').length;
    const date = platformBatchIsoDate(batch.finishedAt || batch.createdAt);
    const lines = [
      `# SD Platform Batch Registration Failures - ${date}`,
      '',
      `- Platform: ${platformBatchMarkdownValue(batch.platform)}`,
      `- Batch ID: ${platformBatchMarkdownValue(batch.id)}`,
      `- Operator: ${platformBatchMarkdownValue(batch.operator || 'dashboard-user')}`,
      `- Started: ${platformBatchMarkdownValue(batch.createdAt)}`,
      `- Finished: ${platformBatchMarkdownValue(batch.finishedAt)}`,
      '',
      '## Summary',
      '',
      `- Selected: ${items.length}`,
      `- Succeeded: ${succeeded}`,
      `- Failed: ${failed.length}`,
      `- Skipped: ${skipped}`,
      '',
      '## Failed Items',
      '',
    ];
    if (!failed.length) {
      lines.push('- No failed items.');
      return lines.join('\n');
    }
    failed.forEach((item) => {
      lines.push(`### ${platformBatchMarkdownValue(item.sku)} / ${platformBatchMarkdownValue(item.title)}`);
      lines.push('');
      lines.push(`- master_product_id: ${platformBatchMarkdownArray(item.productIds)}`);
      lines.push(`- product_group_id: ${platformBatchMarkdownValue(item.productGroupId)}`);
      lines.push(`- platform: ${platformBatchMarkdownValue(batch.platform)}`);
      lines.push('- action: register');
      lines.push(`- stage: ${platformBatchMarkdownValue(item.stage || (item.status === 'preflight_failed' ? 'preflight' : 'unknown'))}`);
      lines.push(`- error_code: ${platformBatchMarkdownValue(item.errorCode)}`);
      lines.push(`- error_msg: ${platformBatchMarkdownValue(item.errorMsg)}`);
      lines.push(`- preflight_errors: ${platformBatchMarkdownArray(item.preflightErrors)}`);
      lines.push(`- preflight_warnings: ${platformBatchMarkdownArray(item.preflightWarnings)}`);
      lines.push(`- platform_item_id: ${platformBatchMarkdownValue(item.platformItemId)}`);
      lines.push(`- platform_listing_id: ${platformBatchMarkdownValue(item.platformListingId)}`);
      lines.push(`- retry_status: ${item.retryable === false ? 'blocked' : 'pending'}`);
      lines.push(`- follow_up_needed: ${item.status === 'succeeded' ? 'no' : 'yes'}`);
      lines.push('');
    });
    return lines.join('\n').trimEnd();
  }
```

- [ ] **Step 3: Run the new test and verify the next failure**

Run:

```powershell
node scripts/test-v2-platform-batch-registration.mjs
```

Expected: failure moves from missing pure helper tokens to missing UI/controller tokens such as `function platformStartBatchRegistration`.

- [ ] **Step 4: Commit state and pure helpers**

```powershell
git add v2/index.html
git commit -m "feat: add platform batch registration helpers"
```

---

### Task 3: Route 2-3 Register Targets Into Batch Mode

**Files:**
- Modify: `v2/index.html`
- Test: `scripts/test-v2-platform-batch-registration.mjs`

- [ ] **Step 1: Add batch item builders**

Insert after the pure helpers from Task 2 and before `function platformStartBatchRegistration`:

```js
  function platformBatchBuildItem(platform, group) {
    const validation = platformGroupValidation(platform, 'register', group);
    const first = group?.rows?.[0] || {};
    const key = platformGroupKey(group);
    return {
      key,
      productIds: platformGroupProductIds(group),
      productGroupId: first.product_group_id || (group?.isGrouped ? key : ''),
      sku: platformGroupSku(group) || first.sku || key,
      title: platformGroupTitle(group) || first.product_name || '',
      status: platformBatchStatusFromValidation(validation),
      preflightErrors: (validation.errors || []).slice(),
      preflightWarnings: (validation.warnings || []).slice(),
      startedAt: null,
      finishedAt: null,
      platformItemId: null,
      platformListingId: null,
      stage: validation.errors?.length ? 'preflight' : '',
      errorCode: validation.errors?.length ? 'PREFLIGHT_FAILED' : null,
      errorMsg: validation.errors?.[0] || null,
      retryable: !validation.errors?.length,
    };
  }

  function platformBatchGroups(batch) {
    return batch ? platformGroupsByKeys(batch.keys || []) : [];
  }

  function platformBatchItem(batch, key) {
    return (batch?.items || []).find((item) => String(item.key) === String(key)) || null;
  }

  function platformBatchCurrentItem(batch) {
    if (!batch) return null;
    if (batch.currentKey) return platformBatchItem(batch, batch.currentKey);
    return (batch.items || []).find((item) => item.status === 'running')
      || (batch.items || []).find((item) => item.status === 'ready')
      || null;
  }

  function platformBatchNextReadyItem(batch) {
    return (batch?.items || []).find((item) => item.status === 'ready') || null;
  }
```

- [ ] **Step 2: Add the batch starter**

Insert after the builders:

```js
  function platformStartBatchRegistration(platform, groups = []) {
    const normalizedGroups = (groups || []).filter(Boolean).slice(0, 3);
    const now = new Date().toISOString();
    const batch = {
      id: `batch-${now.replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 7)}`,
      platform,
      keys: normalizedGroups.map(platformGroupKey),
      createdAt: now,
      finishedAt: null,
      running: false,
      currentKey: null,
      operator: (window.SD_CURRENT_USER_EMAIL || '').trim() || 'dashboard-user',
      items: normalizedGroups.map((group) => platformBatchBuildItem(platform, group)),
    };
    state.platformPreview = null;
    state.platformMasterSyncDialog = null;
    state.platformBatchRegistration = batch;
    renderPlatformWorkbench(platform);
    document.getElementById(`platform-${platform}-root`)?.querySelector('.platform-batch-panel')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
```

- [ ] **Step 3: Change `platformOpenAction` register routing**

In `async function platformOpenAction(platform, action, explicitKeys = null)`, inside `if (action === 'register')`, replace the current multi-group branch:

```js
      if (groups.length > 1) {
        platformOpenPreview(platform, action, explicitKeys);
        showToast(`${PLATFORM_LABELS[platform] || platform} 등록 대상이 여러 개입니다. 선택 확인 후 1개씩 실행하세요.`, 'ok');
        return;
      }
```

with:

```js
      const batchMode = platformBatchSelectionMode(platform, action, groups);
      if (batchMode === 'too_many') {
        showToast('현재 일괄 등록은 최대 3개까지 지원합니다. 2~3개만 선택하세요.', 'err');
        return;
      }
      if (batchMode === 'batch') {
        platformStartBatchRegistration(platform, groups);
        return;
      }
```

Keep the existing single-target path below it:

```js
      try {
        state.platformPreview = null;
        renderPlatformWorkbench(platform);
        await platformOpenExistingModal(platform, groups[0]);
      } catch (e) {
        console.error('[platformOpenAction] platform modal open failed:', e);
        showToast(`${PLATFORM_LABELS[platform] || platform} 등록 모달 열기 실패: ${e.message || e}`, 'err');
      }
```

- [ ] **Step 4: Run the batch test**

Run:

```powershell
node scripts/test-v2-platform-batch-registration.mjs
```

Expected: failure moves to missing render/controller tokens such as `function platformBatchRegistrationHtml`.

- [ ] **Step 5: Run a single-target regression test**

Run:

```powershell
node scripts/test-v2-platform-coverage.mjs
```

Expected: `v2 platform coverage checks passed`.

- [ ] **Step 6: Commit routing**

```powershell
git add v2/index.html
git commit -m "feat: route multi-select platform registration"
```

---

### Task 4: Render The Guided Batch Panel

**Files:**
- Modify: `v2/index.html`
- Test: `scripts/test-v2-platform-batch-registration.mjs`

- [ ] **Step 1: Add batch panel CSS**

Add near the existing `.platform-preview` CSS rules:

```css
    .platform-batch-panel {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #fff;
      margin: 12px 0;
      overflow: hidden;
    }
    .platform-batch-status {
      display: inline-flex;
      align-items: center;
      height: 22px;
      border-radius: 999px;
      padding: 0 8px;
      font-size: 11px;
      font-weight: 800;
      background: #f1f5f9;
      color: #475569;
      white-space: nowrap;
    }
    .platform-batch-status.ready,
    .platform-batch-status.succeeded {
      background: #dcfce7;
      color: #166534;
    }
    .platform-batch-status.running {
      background: #dbeafe;
      color: #1d4ed8;
    }
    .platform-batch-status.failed,
    .platform-batch-status.preflight_failed {
      background: #fee2e2;
      color: #991b1b;
    }
    .platform-batch-log {
      width: 100%;
      min-height: 180px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      line-height: 1.45;
      white-space: pre;
    }
```

- [ ] **Step 2: Add HTML render helpers**

Insert after `function platformPreviewHtml()` or directly before it:

```js
  function platformBatchCounts(batch) {
    const items = batch?.items || [];
    return {
      total: items.length,
      ready: items.filter((item) => item.status === 'ready').length,
      running: items.filter((item) => item.status === 'running').length,
      succeeded: items.filter((item) => item.status === 'succeeded').length,
      failed: items.filter((item) => item.status === 'failed' || item.status === 'preflight_failed').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
    };
  }

  function platformBatchStatusLabel(status) {
    return ({
      pending: '대기',
      ready: '준비됨',
      preflight_failed: '사전검증 실패',
      running: '진행 중',
      succeeded: '성공',
      failed: '실패',
      skipped: '건너뜀',
    })[status] || status || '대기';
  }

  function platformBatchRegistrationHtml() {
    const batch = state.platformBatchRegistration;
    if (!batch) return '';
    const platform = batch.platform;
    const label = PLATFORM_LABELS[platform] || platform;
    const counts = platformBatchCounts(batch);
    const current = platformBatchCurrentItem(batch);
    const failedLog = platformBatchFailureLogMarkdown(batch);
    const hasFailures = platformBatchFailureItems(batch).length > 0;
    const rows = (batch.items || []).map((item) => {
      const messages = [
        ...(item.preflightErrors || []),
        item.errorMsg || '',
        ...(item.preflightWarnings || []).map((msg) => `주의: ${msg}`),
      ].filter(Boolean).map(text).join('<br>');
      return `<tr>
        <td class="mono">${text(item.sku || '-')}</td>
        <td style="overflow-wrap:anywhere;">${text(item.title || '-')}</td>
        <td><span class="platform-batch-status ${text(item.status)}">${text(platformBatchStatusLabel(item.status))}</span></td>
        <td>${messages || '<span class="muted">-</span>'}</td>
      </tr>`;
    }).join('');
    const currentHtml = current
      ? `<div class="notice" style="margin-top:10px;">
          <strong>현재 대상</strong> ${text(current.sku || '-')} · ${text(current.title || '-')}
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <button type="button" data-platform-batch-open-current ${batch.running ? '' : 'disabled'}>현재 등록 모달 열기</button>
            <button type="button" class="primary" data-platform-batch-confirm-success ${batch.running ? '' : 'disabled'}>등록 완료 확인</button>
            <input type="text" data-platform-batch-failure-note placeholder="실패 사유 또는 셀러센터 확인 메모" style="min-width:260px;flex:1;font-size:12px;padding:6px 8px;">
            <button type="button" class="platform-danger-action" data-platform-batch-record-failure ${batch.running ? '' : 'disabled'}>실패로 기록</button>
          </div>
        </div>`
      : '';
    const failureLogHtml = hasFailures
      ? `<details open style="margin-top:10px;">
          <summary style="font-weight:800;">Wiki 실패 로그</summary>
          <textarea class="platform-batch-log" readonly>${text(failedLog)}</textarea>
          <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
            <button type="button" data-platform-batch-copy-log>Copy Wiki Log</button>
            <button type="button" data-platform-batch-download-log>Download .md</button>
          </div>
        </details>`
      : '';
    return `<div class="platform-batch-panel">
      <div class="platform-preview-head">
        <div>
          <strong>${text(label)} 다중 선택 등록</strong>
          <div class="muted" style="font-size:12px;margin-top:3px;">
            선택 ${counts.total}개 · 성공 ${counts.succeeded} · 실패 ${counts.failed} · 준비 ${counts.ready}
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <button type="button" data-platform-batch-retry-failures ${counts.failed ? '' : 'disabled'}>실패만 재시도</button>
          <button type="button" class="primary" data-platform-batch-start ${batch.running || !counts.ready ? 'disabled' : ''}>시작</button>
          <button type="button" data-platform-batch-close ${batch.running ? 'disabled' : ''}>닫기</button>
        </div>
      </div>
      <div class="platform-preview-body">
        <div class="notice" style="margin-bottom:10px;">
          기존 단일 등록 모달을 상품별로 순서대로 엽니다. 각 상품은 플랫폼에 독립 listing으로 등록됩니다.
        </div>
        <div class="panel table-scroll">
          <table style="min-width:860px;table-layout:auto;">
            <colgroup><col style="width:180px;"><col><col style="width:130px;"><col></colgroup>
            <thead><tr><th>SKU</th><th>상품명</th><th>상태</th><th>메시지</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="4" class="empty">대상이 없습니다.</td></tr>'}</tbody>
          </table>
        </div>
        ${currentHtml}
        ${failureLogHtml}
      </div>
    </div>`;
  }
```

- [ ] **Step 3: Render the panel in `renderPlatformWorkbench`**

In `function renderPlatformWorkbench(platform)`, after `previewHtml` is created, add:

```js
    const batchHtml = state.platformBatchRegistration?.platform === platform ? platformBatchRegistrationHtml() : '';
```

In the returned HTML, place `${batchHtml}` before `${previewHtml}` so batch state is visible above the legacy preview:

```js
          ${batchHtml}
          ${previewHtml}
```

- [ ] **Step 4: Run test**

Run:

```powershell
node scripts/test-v2-platform-batch-registration.mjs
```

Expected: failure moves to missing action functions or event binding tokens.

- [ ] **Step 5: Commit rendering**

```powershell
git add v2/index.html
git commit -m "feat: render platform batch registration panel"
```

---

### Task 5: Add Batch Panel Actions And Event Binding

**Files:**
- Modify: `v2/index.html`
- Test: `scripts/test-v2-platform-batch-registration.mjs`

- [ ] **Step 1: Add controller actions**

Insert after `platformBatchRegistrationHtml()`:

```js
  function platformBatchSetItem(batch, key, patch) {
    const item = platformBatchItem(batch, key);
    if (!item) return null;
    Object.assign(item, patch || {});
    return item;
  }

  function platformBatchMoveToNextReady(batch) {
    const next = platformBatchNextReadyItem(batch);
    batch.currentKey = next ? next.key : null;
    if (!next) {
      batch.running = false;
      batch.finishedAt = new Date().toISOString();
    }
    return next;
  }

  async function platformBatchOpenCurrent() {
    const batch = state.platformBatchRegistration;
    const current = platformBatchCurrentItem(batch);
    if (!batch || !current) return;
    const group = platformGroupsByKeys([current.key])[0];
    if (!group) {
      platformBatchSetItem(batch, current.key, {
        status: 'failed',
        stage: 'modal_open',
        errorCode: 'TARGET_NOT_FOUND',
        errorMsg: '선택한 마스터 상품을 현재 목록에서 찾지 못했습니다.',
        finishedAt: new Date().toISOString(),
        retryable: true,
      });
      renderPlatformWorkbench(batch.platform);
      return;
    }
    platformBatchSetItem(batch, current.key, {
      status: 'running',
      stage: 'modal_open',
      startedAt: current.startedAt || new Date().toISOString(),
      errorCode: null,
      errorMsg: null,
    });
    batch.currentKey = current.key;
    renderPlatformWorkbench(batch.platform);
    try {
      await platformOpenExistingModal(batch.platform, group);
    } catch (e) {
      platformBatchSetItem(batch, current.key, {
        status: 'failed',
        stage: 'modal_open',
        errorCode: 'MODAL_OPEN_FAILED',
        errorMsg: e?.message || String(e),
        finishedAt: new Date().toISOString(),
        retryable: true,
      });
      renderPlatformWorkbench(batch.platform);
    }
  }

  async function platformBatchBegin() {
    const batch = state.platformBatchRegistration;
    if (!batch || batch.running) return;
    const next = platformBatchNextReadyItem(batch);
    if (!next) {
      showToast('등록 가능한 대상이 없습니다. 실패 항목을 수정한 뒤 다시 시도하세요.', 'warn');
      return;
    }
    batch.running = true;
    batch.currentKey = next.key;
    await platformBatchOpenCurrent();
  }

  function platformBatchStatusLooksPublished(status) {
    return ['listed', 'pending', 'partial', 'partial_published', 'published', 'draft'].includes(String(status || '').toLowerCase());
  }

  async function platformBatchConfirmCurrentSuccess() {
    const batch = state.platformBatchRegistration;
    const current = platformBatchCurrentItem(batch);
    if (!batch || !current) return;
    try { await refreshPlatformLedSources(); } catch (_) {}
    const group = platformGroupsByKeys([current.key])[0];
    const nextStatus = group ? platformStatusForGroup(group, batch.platform) : null;
    const ok = platformBatchStatusLooksPublished(nextStatus?.status || nextStatus);
    platformBatchSetItem(batch, current.key, {
      status: ok ? 'succeeded' : 'failed',
      stage: ok ? 'mapping' : 'publish',
      errorCode: ok ? null : 'LISTING_NOT_CONFIRMED',
      errorMsg: ok ? null : '등록 완료 후 플랫폼 매핑 상태가 아직 확인되지 않았습니다.',
      finishedAt: new Date().toISOString(),
      retryable: !ok,
    });
    state.platformLastResults[`${batch.platform}:${current.key}`] = {
      ok,
      message: ok ? '일괄 등록 확인 완료' : '등록 확인 실패',
    };
    const next = platformBatchMoveToNextReady(batch);
    renderPlatformWorkbench(batch.platform);
    if (next) await platformBatchOpenCurrent();
  }

  function platformBatchRecordCurrentFailure() {
    const batch = state.platformBatchRegistration;
    const current = platformBatchCurrentItem(batch);
    if (!batch || !current) return;
    const root = document.getElementById(`platform-${batch.platform}-root`);
    const note = String(root?.querySelector('[data-platform-batch-failure-note]')?.value || '').trim();
    platformBatchSetItem(batch, current.key, {
      status: 'failed',
      stage: 'publish',
      errorCode: 'OPERATOR_RECORDED_FAILURE',
      errorMsg: note || '운영자가 실패로 기록했습니다.',
      finishedAt: new Date().toISOString(),
      retryable: true,
    });
    state.platformLastResults[`${batch.platform}:${current.key}`] = {
      ok: false,
      message: note || '운영자가 실패로 기록했습니다.',
    };
    const next = platformBatchMoveToNextReady(batch);
    renderPlatformWorkbench(batch.platform);
    if (next) void platformBatchOpenCurrent();
  }

  function platformBatchRetryFailures() {
    const batch = state.platformBatchRegistration;
    if (!batch || batch.running) return;
    (batch.items || []).forEach((item) => {
      if (!['failed', 'preflight_failed', 'skipped'].includes(item.status)) return;
      if (item.retryable === false) return;
      item.status = item.preflightErrors?.length ? 'preflight_failed' : 'ready';
      item.stage = item.preflightErrors?.length ? 'preflight' : '';
      item.errorCode = item.preflightErrors?.length ? 'PREFLIGHT_FAILED' : null;
      item.errorMsg = item.preflightErrors?.[0] || null;
      item.startedAt = null;
      item.finishedAt = null;
    });
    batch.finishedAt = null;
    renderPlatformWorkbench(batch.platform);
  }

  function platformBatchClose() {
    const batch = state.platformBatchRegistration;
    if (batch?.running) return;
    state.platformBatchRegistration = null;
    if (batch?.platform) renderPlatformWorkbench(batch.platform);
  }
```

- [ ] **Step 2: Add event binding**

In `function bindPlatformWorkbench(root, platform)`, after the existing `data-platform-preview-execute` binding, add:

```js
    root.querySelector('[data-platform-batch-start]')?.addEventListener('click', () => platformBatchBegin());
    root.querySelector('[data-platform-batch-open-current]')?.addEventListener('click', () => platformBatchOpenCurrent());
    root.querySelector('[data-platform-batch-confirm-success]')?.addEventListener('click', () => platformBatchConfirmCurrentSuccess());
    root.querySelector('[data-platform-batch-record-failure]')?.addEventListener('click', () => platformBatchRecordCurrentFailure());
    root.querySelector('[data-platform-batch-retry-failures]')?.addEventListener('click', () => platformBatchRetryFailures());
    root.querySelector('[data-platform-batch-close]')?.addEventListener('click', () => platformBatchClose());
    root.querySelector('[data-platform-batch-copy-log]')?.addEventListener('click', () => platformBatchCopyFailureLog());
    root.querySelector('[data-platform-batch-download-log]')?.addEventListener('click', () => platformBatchDownloadFailureLog());
```

- [ ] **Step 3: Run the batch test**

Run:

```powershell
node scripts/test-v2-platform-batch-registration.mjs
```

Expected: failure moves to missing `platformBatchCopyFailureLog` or download function.

- [ ] **Step 4: Commit controller actions**

```powershell
git add v2/index.html
git commit -m "feat: control platform batch registration"
```

---

### Task 6: Add Wiki Log Copy And Download

**Files:**
- Modify: `v2/index.html`
- Test: `scripts/test-v2-platform-batch-registration.mjs`

- [ ] **Step 1: Add copy/download helpers**

Insert after `platformBatchClose()`:

```js
  async function platformBatchCopyFailureLog() {
    const batch = state.platformBatchRegistration;
    if (!batch) return;
    const markdown = platformBatchFailureLogMarkdown(batch);
    try {
      await navigator.clipboard.writeText(markdown);
      showToast('Wiki 실패 로그를 클립보드에 복사했습니다.', 'ok');
    } catch (e) {
      console.warn('[platformBatchCopyFailureLog] clipboard failed:', e);
      showToast('클립보드 복사에 실패했습니다. 텍스트 영역에서 직접 복사하세요.', 'warn');
    }
  }

  function platformBatchDownloadFailureLog() {
    const batch = state.platformBatchRegistration;
    if (!batch) return;
    const markdown = platformBatchFailureLogMarkdown(batch);
    const date = platformBatchIsoDate(batch.finishedAt || batch.createdAt);
    const filename = `SD Platform Batch Registration Failures - ${date}.md`;
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
```

- [ ] **Step 2: Run the new batch test**

Run:

```powershell
node scripts/test-v2-platform-batch-registration.mjs
```

Expected: `v2 platform batch registration checks passed`.

- [ ] **Step 3: Run related platform tests**

Run:

```powershell
node scripts/test-v2-platform-coverage.mjs
node scripts/test-v2-platform-master-sync.mjs
node scripts/test-v2-shopee-registration-platform-mapping.mjs
node scripts/test-v2-joom-registration-platform-mapping.mjs
node scripts/test-v2-qoo10-registration-platform-mapping.mjs
node scripts/test-v2-ebay-platform-listing-mapping.mjs
```

Expected:

```text
v2 platform coverage checks passed
v2 platform master sync checks passed
v2 Shopee registration platform mapping checks passed
v2 Joom registration platform mapping checks passed
v2 Qoo10 registration platform mapping checks passed
v2 eBay platform listing mapping checks passed
```

If a script has a different existing success line, record the exact line in the task notes and continue only when exit code is `0`.

- [ ] **Step 4: Commit Wiki log actions**

```powershell
git add v2/index.html
git commit -m "feat: add platform batch failure logs"
```

---

### Task 7: Polish Guardrails And Existing Preview Interactions

**Files:**
- Modify: `v2/index.html`
- Test: `scripts/test-v2-platform-batch-registration.mjs`

- [ ] **Step 1: Clear batch panel when manual selection is cleared**

In the `data-platform-clear-selection` handler, after clearing `state.platformPreview`, add:

```js
      if (state.platformBatchRegistration?.platform === platform) state.platformBatchRegistration = null;
```

Full target block should contain:

```js
    root.querySelector('[data-platform-clear-selection]')?.addEventListener('click', () => {
      platformMarkSelectionManual(platform);
      platformSelection(platform).clear();
      if (state.platformPreview?.platform === platform) state.platformPreview = null;
      if (state.platformBatchRegistration?.platform === platform) state.platformBatchRegistration = null;
      renderPlatformWorkbench(platform);
    });
```

- [ ] **Step 2: Keep batch panel out of non-register actions**

At the start of `platformOpenPreview(platform, action, explicitKeys = null)`, before assigning `state.platformPreview`, add:

```js
    if (action !== 'register' && state.platformBatchRegistration?.platform === platform) {
      state.platformBatchRegistration = null;
    }
```

- [ ] **Step 3: Block Alibaba/Shopify from guided batch path**

The helper from Task 2 already returns `false` for Alibaba and Shopify. Add a static string near `platformBatchSupportedPlatform` for future readers:

```js
  // V1 guided batch is limited to platforms whose registration still needs the
  // proven operator confirmation modal. Shopify keeps its dispatcher path.
```

- [ ] **Step 4: Add test tokens for cleanup behavior**

Update `scripts/test-v2-platform-batch-registration.mjs` required tokens with:

```js
  'state.platformBatchRegistration = null',
  "action !== 'register' && state.platformBatchRegistration?.platform === platform",
  'Shopify keeps its dispatcher path',
```

- [ ] **Step 5: Run tests**

Run:

```powershell
node scripts/test-v2-platform-batch-registration.mjs
node scripts/test-v2-platform-coverage.mjs
```

Expected:

```text
v2 platform batch registration checks passed
v2 platform coverage checks passed
```

- [ ] **Step 6: Commit guardrails**

```powershell
git add v2/index.html scripts/test-v2-platform-batch-registration.mjs
git commit -m "fix: guard platform batch registration state"
```

---

### Task 8: Final Verification, Local Render Check, Commit Hygiene, Deploy

**Files:**
- Verify only unless failures require a scoped fix.

- [ ] **Step 1: Run full focused validation**

Run:

```powershell
node scripts/test-v2-platform-batch-registration.mjs
node scripts/test-v2-platform-coverage.mjs
node scripts/test-v2-platform-master-sync.mjs
node scripts/test-v2-shopee-registration-platform-mapping.mjs
node scripts/test-v2-joom-registration-platform-mapping.mjs
node scripts/test-v2-qoo10-registration-platform-mapping.mjs
node scripts/test-v2-ebay-platform-listing-mapping.mjs
npm run verify:v2-deploy-source
git diff --check
```

Expected:

- every `node` command exits `0`
- `npm run verify:v2-deploy-source` prints `V2 deployment guard passed`
- `git diff --check` exits `0`

- [ ] **Step 2: Review local rendered app**

Run a local static server from `C:\dev\shopee-dashboard`:

```powershell
$port=4173
$existing = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
if (-not $existing) {
  Start-Process -FilePath python -ArgumentList '-m','http.server',"$port",'--bind','127.0.0.1' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 2
}
Invoke-WebRequest -Uri "http://127.0.0.1:$port/v2/" -UseBasicParsing -TimeoutSec 10
```

Expected: HTTP `200`.

Then open `http://127.0.0.1:4173/v2/` in the browser and verify:

- platform tabs render
- selecting 2-3 items in Shopee/Joom/Qoo10/eBay and clicking `등록` shows the batch panel
- selecting 1 item still opens the existing platform registration modal
- selecting 4 items shows the max-3 guardrail
- failure log textarea appears after recording a failed item
- Copy and Download buttons are visible when failures exist

- [ ] **Step 3: Commit any final scoped fixes**

If Step 1 or Step 2 required fixes:

```powershell
git add v2/index.html scripts/test-v2-platform-batch-registration.mjs
git commit -m "fix: stabilize platform batch registration"
```

If no fixes were needed, skip this commit.

- [ ] **Step 4: Push**

Run:

```powershell
git status --short
git push origin main
```

Expected before push: only pre-existing unrelated local changes remain, or the tree is clean.

- [ ] **Step 5: Deploy production**

Run from `C:\dev\shopee-dashboard`:

```powershell
vercel deploy --prod --yes --scope moon-jeonghos-projects
```

Expected:

- deployment status `READY`
- production alias includes `https://shopee-dashboard-kohl.vercel.app`

- [ ] **Step 6: Live smoke check**

Run:

```powershell
$res = Invoke-WebRequest -Uri 'https://shopee-dashboard-kohl.vercel.app/v2/' -UseBasicParsing -TimeoutSec 20
"HTTP $($res.StatusCode)"
@(
  'platformBatchRegistration',
  'platformBatchFailureLogMarkdown',
  'data-platform-batch-start'
) | ForEach-Object {
  if ($res.Content.Contains($_)) { "FOUND $_" } else { throw "MISSING $_" }
}
```

Expected:

```text
HTTP 200
FOUND platformBatchRegistration
FOUND platformBatchFailureLogMarkdown
FOUND data-platform-batch-start
```

---

## Self-Review Checklist

- Spec coverage:
  - 2-3 selected targets in one platform tab: Tasks 3-5.
  - Independent listings, no option merge: Tasks 3-5 reuse existing per-target modals.
  - No multi-platform simultaneous publish: Task 2 helper and Task 7 guardrail.
  - Per-product preflight/status/results: Tasks 3-5.
  - Failed-only retry: Task 5.
  - Wiki-ready failure log: Task 6.
  - Copy and `.md` download: Task 6.
- Placeholder scan:
  - No unresolved placeholder strings.
  - No implementation steps without exact file paths and commands.
  - Code snippets define every new function referenced by tests.
- Type/name consistency:
  - State key is always `platformBatchRegistration`.
  - Supported platform helper is always `platformBatchSupportedPlatform`.
  - Failure log function is always `platformBatchFailureLogMarkdown`.
  - Controller actions use the `data-platform-batch-*` attributes listed in the test.
