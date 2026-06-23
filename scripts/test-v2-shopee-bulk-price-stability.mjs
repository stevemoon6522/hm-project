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

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`function ${name} must close`);
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
assert.match(payloadBuilder, /optionName:\s*product\.option_name/, 'Shopee price payloads must carry option_name for model fallback matching');
assert.match(payloadBuilder, /variationTierIndex:\s*Array\.isArray\(product\.variation_tier_index\)/, 'Shopee price payloads must carry variation_tier_index for model fallback matching');
assert.match(payloadBuilder, /needsModel:\s*needsModel/, 'Shopee bulk price payloads must mark variant/global-model rows as requiring shop_model_id');
assert.match(payloadBuilder, /catBuildShopeePriceEntry/, 'Shopee price payloads must split model and no-model price entry shapes explicitly');
assert.match(priceSync, /function catShopeeTierIndexMatches\(/, 'Shopee model matching must support tier-index fallback when model_sku is absent');
assert.match(priceSync, /function catShopeeRemoteListingMissingMessage\(/, 'Shopee preflight must detect stale remote item ids that are no longer published');
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
assert.match(preflight, /if \(!info\.hasModel\)[\s\S]*p\.needsModel = false[\s\S]*catBuildShopeePriceEntry/, 'Shopee preflight must downgrade false variant mappings when the remote item has no models');
assert.match(preflight, /skipped\.push/, 'Shopee preflight must skip stale remote item ids without failing valid region price updates');
assert.match(preflight, /!isTrustedListing\(p\.listing\) \|\| p\.needsModel/, 'Shopee preflight must re-check remote models for variant rows even when local mapping is fresh');
assert.match(preflight, /catShopeeModelMatchesPayloadSku\(matchedModel, p\)/, 'Shopee preflight must verify model_id belongs to the selected SKU before update_price');
assert.match(ensureListings, /const globalModelId = catProductGlobalModelId\(product, byRegion\)/, 'Shopee live sync must carry global_model_id into listing hydration');
assert.match(ensureListings, /account_key:\s*SHOPEE_DEFAULT_ACCOUNT_KEY,[\s\S]*global_item_id:\s*String\(globalItemId\)/, 'Shopee live sync must scope published_list hydration to the active account and global item');
assert.match(ensureListings, /global_model_id:\s*globalModelId \|\|/, 'Shopee live sync must persist global_model_id while hydrating shop ids');
assert.match(ensureListings, /existingModel && catShopeeModelMatchesProduct\(existingModel, product\)/, 'Shopee listing hydration must only skip existing shop_model_id when it matches the selected product');
assert.match(ensureListings, /matchedModel = modelInfo\.models\.find\(function\(m\) \{ return catShopeeModelMatchesProduct\(m, product\); \}\)/, 'Shopee listing hydration must correct stale shop_model_id mappings by SKU');
assert.match(ensureListings, /catMarkShopeeListingNotListed/, 'Shopee listing hydration must clear stale region mappings before payload build');
assert.match(liveSync, /catBridgePriceOk\(json\)/, 'Shopee live bulk sync must treat bridge failure_list as an update failure');
assert.match(liveSync, /catInsertShopeePriceLog\(p, ok \? 'ok' : 'error'/, 'Shopee live bulk sync must audit both successful and failed update_price calls');
assert.match(liveSync, /preflight\.skipped/, 'Shopee live bulk sync must report skipped stale regions separately from errors');
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
assert.match(priceSync, /function catBuildShopeePriceEntry\(/, 'Shopee price sync must have an explicit no-model price entry builder');
assert.match(priceSync, /model_id:\s*0,\s*original_price:\s*originalPrice/, 'Shopee no-model price updates must send model_id=0 per local API docs');
assert.match(liveSync, /catFlushSelectedInlineEdits\(\{\s*persistWeight:\s*true,\s*silentWeightToast:\s*true\s*\}\)/, 'Shopee live sync must suppress weight-save success toasts');
assert.match(flushInlineEdits, /weightChanged[\s\S]*catPersistWeight\(pid,\s*roundedWeight,\s*weightInput,\s*\{\s*silentSuccess:/, 'Shopee inline flush must persist weights only when changed and pass the silent toast flag');
assert.match(priceSync, /responseJson && \(responseJson\.log_id \|\| responseJson\.previous_log_id\)/, 'Shopee live sync must not double-write mutation logs after Edge logging succeeds');

const bridgeSource = fs.readFileSync(new URL('../supabase/functions/shopee-bridge/index.ts', import.meta.url), 'utf8');
assert.match(bridgeSource, /if \(action === 'update_price' && req\.method === 'POST'\)[\s\S]*insertMutationLog\({[\s\S]*action: 'update_price'/, 'Shopee update_price bridge route must log via service-role Edge function');
assert.match(bridgeSource, /shop_update_price_idempotent_skip/, 'Shopee update_price bridge route must idempotently skip already-logged ok payloads');

async function runFlushHarness({ productSourcing, productCost, sourcingInputValue, costInputValue, productWeight = 150, weightInputValue = 150, persistWeight = false, silentWeightToast = false }) {
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
      weight_g: ${JSON.stringify(productWeight)}
    };
    var _catCache = { products: [product], listings: [] };
    var lastRenderedCost = null;
    function classList() { return { add: function() {}, remove: function() {} }; }
    var costInput = { value: ${JSON.stringify(String(costInputValue))}, classList: classList() };
    var sourcingInput = { value: ${JSON.stringify(String(sourcingInputValue))}, classList: classList() };
    var weightInput = { value: ${JSON.stringify(String(weightInputValue))}, classList: classList() };
    var persistedWeightCalls = [];
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
    async function catPersistWeight(pid, weight, input, options) {
      persistedWeightCalls.push({ pid, weight, silentSuccess: !!(options && options.silentSuccess) });
    }
    ${flushInlineHarnessSource}
    await catFlushSelectedInlineEdits({ persistWeight: ${JSON.stringify(persistWeight)}, silentWeightToast: ${JSON.stringify(silentWeightToast)} });
    globalThis.result = {
      cost: pendingCostEdits.pid,
      sourcing: pendingSourcingEdits.pid ?? null,
      costInputValue: costInput.value,
      rendered: lastRenderedCost,
      persistedWeightCalls: persistedWeightCalls,
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
  ${extractFunction(v2, 'catBuildShopeePriceEntry')}
  ${payloadBuilder}
  globalThis.result = catBuildPriceSyncPayloads();
  `;

  new vm.Script(harness, { filename: 'v2-shopee-option-payload-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify(context.result));
}

function runStandalonePayloadHarness() {
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
  var catSelectedIds = new Set(['single']);
  var pendingCostEdits = { single: 49920 };
  var pendingWeightEdits = {};
  var _catCache = {
    products: [
      {
        id: 'single',
        sku: 'ATEEZ-LIGHTSTICK-V3',
        product_name: '[READY STOCK] ATEEZ OFFICIAL LIGHT STICK VER 3',
        option_name: 'LIGHTSTICK',
        cost_krw: 51000,
        weight_g: 1000,
        shopee_item_id: 44562383405,
        product_group_id: 'single',
        variation_option_names: ['LIGHTSTICK'],
        variation_tier_index: null
      }
    ],
    listings: [
      { product_id: 'single', region: 'SG', shop_item_id: 49862317265, shop_model_id: null, global_item_id: 48112303677, global_model_id: null, status: 'mapped' },
      { product_id: 'single', region: 'TW', shop_item_id: 49862317259, shop_model_id: null, global_item_id: 48112303677, global_model_id: null, status: 'mapped' }
    ]
  };
  var document = {
    querySelector: function() { return { querySelector: function() { return { checked: true }; } }; }
  };
  function catUlid() { return 'RUN'; }
  function catEffectiveWeight(product) { return product.weight_g; }
  function catComputeNewPrice(cost, region) {
    return region === 'SG' ? 67.92 : 1524;
  }
  function normalizeShopeeOriginalPrice(region, price) {
    return { ok: Number.isFinite(Number(price)), value: Number(price) };
  }
  function simpleHash(input) { return 'h' + String(input).length; }
  ${extractFunction(v2, 'catProductGlobalItemId')}
  ${extractFunction(v2, 'catProductGlobalModelId')}
  ${extractFunction(v2, 'catProductNeedsShopeeModel')}
  ${extractFunction(v2, 'catBuildShopeePriceEntry')}
  ${payloadBuilder}
  globalThis.result = catBuildPriceSyncPayloads();
  `;

  new vm.Script(harness, { filename: 'v2-shopee-standalone-payload-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify(context.result));
}

async function runNoModelPreflightHarness() {
  const context = {
    Date,
    JSON,
    Map,
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
  ${extractFunction(v2, 'catBuildShopeePriceEntry')}
  function catShopeeModelMatchesPayloadSku() { return false; }
  async function catFetchShopeeModelIndex() {
    return { ok: true, hasModel: false, modelIds: new Set(), models: [] };
  }
  ${preflight}
  (async function() {
    const payloads = [{
      productId: 'single',
      sku: 'ATEEZ-LIGHTSTICK-V3',
      region: 'SG',
      itemId: 49862317265,
      modelId: null,
      needsModel: true,
      price: 67.92,
      listing: { status: 'mapped', last_synced_at: '2026-06-23T16:42:00.39+00:00' },
      payload: {
        region: 'SG',
        item_id: 49862317265,
        price_list: [{ model_id: null, original_price: 67.92 }],
      },
    }];
    globalThis.result = await catPreflightShopeePayloads(payloads);
  })();
  `;

  await new vm.Script(harness, { filename: 'v2-shopee-no-model-preflight-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify(context.result));
}

async function runMissingRegionPreflightHarness() {
  const context = {
    Date,
    JSON,
    Map,
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
  ${extractFunction(v2, 'catBuildShopeePriceEntry')}
  ${extractFunction(v2, 'catNormalizeSkuText')}
  ${extractFunction(v2, 'catShopeeTierIndexValues')}
  ${extractFunction(v2, 'catShopeeTierIndexMatches')}
  ${extractFunction(v2, 'catShopeeRemoteListingMissingMessage')}
  ${extractFunction(v2, 'catShopeeModelMatchesPayloadSku')}
  async function catFetchShopeeModelIndex() {
    return { ok: false, error: '.error_busi please input correct product id', hasModel: false, modelIds: new Set(), models: [] };
  }
  ${preflight}
  (async function() {
    const payloads = [{
      productId: 'scene-1',
      sku: 'V1-COR-COLOR-PHO-SCENE 1',
      region: 'BR',
      itemId: 43322467300,
      modelId: null,
      needsModel: true,
      price: 94.18,
      listing: { status: 'mapped', last_synced_at: '2026-06-23T17:12:56.878+00:00' },
      payload: {
        region: 'BR',
        item_id: 43322467300,
        price_list: [{ model_id: null, original_price: 94.18 }],
      },
    }];
    globalThis.result = await catPreflightShopeePayloads(payloads);
  })();
  `;

  await new vm.Script(harness, { filename: 'v2-shopee-missing-region-preflight-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify(context.result));
}

function runCortisModelMatchHarness() {
  const context = {
    Array,
    Number,
    String,
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);

  const harness = `
  ${extractFunction(v2, 'catNormalizeSkuText')}
  ${extractFunction(v2, 'catShopeeTierIndexValues')}
  ${extractFunction(v2, 'catShopeeTierIndexMatches')}
  ${extractFunction(v2, 'catShopeeModelMatchesPayloadSku')}
  globalThis.result = {
    sku: catShopeeModelMatchesPayloadSku(
      { model_sku: 'V1-COR-COLOR-PHO-SCENE 1', model_name: 'SCENE 1', tier_index: [0] },
      { sku: 'V1-COR-COLOR-PHO-SCENE 1', globalModelSku: null, optionName: null, variationTierIndex: [0, 0] }
    ),
    tierOnly: catShopeeModelMatchesPayloadSku(
      { model_sku: '', model_name: '', tier_index: [1] },
      { sku: 'LOCAL-SKU-WITHOUT-REMOTE-SKU', globalModelSku: null, optionName: null, variationTierIndex: [0, 1] }
    ),
    wrongTier: catShopeeModelMatchesPayloadSku(
      { model_sku: '', model_name: '', tier_index: [2] },
      { sku: 'LOCAL-SKU-WITHOUT-REMOTE-SKU', globalModelSku: null, optionName: null, variationTierIndex: [0, 1] }
    ),
  };
  `;

  new vm.Script(harness, { filename: 'v2-shopee-cortis-model-match-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify(context.result));
}

assert.deepEqual(
  await runFlushHarness({
    productSourcing: 10098,
    productCost: 13127,
    sourcingInputValue: 10098,
    costInputValue: 12000,
  }),
  { cost: 12000, sourcing: null, costInputValue: '12000', rendered: 12000, persistedWeightCalls: [] },
  'Direct Cost=12000 must survive sync flush even when stale wholesale=10098 is still present',
);
assert.deepEqual(
  await runFlushHarness({
    productSourcing: 10098,
    productCost: 13127,
    sourcingInputValue: 9000,
    costInputValue: 13127,
  }),
  { cost: 11700, sourcing: 9000, costInputValue: '11700', rendered: 11700, persistedWeightCalls: [] },
  'Wholesale edit without a manual Cost override must still derive Cost=wholesale*1.30',
);
assert.deepEqual(
  await runFlushHarness({
    productSourcing: 10098,
    productCost: 13127,
    sourcingInputValue: 9000,
    costInputValue: 12000,
  }),
  { cost: 12000, sourcing: 9000, costInputValue: '12000', rendered: 12000, persistedWeightCalls: [] },
  'When both wholesale and Cost are edited, a manual Cost override must be the price-sync cost',
);
assert.deepEqual(
  await runFlushHarness({
    productSourcing: 38400,
    productCost: 49920,
    sourcingInputValue: 38400,
    costInputValue: 49920,
    productWeight: 1000,
    weightInputValue: 1000,
    persistWeight: true,
    silentWeightToast: true,
  }),
  { sourcing: null, costInputValue: '49920', rendered: null, persistedWeightCalls: [] },
  'Shopee sync flush must not persist unchanged weight or show a weight toast before price sync',
);
assert.deepEqual(
  await runFlushHarness({
    productSourcing: 38400,
    productCost: 49920,
    sourcingInputValue: 38400,
    costInputValue: 49920,
    productWeight: 900,
    weightInputValue: 1000,
    persistWeight: true,
    silentWeightToast: true,
  }),
  { sourcing: null, costInputValue: '49920', rendered: 49920, persistedWeightCalls: [{ pid: 'pid', weight: 1000, silentSuccess: true }] },
  'Shopee sync flush may persist a changed weight, but must suppress the weight success toast',
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

const standalonePayloads = runStandalonePayloadHarness().payloads;
assert.deepEqual(
  standalonePayloads.map(function(p) {
    return {
      productId: p.productId,
      sku: p.sku,
      region: p.region,
      modelId: p.modelId,
      needsModel: p.needsModel,
      globalItemId: p.globalItemId,
      newCost: p.newCost,
      price: p.price,
      priceList: p.payload.price_list,
    };
  }),
  [
    {
      productId: 'single',
      sku: 'ATEEZ-LIGHTSTICK-V3',
      region: 'SG',
      modelId: null,
      needsModel: false,
      globalItemId: 48112303677,
      newCost: 49920,
      price: 67.92,
      priceList: [{ model_id: 0, original_price: 67.92 }],
    },
    {
      productId: 'single',
      sku: 'ATEEZ-LIGHTSTICK-V3',
      region: 'TW',
      modelId: null,
      needsModel: false,
      globalItemId: 48112303677,
      newCost: 49920,
      price: 1524,
      priceList: [{ model_id: 0, original_price: 1524 }],
    },
  ],
  'Standalone Shopee items with a display option_name must stay item-level and use model_id=0',
);

const noModelPreflight = await runNoModelPreflightHarness();
assert.equal(noModelPreflight.blocked.length, 0, 'Remote no-model Shopee items must not be blocked as missing shop_model_id');
assert.deepEqual(
  noModelPreflight.valid.map(function(p) {
    return {
      sku: p.sku,
      region: p.region,
      needsModel: p.needsModel,
      modelId: p.modelId,
      priceList: p.payload.price_list,
    };
  }),
  [{
    sku: 'ATEEZ-LIGHTSTICK-V3',
    region: 'SG',
    needsModel: false,
    modelId: null,
    priceList: [{ model_id: 0, original_price: 67.92 }],
  }],
  'Remote no-model preflight must downgrade false variant mappings to item-level update_price payloads',
);

const missingRegionPreflight = await runMissingRegionPreflightHarness();
assert.equal(missingRegionPreflight.valid.length, 0, 'Missing remote region should not become a valid update_price call');
assert.equal(missingRegionPreflight.blocked.length, 0, 'Missing remote region should not block valid regions as an error');
assert.deepEqual(
  missingRegionPreflight.skipped.map(function(p) {
    return { sku: p.sku, region: p.region, reason: p.reason };
  }),
  [{
    sku: 'V1-COR-COLOR-PHO-SCENE 1',
    region: 'BR',
    reason: 'remote listing not found: .error_busi please input correct product id',
  }],
  'Stale BR mappings should be skipped with the exact remote item-not-found reason',
);

assert.deepEqual(
  runCortisModelMatchHarness(),
  { sku: true, tierOnly: true, wrongTier: false },
  'CORTIS-style option rows must match by SKU first and by phantom-first-tier fallback when SKU is unavailable',
);

console.log('v2 Shopee bulk price stability checks passed');
