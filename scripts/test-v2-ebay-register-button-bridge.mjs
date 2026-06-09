import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression guard for the product-list eBay register button.
//
// Bug history: openRegisterEbayGroupModal lives in the outer script scope while
// mrOpenEbayModal is defined inside the master-register IIFE. The outer opener
// called the modal with a bare `mrOpenEbayModal(...)` reference, which raised a
// ReferenceError before the confirmation modal could open — so the product-list
// eBay button silently did nothing. Joom had already been fixed the same way
// (window bridge + window call) and is guarded by test-v2-joom-register-images-sku.mjs;
// eBay lacked an equivalent guard, which is how it regressed. This test mirrors
// the Joom guard for eBay.

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');

function extractFunctionBlock(source, functionName) {
  let start = source.indexOf(`function ${functionName}`);
  assert(start >= 0, `${functionName} must exist`);
  const asyncStart = start - 'async '.length;
  if (asyncStart >= 0 && source.slice(asyncStart, start) === 'async ') start = asyncStart;
  const open = source.indexOf('{', start);
  assert(open > start, `${functionName} must have a body`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${functionName} body must close`);
}

assert(
  html.includes('data-open-ebay-group') && html.includes('data-open-ebay-single'),
  'Product list must render eBay register buttons (group + single)',
);
assert(
  html.includes('window.sdOpenRegisterEbayGroupModal = openRegisterEbayGroupModal'),
  'eBay register opener must be exported on window for the product-list buttons',
);

// The master-register eBay modal opener must be exported on window so the
// outer-scope product-list opener can reach it (the bridge).
assert(
  html.includes('window.mrOpenEbayModal = mrOpenEbayModal'),
  'Master-register eBay modal opener must be exported on window (bridge) for product-list eBay buttons',
);

// The publish call inside openRegisterEbayGroupModal must go through the window
// bridge, never a bare `mrOpenEbayModal(...)` reference that ReferenceErrors.
assert(
  html.includes('window.mrOpenEbayModal(plBuildJoomPublishGroupFromProducts(rows))'),
  'Product-list eBay button must open the modal through window.mrOpenEbayModal',
);

// And it must guard against the bridge being uninitialized, like Joom does.
assert(
  html.includes("if (typeof window.mrOpenEbayModal !== 'function')"),
  'openRegisterEbayGroupModal must guard against the eBay bridge being uninitialized',
);

// openRegisterEbayGroupModal must fetch the full RSH_PRODUCT_SELECT column set
// (which includes ebay_variation_value / ebay_item_id / ebay_status), NOT the lean
// state.products shortcut. The lean rows omit the eBay columns, which breaks
// preservePublishedVariationValue and makes a re-publish send mismatched (short)
// variation values that the live eBay listing rejects.
const ebayOpenerStart = html.indexOf('async function openRegisterEbayGroupModal');
const ebayOpenerEnd = html.indexOf('window.sdOpenRegisterEbayGroupModal = openRegisterEbayGroupModal');
assert(ebayOpenerStart >= 0 && ebayOpenerEnd > ebayOpenerStart, 'openRegisterEbayGroupModal must exist');
const ebayOpener = html.slice(ebayOpenerStart, ebayOpenerEnd);
assert(
  ebayOpener.includes('.select(RSH_PRODUCT_SELECT)'),
  'openRegisterEbayGroupModal must load rows via RSH_PRODUCT_SELECT (full eBay columns)',
);
assert(
  !ebayOpener.includes('localRows'),
  'openRegisterEbayGroupModal must not use the lean state.products localRows shortcut (omits ebay_variation_value/ebay_item_id, breaks preservePublishedVariationValue)',
);

const platformValidationStart = html.indexOf('function platformGroupValidation');
const platformValidationEnd = html.indexOf('function platformPreviewHtml', platformValidationStart);
assert(platformValidationStart >= 0 && platformValidationEnd > platformValidationStart, 'platformGroupValidation must exist');
const platformValidation = html.slice(platformValidationStart, platformValidationEnd);
const platformRenderStart = html.indexOf('function renderPlatformWorkbench');
const platformRenderEnd = html.indexOf('function renderPlatformWorkbenches', platformRenderStart);
assert(platformRenderStart >= 0 && platformRenderEnd > platformRenderStart, 'renderPlatformWorkbench must exist');
const platformRender = html.slice(platformRenderStart, platformRenderEnd);
const platformPreviewStart = html.indexOf('function platformOpenPreview');
const platformPreviewEnd = html.indexOf('function platformGroupValidation', platformPreviewStart);
assert(platformPreviewStart >= 0 && platformPreviewEnd > platformPreviewStart, 'platformOpenPreview must exist');
const platformPreview = html.slice(platformPreviewStart, platformPreviewEnd);
const platformSyncStart = html.indexOf('async function platformSyncSelected');
const platformSyncEnd = html.indexOf('function plGroupRowsById', platformSyncStart);
assert(platformSyncStart >= 0 && platformSyncEnd > platformSyncStart, 'platformSyncSelected must exist');
const platformSync = html.slice(platformSyncStart, platformSyncEnd);

assert(
  html.includes("const PLATFORM_EBAY_DEFAULT_CATEGORY_ID = '176984'"),
  'Platform eBay registration preview must define the default Music > CDs category id',
);
assert(
  platformValidation.includes('기본 Music > CDs (${PLATFORM_EBAY_DEFAULT_CATEGORY_ID})로 등록합니다.'),
  'eBay registration preview must warn and use the default Music > CDs category when ebay_category_id is missing',
);
assert(
  !platformValidation.includes("errors.push('eBay category ID가 없습니다.')"),
  'eBay registration preview must not block missing ebay_category_id because the modal defaults to Music > CDs',
);
assert(
  platformRender.includes('const visibleGroups = platformVisibleGroups(platform);')
    && platformRender.includes('const canUseVisibleSingle = !isAlibaba && selectedCount === 0 && visibleGroups.length === 1;')
    && platformRender.includes("${canRunSelectionAction ? '' : 'disabled'}>등록 미리보기"),
  'Platform registration preview must be enabled when search/filter leaves one visible product even without a checkbox selection',
);
assert(
  platformPreview.includes('if (!groups.length && !explicitKeys)')
    && platformPreview.includes('if (visibleGroups.length === 1) groups = visibleGroups;'),
  'Platform registration preview must auto-target the single visible product when no explicit selection exists',
);
assert(
  platformSync.includes('if (!groups.length)')
    && platformSync.includes('if (visibleGroups.length === 1) groups = visibleGroups;'),
  'Platform remote SKU check must use the same single visible product fallback as registration preview',
);

const platformOpenPreviewFn = new Function(
  'state',
  'platformSelectedGroups',
  'platformVisibleGroups',
  'platformGroupKey',
  'showToast',
  'renderPlatformWorkbench',
  'document',
  `${extractFunctionBlock(html, 'platformOpenPreview')}; return platformOpenPreview;`,
);

{
  const state = { platformPreview: null };
  const calls = { toasts: [], renders: [], scrolled: false };
  const openPreview = platformOpenPreviewFn(
    state,
    () => [],
    () => [{ key: 'single:jennie-ruby', rows: [{ id: 'jennie-ruby' }] }],
    (group) => group.key,
    (message, kind) => calls.toasts.push({ message, kind }),
    (platform) => calls.renders.push(platform),
    {
      getElementById: () => ({
        querySelector: () => ({
          scrollIntoView: () => { calls.scrolled = true; },
        }),
      }),
    },
  );
  openPreview('ebay', 'register');
  assert.deepEqual(state.platformPreview, {
    platform: 'ebay',
    action: 'register',
    keys: ['single:jennie-ruby'],
    createdAt: state.platformPreview.createdAt,
    running: false,
  }, 'eBay register preview must target the single visible JENNIE/Ruby product without a checkbox selection');
  assert.equal(calls.toasts.length, 0, 'single visible product preview must not show a no-selection toast');
  assert.deepEqual(calls.renders, ['ebay'], 'single visible product preview must rerender the eBay workbench');
  assert.equal(calls.scrolled, true, 'single visible product preview must scroll the preview into view');
}

{
  const state = { platformPreview: null };
  const calls = { toasts: [] };
  const openPreview = platformOpenPreviewFn(
    state,
    () => [],
    () => [
      { key: 'single:jennie-ruby-a', rows: [{ id: 'a' }] },
      { key: 'single:jennie-ruby-b', rows: [{ id: 'b' }] },
    ],
    (group) => group.key,
    (message, kind) => calls.toasts.push({ message, kind }),
    () => {},
    { getElementById: () => null },
  );
  openPreview('ebay', 'register');
  assert.equal(state.platformPreview, null, 'multi-result preview must still require an explicit selection');
  assert.equal(calls.toasts.length, 1, 'multi-result preview must explain that no product is selected');
}

const platformSyncSelectedFn = new Function(
  'platformSelectedGroups',
  'platformVisibleGroups',
  'showToast',
  'syncPlatformSkusForProductIds',
  'renderPlatformWorkbenches',
  `${extractFunctionBlock(html, 'platformSyncSelected')}; return platformSyncSelected;`,
);

{
  const calls = { toasts: [], synced: [], rendered: 0 };
  const syncSelected = platformSyncSelectedFn(
    () => [],
    () => [{ key: 'single:jennie-ruby', rows: [{ id: 'jennie-ruby' }] }],
    (message, kind) => calls.toasts.push({ message, kind }),
    async (ids) => { calls.synced.push(ids); },
    () => { calls.rendered += 1; },
  );
  await syncSelected('ebay');
  assert.deepEqual(calls.synced, [['jennie-ruby']], 'remote SKU check must also target a single visible eBay product');
  assert.equal(calls.rendered, 1, 'remote SKU check must rerender platform tabs after sync');
  assert.equal(calls.toasts.length, 0, 'remote SKU check must not show a no-selection toast for one visible product');
}

const platformGroupValidationFn = new Function(`
  const PLATFORM_SAFE_EDIT_FIELDS = Object.freeze({ ebay: ['price', 'inventory'], alibaba: [] });
  const PLATFORM_LABELS = Object.freeze({ ebay: 'eBay', alibaba: 'Alibaba' });
  const PLATFORM_EBAY_DEFAULT_CATEGORY_ID = '176984';
  function plProductName(row) { return row?.product_name || row?.sku || String(row?.id || ''); }
  ${extractFunctionBlock(html, 'platformGroupValidation')}
  return platformGroupValidation;
`)();

{
  const validation = platformGroupValidationFn('ebay', 'register', {
    rows: [{
      id: 'jennie-ruby-digipack',
      sku: 'JENNIE-RUBY-DIGIPACK',
      product_name: '[READY STOCK] (JENNIE) The 1st Studio Album [Ruby] (CD Digipack)',
      cost_krw: 15000,
      weight_g: 500,
    }],
  });
  assert.deepEqual(validation.errors, [], 'eBay registration must not be blocked when ebay_category_id is missing');
  assert(
    validation.warnings.some((warning) => warning.includes('Music > CDs (176984)')),
    'eBay registration must warn that the default Music > CDs category will be used',
  );
}

console.log('v2 eBay register button bridge checks passed');
