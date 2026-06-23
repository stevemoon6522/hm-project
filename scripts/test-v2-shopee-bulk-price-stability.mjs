import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

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
const payloadBuilder = sliceBetween(
  priceSync,
  'function catBuildPriceSyncPayloads()',
  'function catBuildDryRunPayloads()',
);
const preflight = sliceBetween(
  priceSync,
  'async function catPreflightShopeePayloads(payloads)',
  'function catApplyShopeeListingCache(payload, nowIso)',
);
const ensureListings = sliceBetween(
  priceSync,
  'async function catEnsureSelectedShopeeListings()',
  'async function catExecuteShopeeLive()',
);
const liveSync = sliceBetween(
  priceSync,
  'async function catExecuteShopeeLive()',
  'async function catExecuteJoomSync()',
);
const flushInlineEdits = sliceBetween(
  priceSync,
  'function catFlushSelectedInlineEdits(options)',
  'function catUlid()',
);
const flushInlineHarnessSource = sliceBetween(
  priceSync,
  'function catParseInlinePositiveNumber(input)',
  'function catUlid()',
);

assert.match(payloadBuilder, /listing:\s*listing/, 'Shopee bulk price payloads must carry listing metadata for safe preflight trust decisions');
assert.match(payloadBuilder, /needsModel:\s*needsModel/, 'Shopee bulk price payloads must mark variant/global-model rows as requiring shop_model_id');
assert.match(preflight, /PREFLIGHT_PARALLELISM\s*=\s*5/, 'Shopee bulk price preflight must limit parallel Shopee model lookups to 5');
assert.match(preflight, /needsFetch\.slice\(i,\s*i \+ PREFLIGHT_PARALLELISM\)/, 'Shopee preflight must process model lookup chunks');
assert.match(preflight, /Promise\.all\(chunk\.map\(async/, 'Shopee preflight must fetch model indexes concurrently within each chunk');
assert.match(preflight, /PREFLIGHT_TRUST_TTL_MS\s*=\s*6 \* 60 \* 60 \* 1000/, 'Shopee preflight must only trust fresh mapped listings');
assert.match(preflight, /listing\.last_synced_at \|\| listing\.published_at/, 'Shopee preflight must use last sync/published freshness for mapped listing trust');
assert.match(preflight, /status !== 'mapped'/, 'Shopee preflight must only skip API validation for mapped listings');
assert.match(preflight, /mixedKeys/, 'Shopee preflight must fetch when any target for an item is untrusted');
assert.match(preflight, /_trusted:\s*true/, 'Shopee preflight must mark synthetic cache entries for trusted mappings');
assert.match(preflight, /else if \(!p\.needsModel\)/, 'Shopee preflight must not trust item-level updates for rows that require a model id');
assert.match(preflight, /p\.needsModel && !p\.modelId/, 'Shopee preflight must block variant rows without shop_model_id before update_price');
assert.match(preflight, /!isTrustedListing\(p\.listing\) \|\| p\.needsModel/, 'Shopee preflight must re-check remote models for variant rows even when local mapping is fresh');
assert.match(preflight, /catShopeeModelMatchesPayloadSku\(matchedModel, p\)/, 'Shopee preflight must verify model_id belongs to the selected SKU before update_price');
assert.match(ensureListings, /const globalModelId = catProductGlobalModelId\(product, byRegion\)/, 'Shopee live sync must carry global_model_id into listing hydration');
assert.match(ensureListings, /account_key:\s*SHOPEE_DEFAULT_ACCOUNT_KEY,[\s\S]*global_item_id:\s*String\(globalItemId\)/, 'Shopee live sync must scope published_list hydration to the active account and global item');
assert.match(ensureListings, /global_model_id:\s*globalModelId \|\|/, 'Shopee live sync must persist global_model_id while hydrating shop ids');
assert.match(ensureListings, /existingModel && catShopeeModelMatchesProduct\(existingModel, product\)/, 'Shopee listing hydration must only skip existing shop_model_id when it matches the selected product');
assert.match(ensureListings, /matchedModel = modelInfo\.models\.find\(function\(m\) \{ return catShopeeModelMatchesProduct\(m, product\); \}\)/, 'Shopee listing hydration must correct stale shop_model_id mappings by SKU');
assert.match(liveSync, /catBridgePriceOk\(json\)/, 'Shopee live bulk sync must treat bridge failure_list as an update failure');
assert.match(liveSync, /catInsertShopeePriceLog\(p, ok \? 'ok' : 'error'/, 'Shopee live bulk sync must audit both successful and failed update_price calls');
assert.match(priceSync, /function catCostOverridesSourcingDerivedCost\(/, 'Shopee inline flush must explicitly decide when direct Cost edits override stale sourcing input');
assert.ok(
  flushInlineEdits.indexOf('const costInput = tr.querySelector') >= 0
    && flushInlineEdits.indexOf('const costInput = tr.querySelector') < flushInlineEdits.indexOf('const sourcingInput = tr.querySelector'),
  'Shopee inline flush must read Cost before applying sourcing so a direct Cost edit is not overwritten before sync',
);
assert.match(flushInlineEdits, /costOverridesSourcing/, 'Shopee inline flush must preserve a direct Cost edit instead of recomputing from unchanged wholesale');
assert.match(priceSync, /function catBuildDeliveryOnlyLogisticPatch\(/, 'Shopee price sync must build a delivery-only logistics patch for channel-related update_price failures');
assert.match(priceSync, /self\\s\*collection[\s\S]*locker[\s\S]*pick\[-\\s\]\?up/, 'Shopee logistics repair must detect self-collection, locker, and pickup channels');
assert.match(priceSync, /function catRetryShopeePriceAfterLogisticsRepair\(/, 'Shopee price sync must retry update_price after repairing prohibited logistics channels');
assert.match(liveSync, /catRetryShopeePriceAfterLogisticsRepair\(p,\s*errorMsg\)/, 'Shopee live sync must invoke logistics repair retry for channel/logistics price failures');

async function runFlushHarness({ productSourcing, productCost, sourcingInputValue, costInputValue }) {
  const context = {
    console,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);

  const harness = `
  (async function() {
    var RSH_SETTLEMENT_MULTIPLIER = 1.30;
    var pendingCostEdits = {};
    var pendingSourcingEdits = {};
    var pendingWeightEdits = {};
    var catSelectedIds = new Set(['pid']);
    var product = {
      id: 'pid',
      sourcing_price: ${JSON.stringify(productSourcing)},
      cost_krw: ${JSON.stringify(productCost)},
      weight_g: 150
    };
    var _catCache = { products: [product], listings: [] };
    var lastRenderedCost = null;
    function classList() { return { add: function() {}, remove: function() {} }; }
    var costInput = { value: ${JSON.stringify(String(costInputValue))}, classList: classList() };
    var sourcingInput = { value: ${JSON.stringify(String(sourcingInputValue))}, classList: classList() };
    var weightInput = { value: '150', classList: classList() };
    var row = {
      querySelector: function(selector) {
        if (selector === '.cat-cost-input') return costInput;
        if (selector === '.cat-sourcing-input') return sourcingInput;
        if (selector === '.cat-weight-input') return weightInput;
        return null;
      }
    };
    var cb = {
      dataset: { catSel: 'pid' },
      closest: function() { return row; }
    };
    var document = {
      querySelectorAll: function(selector) {
        return selector === '.cat-row-cb:checked' ? [cb] : [];
      },
      querySelector: function(selector) {
        return selector === '[data-cat-pid="pid"]' ? row : null;
      }
    };
    function catUpdateRowPriceCells(pid, cost) { lastRenderedCost = cost; }
    function catApplySourcingToRow(pid, sourcing) {
      const cost = Math.round(sourcing * RSH_SETTLEMENT_MULTIPLIER);
      costInput.value = String(cost);
      pendingCostEdits[pid] = cost;
      pendingSourcingEdits[pid] = sourcing;
      product.sourcing_price = sourcing;
      catUpdateRowPriceCells(pid, cost);
    }
    function catEffectiveCost(row) {
      const key = String(row.id);
      return key in pendingCostEdits ? pendingCostEdits[key] : Number(row.cost_krw || 0);
    }
    async function catPersistWeight() {}
    ${flushInlineHarnessSource}
    await catFlushSelectedInlineEdits({ persistWeight: false });
    globalThis.result = {
      cost: pendingCostEdits.pid,
      sourcing: pendingSourcingEdits.pid ?? null,
      costInputValue: costInput.value,
      rendered: lastRenderedCost,
    };
  })();
  `;
  await new vm.Script(harness, { filename: 'v2-cost-flush-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify(context.result));
}

function runPayloadHarness() {
  const context = {
    Date: class {
      static now() { return 1782223000000; }
    },
    JSON,
    Map,
    Math,
    Number,
    Set,
    String,
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);

  const harness = `
  var CAT_REGIONS = ['SG', 'TW'];
  var _catRegionVisible = new Set(['SG', 'TW']);
  var SHOPEE_BRIDGE = 'https://bridge.example';
  var catSelectedIds = new Set(['option-ej', 'option-fuma']);
  var pendingCostEdits = { 'option-ej': 12000, 'option-fuma': 8000 };
  var pendingWeightEdits = {};
  var _catCache = {
    products: [
      { id: 'parent', sku: 'T4-TEA-WEONF-SOL-', product_kind: 'parent', cost_krw: 99999, weight_g: 150 },
      { id: 'option-ej', sku: 'T4-TEA-WEONF-SOL-EJ', product_kind: 'option', cost_krw: 13000, weight_g: 100, global_model_id: 101, shopee_global_model_sku: 'T4-TEA-WEONF-SOL-EJ' },
      { id: 'option-fuma', sku: 'T4-TEA-WEONF-SOL-FUMA', product_kind: 'option', cost_krw: 7000, weight_g: 100, global_model_id: 102, shopee_global_model_sku: 'T4-TEA-WEONF-SOL-FUMA' }
    ],
    listings: [
      { product_id: 'option-ej', region: 'SG', shop_item_id: 431, shop_model_id: 9001, global_item_id: 57356515280, global_model_id: 101, status: 'mapped' },
      { product_id: 'option-ej', region: 'TW', shop_item_id: 511, shop_model_id: 9002, global_item_id: 57356515280, global_model_id: 101, status: 'mapped' },
      { product_id: 'option-fuma', region: 'SG', shop_item_id: 431, shop_model_id: 9011, global_item_id: 57356515280, global_model_id: 102, status: 'mapped' },
      { product_id: 'option-fuma', region: 'TW', shop_item_id: 511, shop_model_id: 9012, global_item_id: 57356515280, global_model_id: 102, status: 'mapped' }
    ]
  };
  var document = {
    querySelector: function() { return { querySelector: function() { return { checked: true }; } }; }
  };
  function catUlid() { return 'RUN'; }
  function catEffectiveWeight(product) { return product.weight_g; }
  function catProductGlobalItemId(product, byRegion) {
    const first = Array.from(byRegion.values())[0];
    return first && Number(first.global_item_id);
  }
  function catProductGlobalModelId(product, byRegion) {
    return Number(product.global_model_id || 0);
  }
  function catProductNeedsShopeeModel(product) {
    return product.product_kind === 'option';
  }
  function catComputeNewPrice(cost, region) {
    return region === 'SG' ? Number(cost) / 1000 : Number(cost) / 100;
  }
  function normalizeShopeeOriginalPrice(region, price) {
    return { ok: Number.isFinite(Number(price)), value: Number(price) };
  }
  function simpleHash(input) { return 'h' + String(input).length; }
  ${payloadBuilder}
  globalThis.result = catBuildPriceSyncPayloads();
  `;

  new vm.Script(harness, { filename: 'v2-shopee-option-payload-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify(context.result));
}

assert.deepEqual(
  await runFlushHarness({
    productSourcing: 10098,
    productCost: 13127,
    sourcingInputValue: 10098,
    costInputValue: 12000,
  }),
  { cost: 12000, sourcing: null, costInputValue: '12000', rendered: 12000 },
  'Direct Cost=12000 must survive sync flush even when stale wholesale=10098 is still present',
);
assert.deepEqual(
  await runFlushHarness({
    productSourcing: 10098,
    productCost: 13127,
    sourcingInputValue: 9000,
    costInputValue: 13127,
  }),
  { cost: 11700, sourcing: 9000, costInputValue: '11700', rendered: 11700 },
  'Wholesale edit without a manual Cost override must still derive Cost=wholesale*1.30',
);
assert.deepEqual(
  await runFlushHarness({
    productSourcing: 10098,
    productCost: 13127,
    sourcingInputValue: 9000,
    costInputValue: 12000,
  }),
  { cost: 12000, sourcing: 9000, costInputValue: '12000', rendered: 12000 },
  'When both wholesale and Cost are edited, a manual Cost override must be the price-sync cost',
);

const optionPayloads = runPayloadHarness().payloads;
assert.equal(optionPayloads.length, 4, 'Multi-option Shopee price sync must build one payload per selected option row and region');
assert.deepEqual(
  optionPayloads.map(function(p) {
    return {
      productId: p.productId,
      sku: p.sku,
      region: p.region,
      modelId: p.modelId,
      newCost: p.newCost,
      price: p.price,
      priceList: p.payload.price_list,
    };
  }),
  [
    {
      productId: 'option-ej',
      sku: 'T4-TEA-WEONF-SOL-EJ',
      region: 'SG',
      modelId: 9001,
      newCost: 12000,
      price: 12,
      priceList: [{ model_id: 9001, original_price: 12 }],
    },
    {
      productId: 'option-ej',
      sku: 'T4-TEA-WEONF-SOL-EJ',
      region: 'TW',
      modelId: 9002,
      newCost: 12000,
      price: 120,
      priceList: [{ model_id: 9002, original_price: 120 }],
    },
    {
      productId: 'option-fuma',
      sku: 'T4-TEA-WEONF-SOL-FUMA',
      region: 'SG',
      modelId: 9011,
      newCost: 8000,
      price: 8,
      priceList: [{ model_id: 9011, original_price: 8 }],
    },
    {
      productId: 'option-fuma',
      sku: 'T4-TEA-WEONF-SOL-FUMA',
      region: 'TW',
      modelId: 9012,
      newCost: 8000,
      price: 80,
      priceList: [{ model_id: 9012, original_price: 80 }],
    },
  ],
  'Multi-option Shopee price sync must use each option row Cost and model_id instead of the parent representative Cost',
);

console.log('v2 Shopee bulk price stability checks passed');
