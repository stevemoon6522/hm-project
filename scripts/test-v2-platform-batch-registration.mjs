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
  'state.platformBatchRegistration = null',
  "action !== 'register' && state.platformBatchRegistration?.platform === platform",
  'Shopify keeps its dispatcher path',
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

assert.deepEqual(Array.from(context.supported), [true, true, true, true], 'Shopee/Joom/Qoo10/eBay must support v1 guided batch registration');
assert.deepEqual(Array.from(context.unsupported), [false, false, false], 'Shopify/Alibaba/unknown must not use this v1 batch path');
assert.equal(context.noneMode, 'none');
assert.equal(context.singleMode, 'single');
assert.equal(context.batchMode, 'batch');
assert.equal(context.threeMode, 'batch');
assert.equal(context.tooManyMode, 'too_many');
assert.equal(context.editMode, 'single');
assert.equal(context.shopifyMode, 'single');

const controllerSource = sliceBetween(
  html,
  'function platformBatchSetItem',
  'function platformPreviewHtml',
);

const retryContext = {
  state: {
    platformBatchRegistration: {
      platform: 'shopee',
      running: false,
      currentKey: null,
      finishedAt: '2026-06-29T01:05:00.000Z',
      items: [
        {
          key: 'fixed-preflight',
          sku: 'SKU-FIXED',
          status: 'preflight_failed',
          retryable: false,
          preflightErrors: ['old missing cost'],
          preflightWarnings: [],
          errorCode: 'PREFLIGHT_FAILED',
          errorMsg: 'old missing cost',
        },
        {
          key: 'still-blocked',
          sku: 'SKU-BLOCKED',
          status: 'preflight_failed',
          retryable: false,
          preflightErrors: ['old missing weight'],
          preflightWarnings: [],
          errorCode: 'PREFLIGHT_FAILED',
          errorMsg: 'old missing weight',
        },
      ],
    },
  },
};
vm.runInNewContext(`
function platformBatchItem(batch, key) {
  return (batch?.items || []).find((item) => String(item.key) === String(key)) || null;
}
function platformBatchNextReadyItem(batch) {
  return (batch?.items || []).find((item) => item.status === 'ready') || null;
}
function platformGroupsByKeys(keys) {
  return (keys || []).map((key) => ({ key, rows: [{ id: key }] }));
}
function platformGroupValidation(platform, action, group) {
  if (group.key === 'still-blocked') {
    return { errors: ['new missing weight'], warnings: ['still missing data'] };
  }
  return { errors: [], warnings: ['rechecked ok'] };
}
function renderPlatformWorkbench(platform) { globalThis.renderedPlatform = platform; }
function showToast(message, kind) { globalThis.toast = { message, kind }; }
${controllerSource}
platformBatchRetryFailures();
globalThis.fixedItem = state.platformBatchRegistration.items[0];
globalThis.blockedItem = state.platformBatchRegistration.items[1];
globalThis.batchFinishedAt = state.platformBatchRegistration.finishedAt;
`, retryContext);

assert.equal(retryContext.fixedItem.status, 'ready', 'fixed preflight failures must become ready after retry revalidation');
assert.equal(retryContext.fixedItem.retryable, true, 'fixed preflight retry should remain retryable');
assert.deepEqual(Array.from(retryContext.fixedItem.preflightErrors), [], 'fixed preflight retry must clear old errors');
assert.equal(retryContext.blockedItem.status, 'preflight_failed', 'still-invalid preflight failures must stay blocked');
assert.equal(retryContext.blockedItem.retryable, true, 'preflight failures must remain recheckable after failed retry');
assert.deepEqual(Array.from(retryContext.blockedItem.preflightErrors), ['new missing weight'], 'preflight retry must refresh validation errors');
assert.equal(retryContext.batchFinishedAt, null, 'retry should reopen the batch for ready items');

const logSource = sliceBetween(
  html,
  'function platformBatchIsoDate',
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
