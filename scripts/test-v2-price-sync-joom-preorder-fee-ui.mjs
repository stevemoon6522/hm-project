import assert from 'node:assert/strict';
import fs from 'node:fs';

const v2 = fs.readFileSync(new URL('../v2/index.html', import.meta.url), 'utf8');

function sliceBetween(source, start, end) {
  const s = source.indexOf(start);
  assert.ok(s >= 0, `missing start token: ${start}`);
  const e = source.indexOf(end, s);
  assert.ok(e > s, `missing end token after ${start}`);
  return source.slice(s, e);
}

const priceSync = sliceBetween(
  v2,
  'renderCatalogView() — main entry point, called on tab click.',
  'initDailyCloseListeners();',
);
const preOrderMarkup = sliceBetween(
  v2,
  'VIEW: PRE ORDER 목록',
  'VIEW: 상품 조회 + 매입가 동기화',
);
const preOrderLogic = sliceBetween(
  v2,
  '// PRE ORDER LIST VIEW',
  'READY STOCK 전환 마법사 — Phase B',
);
const fees = sliceBetween(
  v2,
  '// FEE / EXCHANGE-RATE SETTINGS',
  '</script>',
);
const masterRegister = sliceBetween(
  v2,
  '// MASTER REGISTER (view-register, 2-stage bulk URL+weight)',
  '// FEE / EXCHANGE-RATE SETTINGS',
);

assert.match(priceSync, /let _catActivePlatform = 'shopee'/, 'price sync must track the active platform tab');
assert.match(priceSync, /function catBuildJoomHeaders\(/, 'Joom tab must have dedicated price headers');
assert.match(priceSync, /function catBuildJoomCells\(/, 'Joom tab must render dedicated price cells');
assert.match(priceSync, /if \(_catActivePlatform === 'joom'\) return catBuildJoomHeaders\(\)/, 'Joom tab must not render Shopee region headers');
assert.match(priceSync, /if \(_catActivePlatform === 'joom'\) return catBuildJoomCells\(/, 'Joom tab must not render Shopee region formula cells');
assert.match(priceSync, /catSyncPlatformActions\(\)/, 'platform tab switch must sync Shopee/Joom action visibility');

assert.match(preOrderMarkup, /id="po-select-all"/, 'PRE ORDER header must include select-all checkbox');
assert.match(preOrderLogic, /class="po-row-cb"/, 'PRE ORDER rows must include individual checkboxes');
assert.match(preOrderLogic, /function poVisibleProductIds\(/, 'PRE ORDER list must derive visible IDs for select-all state');
assert.match(preOrderLogic, /function poSyncSelectAll\(/, 'PRE ORDER select-all must support checked/indeterminate state');
assert.match(preOrderLogic, /state\.selectedPreOrderIds\.add\(pid\)/, 'PRE ORDER row checkbox must add selected IDs');
assert.match(preOrderLogic, /poSelectAll\.addEventListener\('change'/, 'PRE ORDER select-all must update visible selected IDs');
assert.match(preOrderLogic, /new Set\(state\.selectedPreOrderIds\)/, 'READY STOCK wizard must open with selected PRE ORDER rows');

assert.match(fees, /FEE_COUNTRY_LABELS/, 'fee settings must label virtual country rows');
assert.match(fees, /FEE_COUNTRIES = \['SG', 'TW', 'TH', 'MY', 'PH', 'BR', 'JM', 'EX'\]/, 'fee settings must expose the Joom global fee row');
assert.match(fees, /JM: 'Joom \(Global\)'/, 'fee settings must label JM as Joom global');
assert.match(fees, /EX: 'eBay EX \(가상\)'/, 'fee settings must clarify EX as the eBay virtual row');
assert.match(fees, /feeCountryLabel\(code\)/, 'fee tabs and reset labels must use user-facing country labels');

assert.match(v2, /id="mr-joom-modal-overlay"/, 'Joom publish must have a confirmation modal overlay');
assert.match(masterRegister, /function mrOpenJoomModal\(group\)/, 'Joom publish button must open a modal before live publish');
assert.match(masterRegister, /function mrConfirmJoomModal\(\)/, 'Joom modal must confirm into the existing publish flow');
assert.match(masterRegister, /mrOpenJoomModal\(group\)/, 'Joom publish button should open the modal, not publish immediately');
assert.match(masterRegister, /mrPromoteJoom\(_mrPendingJoomGroup \|\| group\)/, 'Joom modal confirm must call existing mrPromoteJoom flow');

console.log('v2 price sync / PRE ORDER / fee UI checks passed');
