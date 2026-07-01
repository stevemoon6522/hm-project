import assert from 'node:assert/strict';
import fs from 'node:fs';

const v2 = fs.readFileSync(new URL('../v2/index.html', import.meta.url), 'utf8');
const ebayFeeMigration = fs.readFileSync(new URL('../supabase/migrations/202605300003_ebay_cd_international_fee.sql', import.meta.url), 'utf8');
const qoo10FeeMigration = fs.readFileSync(new URL('../supabase/migrations/202606070001_qoo10_fee_settings.sql', import.meta.url), 'utf8');

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
assert.match(priceSync, /function catMarketCellsForProduct\(product, listingByRegion, effectiveCost, weightG\)[\s\S]*if \(_catActivePlatform === 'shopee'\) return catShopeeMarketsForProduct\([\s\S]*return catPlatformMarketsForProduct\(product, _catActivePlatform, effectiveCost, weightG\)/, 'Joom tab must not render Shopee region formula cells');
assert.doesNotMatch(v2, /id="cat-platform-tabs"/, 'Shopee price sync view must not expose a generic platform switcher');

assert.match(preOrderMarkup, /id="po-select-all"/, 'PRE ORDER header must include select-all checkbox');
assert.match(preOrderLogic, /class="po-row-cb"/, 'PRE ORDER rows must include individual checkboxes');
assert.match(preOrderLogic, /function poVisibleProductIds\(/, 'PRE ORDER list must derive visible IDs for select-all state');
assert.match(preOrderLogic, /function poSyncSelectAll\(/, 'PRE ORDER select-all must support checked/indeterminate state');
assert.match(preOrderLogic, /state\.selectedPreOrderIds\.add\(pid\)/, 'PRE ORDER row checkbox must add selected IDs');
assert.match(preOrderLogic, /poSelectAll\.addEventListener\('change'/, 'PRE ORDER select-all must update visible selected IDs');
assert.match(preOrderLogic, /new Set\(state\.selectedPreOrderIds\)/, 'READY STOCK wizard must open with selected PRE ORDER rows');

assert.match(fees, /FEE_COUNTRY_LABELS/, 'fee settings must label virtual country rows');
assert.match(fees, /FEE_COUNTRIES = \['SG', 'TW', 'TH', 'MY', 'PH', 'BR', 'JM', 'Q10', 'EX', 'SHOPIFY'\]/, 'fee settings must expose the Joom, Qoo10, eBay, and Shopify virtual fee rows');
assert.match(fees, /FEE_TAB_LABELS/, 'fee settings must define display-only platform tab labels');
assert.match(fees, /SG: 'Shopee SG'/, 'fee settings tab must prefix Shopee regions with the platform name');
assert.match(fees, /TW: 'Shopee TW'/, 'fee settings tab must prefix Shopee TW with the platform name');
assert.match(fees, /JM: 'Joom'/, 'fee settings tab must show only the Joom platform name');
assert.match(fees, /Q10: 'Qoo10'/, 'fee settings tab must show only the Qoo10 platform name');
assert.match(fees, /EX: 'eBay'/, 'fee settings tab must show only the eBay platform name');
assert.match(fees, /SHOPIFY: 'Shopify'/, 'fee settings tab must show only the Shopify platform name');
assert.match(fees, /feeTabLabel\(code\)/, 'fee settings tabs must use the display-only platform label helper');
assert.match(fees, /JM: 'Joom \(Global\)'/, 'fee settings must label JM as Joom global');
assert.match(fees, /Q10: 'Qoo10 JP'/, 'fee settings must label Q10 as Qoo10 Japan');
assert.match(fees, /EX: 'eBay EX \(가상\)'/, 'fee settings must clarify EX as the eBay virtual row');
assert.match(fees, /SHOPIFY: 'Shopify price policy'/, 'fee settings must label Shopify as the price policy row');
assert.match(fees, /feeCountryLabel\(code\)/, 'fee tabs and reset labels must use user-facing country labels');
assert.match(fees, /FEE_EBAY_FIELDS/, 'fee settings must define an eBay-specific fee field list');
assert.match(fees, /Final Value Fee · CD\/Music category/, 'eBay EX fee tab must expose the 15.3% category final value fee');
assert.match(fees, /International Fee/, 'eBay EX fee tab must expose the global seller international fee');
assert.match(fees, /defaultValue: 15\.3/, 'eBay category fee default must be 15.3%');
assert.match(fees, /defaultValue: 1\.45/, 'eBay international fee default must be 1.45%');
assert.match(fees, /feeFieldsForCountry\(feeActiveCountry\)/, 'fee settings must render EX with its eBay-only fee fields instead of all Shopee fee fields');
assert.match(fees, /FEE_QOO10_FIELDS/, 'fee settings must define a Qoo10-specific fee field list');
assert.match(fees, /JPY Exchange Rate/, 'Qoo10 fee tab must expose the applied JPY exchange rate');
assert.match(fees, /Category Fee/, 'Qoo10 fee tab must expose the category fee');
assert.match(fees, /PRE ORDER Fee/, 'Qoo10 fee tab must expose the preorder fee');
assert.match(fees, /Megawari Fee/, 'Qoo10 fee tab must expose the Megawari fee');
assert.match(fees, /defaultValue: 9\.1/, 'Qoo10 exchange-rate default must be 9.1');
assert.match(fees, /key: 'sales_fee'[^\n]+defaultValue: 11/, 'Qoo10 category fee default must be 11%');
assert.match(fees, /key: 'fsp_fee'[^\n]+defaultValue: 2/, 'Qoo10 preorder fee default must be 2%');
assert.match(fees, /key: 'other_fee'[^\n]+defaultValue: 1/, 'Qoo10 Megawari fee default must be 1%');
assert.match(fees, /renderQoo10FeeSummary/, 'Qoo10 fee tab must show the combined fee summary');
assert.match(ebayFeeMigration, /sales_fee = 15\.3/, 'eBay EX migration must set category final value fee to 15.3%');
assert.match(ebayFeeMigration, /pg_fee = 1\.45/, 'eBay EX migration must set international fee to 1.45%');
assert.match(ebayFeeMigration, /where country_code = 'EX'/, 'eBay EX fee migration must only touch the virtual eBay row');
assert.match(qoo10FeeMigration, /'Q10'/, 'Qoo10 fee migration must seed the Q10 virtual fee row');
assert.match(qoo10FeeMigration, /9\.1/, 'Qoo10 fee migration must set the JPY exchange rate to 9.1');
assert.match(qoo10FeeMigration, /11,\s*\r?\n\s*2,\s*\r?\n\s*1,/, 'Qoo10 fee migration must set category 11%, preorder 2%, and Megawari 1%');

assert.match(v2, /id="mr-joom-modal-overlay"/, 'Joom publish must have a confirmation modal overlay');
assert.match(masterRegister, /function mrOpenJoomModal\(group\)/, 'Joom publish button must open a modal before live publish');
assert.match(masterRegister, /function mrConfirmJoomModal\(\)/, 'Joom modal must confirm into the existing publish flow');
assert.match(masterRegister, /mrOpenJoomModal\(group\)/, 'Joom publish button should open the modal, not publish immediately');
assert.match(masterRegister, /mrPromoteJoom\(_mrPendingJoomGroup \|\| group\)/, 'Joom modal confirm must call existing mrPromoteJoom flow');

console.log('v2 price sync / PRE ORDER / fee UI checks passed');
