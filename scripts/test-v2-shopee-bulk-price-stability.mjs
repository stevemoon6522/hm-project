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
  let start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const asyncStart = start - 'async '.length;
  if (asyncStart >= 0 && source.slice(asyncStart, start) === 'async ') start = asyncStart;
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
const updateBatching = sliceBetween(
  priceSync,
  'function catBuildShopeeUpdateBatches(payloads)',
  'async function catPostShopeePricePayload(payload)',
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
assert.match(preflight, /PREFLIGHT_TRUST_TTL_MS\s*=\s*6 \* 60 \* 60 \* 1000/, 'Shopee preflight may trust fresh mapped item-level listings');
assert.match(preflight, /listing\.last_synced_at \|\| listing\.published_at/, 'Shopee preflight must use last sync/published freshness for item-level mapped listing trust');
assert.match(preflight, /status !== 'mapped'/, 'Shopee preflight must only skip API validation for mapped listings');
assert.match(preflight, /mixedKeys/, 'Shopee preflight must fetch when any target for an item is untrusted');
assert.match(preflight, /_trusted:\s*true/, 'Shopee preflight must mark synthetic cache entries for trusted mappings');
assert.match(preflight, /else if \(!p\.needsModel\)/, 'Shopee preflight must not trust item-level updates for rows that require a model id');
assert.match(preflight, /p\.needsModel && !p\.modelId/, 'Shopee preflight must block variant rows without shop_model_id before update_price');
assert.match(preflight, /if \(!info\.hasModel\)[\s\S]*p\.needsModel = false[\s\S]*catBuildShopeePriceEntry/, 'Shopee preflight must downgrade false variant mappings when the remote item has no models');
assert.match(preflight, /skipped\.push/, 'Shopee preflight must skip stale remote item ids without failing valid region price updates');
assert.match(preflight, /if \(p\.needsModel\)[\s\S]*mixedKeys\.add\(key\)/, 'Shopee variant rows must fetch remote model lists even when local mappings look fresh');
assert.doesNotMatch(preflight, /isMappedListing\(p\.listing\) && p\.needsModel[\s\S]*trustedModelIds/, 'Shopee variant rows must not trust local shop_model_id without SKU verification');
assert.match(preflight, /catShopeeModelMatchesPayloadSku\(matchedModel, p\)/, 'Shopee preflight must verify model_id belongs to the selected SKU before update_price');
assert.match(preflight, /catShopeeModelMatchesPayloadSku\(m,\s*p\)/, 'Shopee preflight must find the correct remote model by selected SKU when local shop_model_id is stale');
assert.match(preflight, /p\.payload\.price_list = \[catBuildShopeePriceEntry\(/, 'Shopee preflight must rewrite update_price payloads after correcting stale shop_model_id mappings');
assert.match(ensureListings, /const globalModelId = catProductGlobalModelId\(product, byRegion\)/, 'Shopee live sync must carry global_model_id into listing hydration');
assert.match(ensureListings, /account_key:\s*SHOPEE_DEFAULT_ACCOUNT_KEY,[\s\S]*global_item_id:\s*String\(globalItemId\)/, 'Shopee live sync must scope published_list hydration to the active account and global item');
assert.match(ensureListings, /global_model_id:\s*globalModelId \|\|/, 'Shopee live sync must persist global_model_id while hydrating shop ids');
assert.match(ensureListings, /existingModel && catShopeeModelMatchesProduct\(existingModel, product\)/, 'Shopee listing hydration must only skip existing shop_model_id when it matches the selected product');
assert.match(ensureListings, /matchedModel = modelInfo\.models\.find\(function\(m\) \{ return catShopeeModelMatchesProduct\(m, product\); \}\)/, 'Shopee listing hydration must correct stale shop_model_id mappings by SKU');
assert.match(ensureListings, /catMarkShopeeListingNotListed/, 'Shopee listing hydration must clear stale region mappings before payload build');
assert.match(priceSync, /function catBridgePriceFailureList\(json\)/, 'Shopee live bulk sync must normalize bridge/Shopee failure_list responses');
assert.match(priceSync, /catBridgePriceOk\(json\)/, 'Shopee live bulk sync must treat bridge failure_list as an update failure');
assert.match(priceSync, /catInsertShopeePriceLog\(p, ok \? 'ok' : 'error'/, 'Shopee live bulk sync must audit both successful and failed update_price calls');
assert.match(liveSync, /preflight\.skipped/, 'Shopee live bulk sync must report skipped stale regions separately from errors');
assert.match(priceSync, /const SHOPEE_PRICE_UPDATE_PARALLELISM = 6/, 'Shopee live price sync should run the six active Shopee regions in one bounded wave');
assert.match(priceSync, /async function catPersistShopeeSyncResults\(updateResults,\s*now\)/, 'Shopee live sync must batch post-update DB persistence after update_price returns');
assert.match(liveSync, /const persistResult = await catPersistShopeeSyncResults\(updateResults,\s*now\)/, 'Shopee live sync must delegate logs, listing upserts, and cost persistence to the batched helper');
assert.doesNotMatch(liveSync, /for \(const result of updateResults\)[\s\S]*await db\.from\('product_shopee_listings'\)\.upsert/, 'Shopee live sync must not upsert listing rows sequentially per region after update_price');
assert.match(priceSync, /function catSyncTimingStart\(/, 'Shopee live sync must expose lightweight timing instrumentation');
assert.match(liveSync, /catSyncTimingMark\(timing,\s*'mapping'\)/, 'Shopee live sync timing must measure mapping hydration');
assert.match(liveSync, /catSyncTimingMark\(timing,\s*'preflight'\)/, 'Shopee live sync timing must measure preflight');
assert.match(liveSync, /catSyncTimingMark\(timing,\s*'update'\)/, 'Shopee live sync timing must measure update_price calls');
assert.match(liveSync, /catSyncTimingMark\(timing,\s*'persist'\)/, 'Shopee live sync timing must measure DB persistence');
assert.match(updateBatching, /price_list:\s*\[\]/, 'Shopee update batching must build a multi-entry price_list envelope');
assert.match(updateBatching, /batch\.payload\.price_list\.push\(entry\)/, 'Shopee update batching must append selected model price entries into one item update');
assert.match(priceSync, /async function catPostShopeePriceBridgeBatch\(batches\)/, 'Shopee price sync must have a bridge-side batch transport helper');
assert.match(priceSync, /SHOPEE_BRIDGE \+ '\/update_price_batch'/, 'Shopee price sync must call the bridge-side update_price_batch route');
assert.match(priceSync, /catExecuteShopeeUpdateBatchesViaBridge\(/, 'Shopee price sync must prefer the bridge-side batch route after preflight');
assert.match(priceSync, /catExecuteShopeeUpdateBatch\(batch\)/, 'Shopee price sync must keep the existing per-item fallback path');
assert.match(priceSync, /Promise\.all\(chunk\.map\(function\(batch\)/, 'Shopee live price sync must run region/item batches concurrently within the cap');
assert.match(liveSync, /catRunShopeePriceUpdates\(preflight\.valid\)/, 'Shopee live price sync must use the batched update runner instead of one sequential request per option row');
assert.ok(
  liveSync.indexOf("const earlySyncBtn = document.getElementById('cat-sync-btn');") >= 0
    && liveSync.indexOf("const earlySyncBtn = document.getElementById('cat-sync-btn');") < liveSync.indexOf('await catFlushSelectedInlineEdits'),
  'Shopee live sync must lock the sync button before async inline flush/listing hydration so clicks never look inert',
);
assert.ok(
  liveSync.indexOf('Shopee 가격 동기화 준비 중') >= 0
    && liveSync.indexOf('Shopee 가격 동기화 준비 중') < liveSync.indexOf('await catEnsureSelectedShopeeListings()'),
  'Shopee live sync must show immediate operator feedback before mapping hydration starts',
);
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
assert.match(priceSync, /catRetryShopeePriceAfterLogisticsRepair\(payload,\s*errorMsg\)/, 'Shopee live sync must invoke logistics repair retry for channel/logistics price failures');
assert.match(priceSync, /function catBuildShopeePriceEntry\(/, 'Shopee price sync must have an explicit no-model price entry builder');
assert.match(priceSync, /model_id:\s*0,\s*original_price:\s*originalPrice/, 'Shopee no-model price updates must send model_id=0 per local API docs');
assert.match(liveSync, /catFlushSelectedInlineEdits\(\{\s*persistWeight:\s*false\s*\}\)/, 'Shopee live sync must read weight inputs for price calculation without persisting weight');
assert.doesNotMatch(liveSync, /catFlushSelectedInlineEdits\(\{\s*persistWeight:\s*true/, 'Shopee live sync must not save weight before price sync');
assert.match(priceSync, /catSuppressNextWeightBlurSave/, 'Shopee sync click must suppress the weight-input blur save path');
assert.match(priceSync, /syncBtn\.addEventListener\('pointerdown',\s*suppressWeightBlurSaveForSyncClick\)/, 'Shopee sync button must suppress blur-triggered weight save before click');
assert.match(flushInlineEdits, /weightChanged[\s\S]*catPersistWeight\(pid,\s*roundedWeight,\s*weightInput,\s*\{\s*silentSuccess:/, 'Shopee inline flush must persist weights only when changed and pass the silent toast flag');
assert.match(priceSync, /responseJson && \(responseJson\.log_id \|\| responseJson\.previous_log_id\)/, 'Shopee live sync must not double-write mutation logs after Edge logging succeeds');

const bridgeSource = fs.readFileSync(new URL('../supabase/functions/shopee-bridge/index.ts', import.meta.url), 'utf8');
assert.match(bridgeSource, /async function executeShopUpdatePriceMutation\(/, 'Shopee update_price bridge logic must be shared by single and batch routes');
assert.match(bridgeSource, /if \(action === 'update_price' && req\.method === 'POST'\)[\s\S]*executeShopUpdatePriceMutation\(/, 'Shopee single update_price route must call the shared mutation helper');
assert.match(bridgeSource, /if \(action === 'update_price_batch' && req\.method === 'POST'\)[\s\S]*mapWithConcurrency\(/, 'Shopee update_price_batch route must fan out with bounded bridge-side concurrency');
assert.doesNotMatch(
  bridgeSource,
  /shop_update_price_idempotent_skip/,
  'Shopee update_price bridge route must not skip a live price call based only on historical payload_hash matches',
);
assert.match(bridgeSource, /shop_update_price_batch_complete/, 'Shopee update_price_batch route must audit aggregate batch completion');
assert.match(bridgeSource, /UPDATE_PRICE_BATCH_PARALLELISM = 6/, 'Shopee update_price_batch route should keep the six active regions in one bounded bridge-side wave');

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

function runUpdateBatchHarness(payloads) {
  const context = {
    JSON,
    Map,
    Number,
    Set,
    String,
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);

  const harness = `
  var SHOPEE_BRIDGE = 'https://bridge.example';
  var payloads = ${JSON.stringify(payloads)};
  ${extractFunction(v2, 'catShopeePriceEntryModelKey')}
  ${extractFunction(v2, 'catBuildShopeeUpdateBatches')}
  globalThis.result = catBuildShopeeUpdateBatches(payloads).map(function(batch) {
    return {
      region: batch.region,
      itemId: batch.itemId,
      skus: batch.items.map(function(item) { return item.sku; }),
      priceList: batch.payload.price_list,
    };
  });
  `;

  new vm.Script(harness, { filename: 'v2-shopee-update-batch-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify(context.result));
}

function runBatchFailureHarness() {
  const context = {
    JSON,
    Number,
    String,
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);

  const harness = `
  ${extractFunction(v2, 'catBridgePriceFailureList')}
  ${extractFunction(v2, 'catShopeePriceEntryModelKey')}
  ${extractFunction(v2, 'catShopeePayloadModelKey')}
  ${extractFunction(v2, 'catShopeeBatchFailureMessage')}
  var json = {
    ok: false,
    failure_list: [
      { model_id: 9011, failed_reason: 'price exceeds limit for model' }
    ],
  };
  var successPayload = { payload: { price_list: [{ model_id: 9001, original_price: 12 }] } };
  var failedPayload = { payload: { price_list: [{ model_id: 9011, original_price: 8 }] } };
  globalThis.result = {
    success: catShopeeBatchFailureMessage(json, successPayload),
    failed: catShopeeBatchFailureMessage(json, failedPayload),
  };
  `;

  new vm.Script(harness, { filename: 'v2-shopee-batch-failure-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify(context.result));
}

async function runBridgeBatchSuccessHarness() {
  const context = {
    Array,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    Set,
    String,
    URLSearchParams,
    console,
    globalThis: null,
    AUTH_HEADERS: { Authorization: 'Bearer test' },
    SHOPEE_BRIDGE: 'https://bridge.test',
    SHOPEE_DEFAULT_ACCOUNT_KEY: 'starphotocard',
    SHOPEE_PRICE_UPDATE_PARALLELISM: 6,
    SHOPEE_PRICE_UPDATE_BRIDGE_BATCH_SIZE: 60,
    fetchCalls: [],
  };
  context.globalThis = context;
  context.fetch = async function(url, options) {
    context.fetchCalls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async function() {
        return {
          ok: true,
          results: [
            { ok: true, client_ref: 'SG:412:0', region: 'SG', item_id: 412, log_id: 'sg-log', result: { response: { success_list: [{ model_id: 1, original_price: 18.26 }] } } },
            { ok: true, client_ref: 'TW:530:1', region: 'TW', item_id: 530, log_id: 'tw-log', result: { response: { success_list: [{ model_id: 2, original_price: 418 }] } } },
          ],
        };
      },
    };
  };
  vm.createContext(context);
  const harness = `
    function bridgeResultMessage(json) { return json && (json.error || json.message) || ''; }
    ${extractFunction(v2, 'catBridgePriceFailureList')}
    ${extractFunction(v2, 'catBridgePriceMessage')}
    ${extractFunction(v2, 'catShopeePriceEntryModelKey')}
    ${extractFunction(v2, 'catShopeePayloadModelKey')}
    ${extractFunction(v2, 'catShopeeBatchFailureMessage')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatches')}
    ${extractFunction(v2, 'catShopeePriceErrorNeedsLogisticsRepair')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatchRequestRows')}
    ${extractFunction(v2, 'catShopeeBatchRouteResultMessage')}
    ${extractFunction(v2, 'catBridgeBatchRouteUnavailable')}
    ${extractFunction(v2, 'catPostShopeePriceBridgeBatch')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatchesViaBridge')}
    ${extractFunction(v2, 'catRunShopeePriceUpdates')}
    (async function() {
      globalThis.rows = await catRunShopeePriceUpdates([
        { sku: 'SKU-SG', region: 'SG', itemId: 412, modelId: 1, bridgeUrl: SHOPEE_BRIDGE + '/update_price', payload: { region: 'SG', item_id: 412, price_list: [{ model_id: 1, original_price: 18.26 }] } },
        { sku: 'SKU-TW', region: 'TW', itemId: 530, modelId: 2, bridgeUrl: SHOPEE_BRIDGE + '/update_price', payload: { region: 'TW', item_id: 530, price_list: [{ model_id: 2, original_price: 418 }] } },
      ]);
    })();
  `;
  await new vm.Script(harness, { filename: 'v2-shopee-bridge-batch-success-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify({ rows: context.rows, fetchCalls: context.fetchCalls }));
}

async function runBridgeBatchUnavailableFallbackHarness() {
  const context = {
    Array,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    Set,
    String,
    URLSearchParams,
    console,
    globalThis: null,
    AUTH_HEADERS: { Authorization: 'Bearer test' },
    SHOPEE_BRIDGE: 'https://bridge.test',
    SHOPEE_DEFAULT_ACCOUNT_KEY: 'starphotocard',
    SHOPEE_PRICE_UPDATE_PARALLELISM: 6,
    SHOPEE_PRICE_UPDATE_BRIDGE_BATCH_SIZE: 60,
    fetchCalls: [],
  };
  context.globalThis = context;
  context.fetch = async function(url, options) {
    context.fetchCalls.push({ url, body: JSON.parse(options.body) });
    if (String(url).endsWith('/update_price_batch')) {
      return { ok: false, status: 404, json: async function() { return { ok: false, error: 'unknown action' }; } };
    }
    return { ok: true, status: 200, json: async function() { return { ok: true, log_id: 'single-log', result: { response: { failure_list: [] } } }; } };
  };
  vm.createContext(context);
  const harness = `
    function bridgeResultMessage(json) { return json && (json.error || json.message) || ''; }
    ${extractFunction(v2, 'catBridgePriceOk')}
    ${extractFunction(v2, 'catBridgePriceFailureList')}
    ${extractFunction(v2, 'catBridgePriceMessage')}
    ${extractFunction(v2, 'catShopeePriceEntryModelKey')}
    ${extractFunction(v2, 'catShopeePayloadModelKey')}
    ${extractFunction(v2, 'catShopeeBatchFailureMessage')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatches')}
    ${extractFunction(v2, 'catShopeePriceErrorNeedsLogisticsRepair')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatchRequestRows')}
    ${extractFunction(v2, 'catShopeeBatchRouteResultMessage')}
    ${extractFunction(v2, 'catBridgeBatchRouteUnavailable')}
    ${extractFunction(v2, 'catPostShopeePricePayload')}
    ${extractFunction(v2, 'catPostShopeePriceBatch')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatch')}
    ${extractFunction(v2, 'catPostShopeePriceBridgeBatch')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatchesViaBridge')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatchesLegacy')}
    ${extractFunction(v2, 'catRunShopeePriceUpdates')}
    (async function() {
      globalThis.rows = await catRunShopeePriceUpdates([
        { sku: 'SKU-SG', region: 'SG', itemId: 412, modelId: 1, bridgeUrl: SHOPEE_BRIDGE + '/update_price', payload: { region: 'SG', item_id: 412, price_list: [{ model_id: 1, original_price: 18.26 }] } },
      ]);
    })();
  `;
  await new vm.Script(harness, { filename: 'v2-shopee-bridge-batch-fallback-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify({ rows: context.rows, fetchCalls: context.fetchCalls }));
}

async function runBridgeBatchServerErrorFallbackHarness() {
  const context = {
    Array,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    Set,
    String,
    URLSearchParams,
    console,
    globalThis: null,
    AUTH_HEADERS: { Authorization: 'Bearer test' },
    SHOPEE_BRIDGE: 'https://bridge.test',
    SHOPEE_DEFAULT_ACCOUNT_KEY: 'starphotocard',
    SHOPEE_PRICE_UPDATE_PARALLELISM: 6,
    SHOPEE_PRICE_UPDATE_BRIDGE_BATCH_SIZE: 60,
    fetchCalls: [],
  };
  context.globalThis = context;
  context.fetch = async function(url, options) {
    context.fetchCalls.push({ url, body: JSON.parse(options.body) });
    if (String(url).endsWith('/update_price_batch')) {
      return { ok: false, status: 500, json: async function() { return { ok: false, error: 'edge_runtime_error' }; } };
    }
    return { ok: true, status: 200, json: async function() { return { ok: true, log_id: 'single-log', result: { response: { failure_list: [] } } }; } };
  };
  vm.createContext(context);
  const harness = `
    function bridgeResultMessage(json) { return json && (json.error || json.message) || ''; }
    ${extractFunction(v2, 'catBridgePriceOk')}
    ${extractFunction(v2, 'catBridgePriceFailureList')}
    ${extractFunction(v2, 'catBridgePriceMessage')}
    ${extractFunction(v2, 'catShopeePriceEntryModelKey')}
    ${extractFunction(v2, 'catShopeePayloadModelKey')}
    ${extractFunction(v2, 'catShopeeBatchFailureMessage')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatches')}
    ${extractFunction(v2, 'catShopeePriceErrorNeedsLogisticsRepair')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatchRequestRows')}
    ${extractFunction(v2, 'catShopeeBatchRouteResultMessage')}
    ${extractFunction(v2, 'catBridgeBatchRouteUnavailable')}
    ${extractFunction(v2, 'catPostShopeePricePayload')}
    ${extractFunction(v2, 'catPostShopeePriceBatch')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatch')}
    ${extractFunction(v2, 'catPostShopeePriceBridgeBatch')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatchesViaBridge')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatchesLegacy')}
    ${extractFunction(v2, 'catRunShopeePriceUpdates')}
    (async function() {
      globalThis.rows = await catRunShopeePriceUpdates([
        { sku: 'SKU-SG', region: 'SG', itemId: 412, modelId: 1, bridgeUrl: SHOPEE_BRIDGE + '/update_price', payload: { region: 'SG', item_id: 412, price_list: [{ model_id: 1, original_price: 18.26 }] } },
      ]);
    })();
  `;
  await new vm.Script(harness, { filename: 'v2-shopee-bridge-batch-500-fallback-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify({ rows: context.rows, fetchCalls: context.fetchCalls }));
}

async function runBridgeBatchMissingResultsFallbackHarness({ parseFailure = false } = {}) {
  const context = {
    Array,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    Set,
    String,
    URLSearchParams,
    console,
    globalThis: null,
    AUTH_HEADERS: { Authorization: 'Bearer test' },
    SHOPEE_BRIDGE: 'https://bridge.test',
    SHOPEE_DEFAULT_ACCOUNT_KEY: 'starphotocard',
    SHOPEE_PRICE_UPDATE_PARALLELISM: 6,
    SHOPEE_PRICE_UPDATE_BRIDGE_BATCH_SIZE: 60,
    fetchCalls: [],
  };
  context.globalThis = context;
  context.fetch = async function(url, options) {
    context.fetchCalls.push({ url, body: JSON.parse(options.body) });
    if (String(url).endsWith('/update_price_batch')) {
      return {
        ok: true,
        status: 200,
        json: async function() {
          if (parseFailure) throw new Error('empty response');
          return { ok: true };
        },
      };
    }
    return { ok: true, status: 200, json: async function() { return { ok: true, log_id: 'single-log', result: { response: { failure_list: [] } } }; } };
  };
  vm.createContext(context);
  const harness = `
    function bridgeResultMessage(json) { return json && (json.error || json.message) || ''; }
    ${extractFunction(v2, 'catBridgePriceOk')}
    ${extractFunction(v2, 'catBridgePriceFailureList')}
    ${extractFunction(v2, 'catBridgePriceMessage')}
    ${extractFunction(v2, 'catShopeePriceEntryModelKey')}
    ${extractFunction(v2, 'catShopeePayloadModelKey')}
    ${extractFunction(v2, 'catShopeeBatchFailureMessage')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatches')}
    ${extractFunction(v2, 'catShopeePriceErrorNeedsLogisticsRepair')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatchRequestRows')}
    ${extractFunction(v2, 'catShopeeBatchRouteResultMessage')}
    ${extractFunction(v2, 'catBridgeBatchRouteUnavailable')}
    ${extractFunction(v2, 'catPostShopeePricePayload')}
    ${extractFunction(v2, 'catPostShopeePriceBatch')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatch')}
    ${extractFunction(v2, 'catPostShopeePriceBridgeBatch')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatchesViaBridge')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatchesLegacy')}
    ${extractFunction(v2, 'catRunShopeePriceUpdates')}
    (async function() {
      globalThis.rows = await catRunShopeePriceUpdates([
        { sku: 'SKU-SG', region: 'SG', itemId: 412, modelId: 1, bridgeUrl: SHOPEE_BRIDGE + '/update_price', payload: { region: 'SG', item_id: 412, price_list: [{ model_id: 1, original_price: 18.26 }] } },
      ]);
    })();
  `;
  await new vm.Script(harness, { filename: 'v2-shopee-bridge-batch-missing-results-fallback-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify({ rows: context.rows, fetchCalls: context.fetchCalls }));
}

async function runBridgeBatchChunkingHarness() {
  const payloads = Array.from({ length: 61 }, function(_, index) {
    return {
      sku: 'SKU-' + index,
      region: 'SG',
      itemId: 100000 + index,
      modelId: 200000 + index,
      bridgeUrl: 'https://bridge.test/update_price',
      payload: {
        region: 'SG',
        item_id: 100000 + index,
        price_list: [{ model_id: 200000 + index, original_price: 10 + index }],
      },
    };
  });
  const context = {
    Array,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    Set,
    String,
    URLSearchParams,
    console,
    globalThis: null,
    AUTH_HEADERS: { Authorization: 'Bearer test' },
    SHOPEE_BRIDGE: 'https://bridge.test',
    SHOPEE_DEFAULT_ACCOUNT_KEY: 'starphotocard',
    SHOPEE_PRICE_UPDATE_PARALLELISM: 6,
    SHOPEE_PRICE_UPDATE_BRIDGE_BATCH_SIZE: 60,
    fetchCalls: [],
  };
  context.globalThis = context;
  context.fetch = async function(url, options) {
    const body = JSON.parse(options.body);
    context.fetchCalls.push({ url, body });
    return {
      ok: true,
      status: 200,
      json: async function() {
        return {
          ok: true,
          results: (body.updates || []).map(function(row) {
            return { ok: true, client_ref: row.client_ref, region: row.region, item_id: row.item_id, log_id: 'log-' + row.item_id, result: { response: { failure_list: [] } } };
          }),
        };
      },
    };
  };
  vm.createContext(context);
  const harness = `
    function bridgeResultMessage(json) { return json && (json.error || json.message) || ''; }
    var payloads = ${JSON.stringify(payloads)};
    ${extractFunction(v2, 'catBridgePriceFailureList')}
    ${extractFunction(v2, 'catBridgePriceMessage')}
    ${extractFunction(v2, 'catShopeePriceEntryModelKey')}
    ${extractFunction(v2, 'catShopeePayloadModelKey')}
    ${extractFunction(v2, 'catShopeeBatchFailureMessage')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatches')}
    ${extractFunction(v2, 'catShopeePriceErrorNeedsLogisticsRepair')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatchRequestRows')}
    ${extractFunction(v2, 'catShopeeBatchRouteResultMessage')}
    ${extractFunction(v2, 'catBridgeBatchRouteUnavailable')}
    ${extractFunction(v2, 'catPostShopeePriceBridgeBatch')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatchesViaBridge')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatchesLegacy')}
    ${extractFunction(v2, 'catRunShopeePriceUpdates')}
    (async function() {
      globalThis.rows = await catRunShopeePriceUpdates(payloads);
    })();
  `;
  await new vm.Script(harness, { filename: 'v2-shopee-bridge-batch-chunking-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify({ rows: context.rows, fetchCalls: context.fetchCalls }));
}

async function runBridgeBatchFailureAttributionHarness() {
  const context = {
    Array,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    Set,
    String,
    URLSearchParams,
    console,
    globalThis: null,
    AUTH_HEADERS: { Authorization: 'Bearer test' },
    SHOPEE_BRIDGE: 'https://bridge.test',
    SHOPEE_DEFAULT_ACCOUNT_KEY: 'starphotocard',
    SHOPEE_PRICE_UPDATE_PARALLELISM: 6,
    SHOPEE_PRICE_UPDATE_BRIDGE_BATCH_SIZE: 60,
    fetchCalls: [],
  };
  context.globalThis = context;
  context.fetch = async function(url, options) {
    context.fetchCalls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async function() {
        return {
          ok: false,
          results: [{
            ok: false,
            client_ref: 'SG:412:0',
            region: 'SG',
            item_id: 412,
            failure_list: [{ model_id: 2, failed_reason: 'model price rejected for model 2' }],
            result: { response: { failure_list: [{ model_id: 2, failed_reason: 'model price rejected for model 2' }] } },
          }],
        };
      },
    };
  };
  vm.createContext(context);
  const harness = `
    function bridgeResultMessage(json) { return json && (json.error || json.message) || ''; }
    ${extractFunction(v2, 'catBridgePriceFailureList')}
    ${extractFunction(v2, 'catBridgePriceMessage')}
    ${extractFunction(v2, 'catShopeePriceEntryModelKey')}
    ${extractFunction(v2, 'catShopeePayloadModelKey')}
    ${extractFunction(v2, 'catShopeeBatchFailureMessage')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatches')}
    ${extractFunction(v2, 'catShopeePriceErrorNeedsLogisticsRepair')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatchRequestRows')}
    ${extractFunction(v2, 'catShopeeBatchRouteResultMessage')}
    ${extractFunction(v2, 'catBridgeBatchRouteUnavailable')}
    ${extractFunction(v2, 'catPostShopeePriceBridgeBatch')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatchesViaBridge')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatchesLegacy')}
    ${extractFunction(v2, 'catRunShopeePriceUpdates')}
    (async function() {
      globalThis.rows = await catRunShopeePriceUpdates([
        { sku: 'SKU-OK', region: 'SG', itemId: 412, modelId: 1, bridgeUrl: SHOPEE_BRIDGE + '/update_price', payload: { region: 'SG', item_id: 412, price_list: [{ model_id: 1, original_price: 18.26 }] } },
        { sku: 'SKU-FAIL', region: 'SG', itemId: 412, modelId: 2, bridgeUrl: SHOPEE_BRIDGE + '/update_price', payload: { region: 'SG', item_id: 412, price_list: [{ model_id: 2, original_price: 19.26 }] } },
      ]);
    })();
  `;
  await new vm.Script(harness, { filename: 'v2-shopee-bridge-batch-failure-attribution-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify({ rows: context.rows, fetchCalls: context.fetchCalls }));
}

async function runBridgeBatchLogisticsTargetHarness() {
  const context = {
    Array,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    Set,
    String,
    URLSearchParams,
    console,
    globalThis: null,
    AUTH_HEADERS: { Authorization: 'Bearer test' },
    SHOPEE_BRIDGE: 'https://bridge.test',
    SHOPEE_DEFAULT_ACCOUNT_KEY: 'starphotocard',
    SHOPEE_PRICE_UPDATE_PARALLELISM: 6,
    SHOPEE_PRICE_UPDATE_BRIDGE_BATCH_SIZE: 60,
    fetchCalls: [],
    singleRetrySkus: [],
  };
  context.globalThis = context;
  context.fetch = async function(url, options) {
    context.fetchCalls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async function() {
        return {
          ok: false,
          results: [{
            ok: false,
            client_ref: 'SG:412:0',
            region: 'SG',
            item_id: 412,
            failure_list: [{ model_id: 2, failed_reason: 'Shipping channel cannot be enabled as product price exceeds limit.' }],
            result: { response: { failure_list: [{ model_id: 2, failed_reason: 'Shipping channel cannot be enabled as product price exceeds limit.' }] } },
          }],
        };
      },
    };
  };
  vm.createContext(context);
  const harness = `
    function bridgeResultMessage(json) { return json && (json.error || json.message) || ''; }
    async function catPostShopeePricePayload(payload) {
      globalThis.singleRetrySkus.push(payload.sku);
      return { ok: true, json: { ok: true, log_id: 'single-retry-' + payload.sku }, errorMsg: null, preRetry: { errorMsg: 'batch logistics failure' } };
    }
    ${extractFunction(v2, 'catBridgePriceFailureList')}
    ${extractFunction(v2, 'catBridgePriceMessage')}
    ${extractFunction(v2, 'catShopeePriceEntryModelKey')}
    ${extractFunction(v2, 'catShopeePayloadModelKey')}
    ${extractFunction(v2, 'catShopeeBatchFailureMessage')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatches')}
    ${extractFunction(v2, 'catShopeePriceErrorNeedsLogisticsRepair')}
    ${extractFunction(v2, 'catBuildShopeeUpdateBatchRequestRows')}
    ${extractFunction(v2, 'catShopeeBatchRouteResultMessage')}
    ${extractFunction(v2, 'catBridgeBatchRouteUnavailable')}
    ${extractFunction(v2, 'catPostShopeePriceBridgeBatch')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatchesViaBridge')}
    ${extractFunction(v2, 'catExecuteShopeeUpdateBatchesLegacy')}
    ${extractFunction(v2, 'catRunShopeePriceUpdates')}
    (async function() {
      globalThis.rows = await catRunShopeePriceUpdates([
        { sku: 'SKU-OK', region: 'SG', itemId: 412, modelId: 1, bridgeUrl: SHOPEE_BRIDGE + '/update_price', payload: { region: 'SG', item_id: 412, price_list: [{ model_id: 1, original_price: 18.26 }] } },
        { sku: 'SKU-LOGISTICS', region: 'SG', itemId: 412, modelId: 2, bridgeUrl: SHOPEE_BRIDGE + '/update_price', payload: { region: 'SG', item_id: 412, price_list: [{ model_id: 2, original_price: 19.26 }] } },
      ]);
    })();
  `;
  await new vm.Script(harness, { filename: 'v2-shopee-bridge-batch-logistics-target-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify({ rows: context.rows, fetchCalls: context.fetchCalls, singleRetrySkus: context.singleRetrySkus }));
}

async function runPersistResultsHarness() {
  const context = {
    Date,
    JSON,
    Map,
    Number,
    Object,
    Promise,
    Set,
    String,
    console,
    globalThis: null,
    SHOPEE_DEFAULT_ACCOUNT_KEY: 'starphotocard',
    SHOPEE_LISTING_CONFLICT: 'product_id,account_key,region',
    dbCalls: [],
    cacheRows: [],
  };
  context.globalThis = context;
  context.pendingCostEdits = { random: 14281 };
  context.pendingSourcingEdits = {};
  context._catCache = {
    listings: context.cacheRows,
    products: [
      { id: 'random', sku: 'D2-BOY-HOME-SWE-RANDOM', cost_krw: 13281 },
    ],
  };
  context.db = {
    from(table) {
      return {
        insert(row) {
          context.dbCalls.push({ table, method: 'insert', row });
          return Promise.resolve({ error: null });
        },
        upsert(rows, options) {
          context.dbCalls.push({ table, method: 'upsert', rows, options });
          return Promise.resolve({ error: null });
        },
        update(fields) {
          return {
            eq(column, value) {
              context.dbCalls.push({ table, method: 'update', fields, eq: { column, value } });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  vm.createContext(context);

  const harness = `
  ${extractFunction(v2, 'catApplyShopeeListingCache')}
  ${extractFunction(v2, 'catShopeeListingUpsertRowFromPayload')}
  ${extractFunction(v2, 'catInsertShopeePriceLog')}
  ${extractFunction(v2, 'catPersistProductCost')}
  ${extractFunction(v2, 'catPersistShopeeSyncResults')}
  (async function() {
    const updateResults = [
      {
        ok: true,
        json: { ok: true, log_id: 'edge-log-sg' },
        errorMsg: null,
        p: {
          productId: 'random',
          sku: 'D2-BOY-HOME-SWE-RANDOM',
          region: 'SG',
          itemId: 41232027442,
          modelId: 346113183677,
          globalItemId: 54504712282,
          globalModelId: 346113183677,
          newCost: 14281,
          price: 18.26,
          payloadHash: 'dry:abc',
          payload: { region: 'SG', item_id: 41232027442, price_list: [{ model_id: 346113183677, original_price: 18.26 }] },
          listing: { status: 'mapped' },
        },
      },
      {
        ok: true,
        json: { ok: true, log_id: 'edge-log-tw' },
        errorMsg: null,
        p: {
          productId: 'random',
          sku: 'D2-BOY-HOME-SWE-RANDOM',
          region: 'TW',
          itemId: 53062837241,
          modelId: 366113187448,
          globalItemId: 54504712282,
          globalModelId: 366113187448,
          newCost: 14281,
          price: 418,
          payloadHash: 'dry:def',
          payload: { region: 'TW', item_id: 53062837241, price_list: [{ model_id: 366113187448, original_price: 418 }] },
          listing: { status: 'mapped' },
        },
      },
    ];
    globalThis.result = await catPersistShopeeSyncResults(updateResults, '2026-06-26T00:00:00.000Z');
  })();
  `;

  await new vm.Script(harness, { filename: 'v2-shopee-persist-results-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify({
    result: context.result,
    dbCalls: context.dbCalls,
    cacheRows: context.cacheRows,
    products: context._catCache.products,
  }));
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

async function runTrustedVariantPreflightHarness() {
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
  let fetchCalls = 0;
  async function catFetchShopeeModelIndex() {
    fetchCalls += 1;
    return {
      ok: true,
      hasModel: true,
      modelIds: new Set([9001]),
      models: [{ model_id: 9001, model_sku: 'T4-TEA-WEONF-SOL-EJ', model_name: 'EJ', tier_index: [0] }],
    };
  }
  ${preflight}
  (async function() {
    const payloads = [{
      productId: 'option-ej',
      sku: 'T4-TEA-WEONF-SOL-EJ',
      region: 'SG',
      itemId: 431,
      modelId: 9001,
      needsModel: true,
      price: 12,
      listing: {
        status: 'mapped',
        shop_item_id: 431,
        shop_model_id: 9001,
        last_synced_at: '2020-01-01T00:00:00.000Z',
      },
      payload: {
        region: 'SG',
        item_id: 431,
        price_list: [{ model_id: 9001, original_price: 12 }],
      },
    }];
    const result = await catPreflightShopeePayloads(payloads);
    globalThis.result = {
      fetchCalls,
      valid: result.valid.map(function(p) {
        return { sku: p.sku, region: p.region, modelId: p.modelId, needsModel: p.needsModel };
      }),
      blocked: result.blocked.map(function(p) { return { sku: p.sku, region: p.region, reason: p.reason }; }),
      skipped: result.skipped.map(function(p) { return { sku: p.sku, region: p.region, reason: p.reason }; }),
    };
  })();
  `;

  await new vm.Script(harness, { filename: 'v2-shopee-trusted-variant-preflight-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify(context.result));
}

async function runStaleVariantMappingCorrectionHarness() {
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
  let fetchCalls = 0;
  async function catFetchShopeeModelIndex() {
    fetchCalls += 1;
    return {
      ok: true,
      hasModel: true,
      modelIds: new Set([346113183677, 346113183681]),
      models: [
        { model_id: 346113183677, model_sku: 'D2-BOY-HOME-SWE-SUNGHO', model_name: 'SUNGHO', tier_index: [2] },
        { model_id: 346113183681, model_sku: 'D2-BOY-HOME-SWE-RANDOM', model_name: 'RANDOM', tier_index: [6] },
      ],
    };
  }
  ${preflight}
  (async function() {
    const payloads = [{
      productId: 'random',
      sku: 'D2-BOY-HOME-SWE-RANDOM',
      globalModelSku: 'D2-BOY-HOME-SWE-RANDOM',
      optionName: 'RANDOM',
      variationTierIndex: [6],
      region: 'SG',
      itemId: 41232027442,
      modelId: 346113183677,
      needsModel: true,
      price: 18.26,
      listing: {
        status: 'mapped',
        shop_item_id: 41232027442,
        shop_model_id: 346113183677,
        last_synced_at: '2026-06-26T15:51:53.644Z',
      },
      payload: {
        region: 'SG',
        item_id: 41232027442,
        price_list: [{ model_id: 346113183677, original_price: 18.26 }],
      },
    }];
    const result = await catPreflightShopeePayloads(payloads);
    globalThis.result = {
      fetchCalls,
      valid: result.valid.map(function(p) {
        return { sku: p.sku, region: p.region, modelId: p.modelId, priceList: p.payload.price_list };
      }),
      blocked: result.blocked.map(function(p) { return { sku: p.sku, region: p.region, reason: p.reason }; }),
      skipped: result.skipped.map(function(p) { return { sku: p.sku, region: p.region, reason: p.reason }; }),
    };
  })();
  `;

  await new vm.Script(harness, { filename: 'v2-shopee-stale-variant-mapping-correction-harness.mjs' }).runInContext(context);
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
    explicitIdentityMismatchBeatsStaleTier: catShopeeModelMatchesPayloadSku(
      { model_sku: 'D2-BOY-HOME-SWE-SUNGHO', model_name: 'SUNGHO', tier_index: [2] },
      { sku: 'D2-BOY-HOME-SWE-RANDOM', globalModelSku: 'D2-BOY-HOME-SWE-RANDOM', optionName: 'RANDOM', variationTierIndex: [2] }
    ),
  };
  `;

  new vm.Script(harness, { filename: 'v2-shopee-cortis-model-match-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify(context.result));
}

function runPublishedCandidateHarness() {
  const context = {
    Map,
    Number,
    String,
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);

  const harness = `
  ${extractFunction(v2, 'catShopeePublishedStatusRank')}
  ${extractFunction(v2, 'catShopeeListingIsPriceSyncable')}
  ${extractFunction(v2, 'catShopeePublishedRegionMatchRank')}
  ${extractFunction(v2, 'catShopeePublishedCandidateScore')}
  ${extractFunction(v2, 'catShopeePublishedCandidateForRegion')}
  const brItems = [
    { shop_id: 1002269093, shop_region: 'BR', item_id: 43322467300, item_status: 8 },
    { shop_id: 1669858301, shop_region: 'BR', item_id: 51050903742, item_status: 1 },
  ];
  globalThis.result = {
    activeShop: catShopeePublishedCandidateForRegion(brItems, 'BR', {
      byRegion: new Map([['BR', 1669858301]]),
      byShopId: new Map([['1669858301', 'BR']]),
    }),
    noShopIndex: catShopeePublishedCandidateForRegion(brItems, 'BR', {
      byRegion: new Map(),
      byShopId: new Map(),
    }),
    unlistedFallback: catShopeePublishedCandidateForRegion([brItems[0]], 'BR', {
      byRegion: new Map(),
      byShopId: new Map(),
    }),
  };
  `;

  new vm.Script(harness, { filename: 'v2-shopee-published-candidate-harness.mjs' }).runInContext(context);
  return JSON.parse(JSON.stringify(context.result));
}

async function runSkuLookupNameRequestHarness() {
  const context = {
    AUTH_HEADERS: {},
    Map,
    Number,
    Promise,
    Set,
    String,
    URLSearchParams,
    console,
    globalThis: null,
  };
  context.globalThis = context;
  context.SHOPEE_BRIDGE = 'https://bridge.example';
  context.SHOPEE_DEFAULT_ACCOUNT_KEY = 'starphotocard';
  context.fetch = async function(url) {
    context.capturedUrl = url;
    return {
      ok: true,
      status: 200,
      json: async function() { return { ok: true, region_hits: [] }; },
    };
  };
  vm.createContext(context);

  const harness = `
  ${extractFunction(v2, 'catShopeePublishedStatusRank')}
  ${extractFunction(v2, 'catShopeeListingIsPriceSyncable')}
  ${extractFunction(v2, 'catShopeeSkuLookupHitsFromResponse')}
  ${extractFunction(v2, 'catShopeeLookupNameTerms')}
  ${extractFunction(v2, 'catFetchShopeeSkuLookupHits')}
  (async function() {
    globalThis.terms = catShopeeLookupNameTerms({
      product_name: '[READY STOCK] CORTIS The 1st EP [COLOR OUTSIDE THE LINES]',
      option_name: 'SCENE 1',
    });
    globalThis.rows = await catFetchShopeeSkuLookupHits('V1-COR-COLOR-PHO-SCENE 1', ['BR'], {
      product_name: '[READY STOCK] CORTIS The 1st EP [COLOR OUTSIDE THE LINES]',
      option_name: 'SCENE 1',
    });
  })();
  `;

  await new vm.Script(harness, { filename: 'v2-shopee-lookup-name-request-harness.mjs' }).runInContext(context);
  return {
    terms: JSON.parse(JSON.stringify(context.terms)),
    capturedUrl: context.capturedUrl,
  };
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
assert.deepEqual(
  runUpdateBatchHarness(optionPayloads),
  [
    {
      region: 'SG',
      itemId: 431,
      skus: ['T4-TEA-WEONF-SOL-EJ', 'T4-TEA-WEONF-SOL-FUMA'],
      priceList: [
        { model_id: 9001, original_price: 12 },
        { model_id: 9011, original_price: 8 },
      ],
    },
    {
      region: 'TW',
      itemId: 511,
      skus: ['T4-TEA-WEONF-SOL-EJ', 'T4-TEA-WEONF-SOL-FUMA'],
      priceList: [
        { model_id: 9002, original_price: 120 },
        { model_id: 9012, original_price: 80 },
      ],
    },
  ],
  'Multi-option Shopee price sync must collapse same item/region option rows into one update_price price_list',
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
assert.deepEqual(
  runUpdateBatchHarness(standalonePayloads),
  [
    {
      region: 'SG',
      itemId: 49862317265,
      skus: ['ATEEZ-LIGHTSTICK-V3'],
      priceList: [{ model_id: 0, original_price: 67.92 }],
    },
    {
      region: 'TW',
      itemId: 49862317259,
      skus: ['ATEEZ-LIGHTSTICK-V3'],
      priceList: [{ model_id: 0, original_price: 1524 }],
    },
  ],
  'Standalone no-model Shopee price sync must remain one item-level update per region',
);
assert.deepEqual(
  runBatchFailureHarness(),
  { success: null, failed: 'price exceeds limit for model' },
  'Batched Shopee update_price failures must be attributed back to the matching model_id only',
);

const bridgeBatchSuccess = await runBridgeBatchSuccessHarness();
assert.equal(bridgeBatchSuccess.fetchCalls.length, 1, 'bridge batch route should send one browser fetch for multiple update_price batches');
assert.equal(bridgeBatchSuccess.fetchCalls[0].url, 'https://bridge.test/update_price_batch');
assert.equal(bridgeBatchSuccess.fetchCalls[0].body.updates.length, 2, 'bridge batch route should include each region/item update as one row');
assert.equal(bridgeBatchSuccess.rows.length, 2, 'bridge batch route response should expand back to per-payload results');
assert.equal(bridgeBatchSuccess.rows[0].ok, true, 'first bridge batch row should be successful');
assert.equal(bridgeBatchSuccess.rows[1].json.log_id, 'tw-log', 'second bridge batch row should retain the bridge mutation log id');

const bridgeBatchFallback = await runBridgeBatchUnavailableFallbackHarness();
assert.equal(bridgeBatchFallback.fetchCalls.length, 2, 'unavailable bridge batch route should fall back to existing update_price transport');
assert.equal(bridgeBatchFallback.fetchCalls[0].url, 'https://bridge.test/update_price_batch');
assert.equal(bridgeBatchFallback.fetchCalls[1].url, 'https://bridge.test/update_price');
assert.equal(bridgeBatchFallback.rows[0].ok, true, 'fallback update_price transport should preserve successful result shape');

const bridgeBatchServerErrorFallback = await runBridgeBatchServerErrorFallbackHarness();
assert.equal(bridgeBatchServerErrorFallback.fetchCalls.length, 2, 'server-error bridge batch route should fall back to existing update_price transport');
assert.equal(bridgeBatchServerErrorFallback.fetchCalls[0].url, 'https://bridge.test/update_price_batch');
assert.equal(bridgeBatchServerErrorFallback.fetchCalls[1].url, 'https://bridge.test/update_price');
assert.equal(bridgeBatchServerErrorFallback.rows[0].ok, true, 'server-error fallback should preserve successful result shape');

const bridgeBatchMissingResultsFallback = await runBridgeBatchMissingResultsFallbackHarness();
assert.equal(bridgeBatchMissingResultsFallback.fetchCalls.length, 2, '2xx bridge batch response without results should fall back to existing update_price transport');
assert.equal(bridgeBatchMissingResultsFallback.fetchCalls[0].url, 'https://bridge.test/update_price_batch');
assert.equal(bridgeBatchMissingResultsFallback.fetchCalls[1].url, 'https://bridge.test/update_price');
assert.equal(bridgeBatchMissingResultsFallback.rows[0].ok, true, 'missing-results fallback should preserve successful result shape');

const bridgeBatchParseFailureFallback = await runBridgeBatchMissingResultsFallbackHarness({ parseFailure: true });
assert.equal(bridgeBatchParseFailureFallback.fetchCalls.length, 2, 'unparseable 2xx bridge batch response should fall back to existing update_price transport');
assert.equal(bridgeBatchParseFailureFallback.fetchCalls[0].url, 'https://bridge.test/update_price_batch');
assert.equal(bridgeBatchParseFailureFallback.fetchCalls[1].url, 'https://bridge.test/update_price');
assert.equal(bridgeBatchParseFailureFallback.rows[0].ok, true, 'parse-failure fallback should preserve successful result shape');

const bridgeBatchChunking = await runBridgeBatchChunkingHarness();
assert.equal(bridgeBatchChunking.fetchCalls.length, 2, 'bridge batch transport must chunk more than 60 update rows');
assert.equal(bridgeBatchChunking.fetchCalls[0].body.updates.length, 60, 'first bridge batch chunk should stay within bridge limit');
assert.equal(bridgeBatchChunking.fetchCalls[1].body.updates.length, 1, 'second bridge batch chunk should carry the overflow row');
assert.equal(bridgeBatchChunking.rows.length, 61, 'chunked bridge batch responses should expand back to all payload results');

const bridgeBatchFailureAttribution = await runBridgeBatchFailureAttributionHarness();
assert.deepEqual(
  bridgeBatchFailureAttribution.rows.map(function(row) { return { sku: row.p.sku, ok: row.ok, errorMsg: row.errorMsg }; }),
  [
    { sku: 'SKU-OK', ok: true, errorMsg: null },
    { sku: 'SKU-FAIL', ok: false, errorMsg: 'model price rejected for model 2' },
  ],
  'bridge batch failure_list must mark only the matching model payload as failed',
);

const bridgeBatchLogisticsTarget = await runBridgeBatchLogisticsTargetHarness();
assert.deepEqual(bridgeBatchLogisticsTarget.singleRetrySkus, ['SKU-LOGISTICS'], 'bridge batch logistics failures should retry only the affected payload through the single update path');
assert.deepEqual(
  bridgeBatchLogisticsTarget.rows.map(function(row) { return { sku: row.p.sku, ok: row.ok, logId: row.json && row.json.log_id }; }),
  [
    { sku: 'SKU-OK', ok: true, logId: undefined },
    { sku: 'SKU-LOGISTICS', ok: true, logId: 'single-retry-SKU-LOGISTICS' },
  ],
  'bridge batch logistics retry should preserve the unaffected payload as successful and recover the affected payload',
);

const persistHarness = await runPersistResultsHarness();
assert.equal(persistHarness.result.okCount, 2, 'batched persistence should count successful Shopee region updates');
assert.deepEqual(persistHarness.result.errors, [], 'batched persistence should not report errors for successful rows');
assert.equal(
  persistHarness.dbCalls.filter((call) => call.table === 'product_shopee_listings' && call.method === 'upsert').length,
  1,
  'listing rows should be persisted with one bulk upsert instead of one upsert per region',
);
assert.equal(
  persistHarness.dbCalls.filter((call) => call.table === 'products' && call.method === 'update').length,
  1,
  'product cost should be persisted once per product even when multiple regions succeed',
);
assert.equal(persistHarness.cacheRows.length, 2, 'local listing cache should be updated for each successful region');
assert.equal(persistHarness.products[0].cost_krw, 14281, 'local product cache should reflect the synced product cost');

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
  await runTrustedVariantPreflightHarness(),
  {
    fetchCalls: 1,
    valid: [{ sku: 'T4-TEA-WEONF-SOL-EJ', region: 'SG', modelId: 9001, needsModel: true }],
    blocked: [],
    skipped: [],
  },
  'Mapped Shopee variant rows with shop_model_id must verify the remote model before update_price',
);

assert.deepEqual(
  await runStaleVariantMappingCorrectionHarness(),
  {
    fetchCalls: 1,
    valid: [{
      sku: 'D2-BOY-HOME-SWE-RANDOM',
      region: 'SG',
      modelId: 346113183681,
      priceList: [{ model_id: 346113183681, original_price: 18.26 }],
    }],
    blocked: [],
    skipped: [],
  },
  'Fresh but stale Shopee variant mappings must be corrected to the remote model_sku match before update_price',
);

assert.deepEqual(
  runCortisModelMatchHarness(),
  { sku: true, tierOnly: true, wrongTier: false, explicitIdentityMismatchBeatsStaleTier: false },
  'CORTIS-style option rows must match by SKU first and by phantom-first-tier fallback when SKU is unavailable',
);

const publishedCandidate = runPublishedCandidateHarness();
assert.equal(
  Number(publishedCandidate.activeShop.item_id),
  51050903742,
  'BR published_list hydration must prefer the active NORMAL BR shop item over the stale ITEM_UNLIST banned-shop item',
);
assert.equal(
  Number(publishedCandidate.noShopIndex.item_id),
  51050903742,
  'BR published_list hydration must prefer NORMAL status even when shop token indexing is unavailable',
);
assert.equal(
  Number(publishedCandidate.unlistedFallback.item_id),
  43322467300,
  'UNLIST published candidates remain a fallback when they are the only region candidate',
);

const lookupNameRequest = await runSkuLookupNameRequestHarness();
const lookupParams = new URL(lookupNameRequest.capturedUrl).searchParams;
assert.equal(lookupParams.get('sku'), 'V1-COR-COLOR-PHO-SCENE 1', 'Shopee lookup-sku must keep the selected model SKU');
assert.equal(lookupParams.get('regions'), 'BR', 'Shopee lookup-sku must keep region scoping');
assert.ok(
  lookupParams.getAll('item_name').includes('CORTIS'),
  'Shopee lookup-sku must send an artist/title keyword so CORTIS BR items can be recovered by item_name search',
);
assert.ok(
  lookupParams.getAll('item_name').includes('COLOR OUTSIDE'),
  'Shopee lookup-sku must send bracket-title keywords for item_name fallback matching',
);
assert.ok(
  lookupNameRequest.terms.length <= 6,
  'Shopee lookup-sku name-term expansion must stay bounded',
);

console.log('v2 Shopee bulk price stability checks passed');
