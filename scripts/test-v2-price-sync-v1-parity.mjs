import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_COUNTRY_SETTINGS,
  PRICE_SYNC_REGIONS,
  calculateEbayPrice,
  calculateJoomPrice,
  calculateQoo10Price,
  calculateShopeePrice,
  calculateV1Listing,
  getQoo10ShippingFeeJpy,
  getShippingFee,
  normalizeCountrySettings,
  normalizeQoo10PriceEnding90,
  normalizeShopeeOriginalPrice,
} from '../v2/price-engine.js';

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNear(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

assert(
  JSON.stringify(PRICE_SYNC_REGIONS) === JSON.stringify(['SG', 'TW', 'TH', 'MY', 'PH', 'BR']),
  'Shopee operating regions must match V1 order, including BR',
);

assertNear(getShippingFee('SG', 100), 0.8, 0.000001, 'SG shipping fee must match V1');
assertNear(getShippingFee('BR', 100), 11.2, 0.000001, 'BR shipping fee must match V1');
assertNear(getShippingFee('TH', 450), 99, 0.000001, 'TH shipping fee must match V1');

const br = calculateV1Listing({
  costKrw: 10000,
  weightG: 100,
  region: 'BR',
  countrySettings: DEFAULT_COUNTRY_SETTINGS.BR,
});
assertNear(br.listing, 62.90026263145232, 0.000000001, 'BR raw listing must match V1 formula');
assertNear(br.sales, 62.90026263145232, 0.000000001, 'BR sales price must match V1 formula');

const th = calculateShopeePrice({
  costKrw: 25000,
  weightG: 450,
  region: 'TH',
  countrySettings: DEFAULT_COUNTRY_SETTINGS.TH,
});
assertNear(th.originalPrice, 1040, 0.000001, 'TH Shopee price must round to integer');

const brShopee = calculateShopeePrice({
  costKrw: 10350,
  weightG: 80,
  region: 'BR',
  countrySettings: DEFAULT_COUNTRY_SETTINGS.BR,
});
assertNear(brShopee.originalPrice, 61.33, 0.000001, 'BR Shopee price must keep 2 decimals');

const brNorm = normalizeShopeeOriginalPrice('BR', 57.514);
assert(brNorm.ok && brNorm.value === 57.51 && brNorm.decimals === 2, 'BR normalization must use 2 decimals');
const twNorm = normalizeShopeeOriginalPrice('TW', 459.4);
assert(twNorm.ok && twNorm.value === 459 && twNorm.decimals === 0, 'TW normalization must use integer prices');

const joomV1 = calculateV1Listing({
  costKrw: 10000,
  weightG: 100,
  region: 'JM',
  countrySettings: DEFAULT_COUNTRY_SETTINGS.JM,
});
assertNear(joomV1.listing, 7.749360613810742, 0.000000001, 'V1 JM listing must use dedicated Joom fee row');

const joom = calculateJoomPrice({
  costKrw: 10000,
  weightG: 100,
  countrySettings: DEFAULT_COUNTRY_SETTINGS.JM,
});
assertNear(joom.joomPrice, 7.75, 0.000001, 'Joom price must follow V1 JM fee row');

const ebayExPartial = normalizeCountrySettings({
  country_code: 'EX',
  exchange_rate: 1380,
  sales_fee: 15.3,
  pg_fee: 1.45,
}, 'EX');
assertNear(ebayExPartial.gst, 0, 0.000001, 'eBay EX must not inherit SG GST when EX fields are partial');
assertNear(ebayExPartial.settlementFee, 0, 0.000001, 'eBay EX must not inherit SG settlement fee when EX fields are partial');
assertNear(ebayExPartial.otherFee, 0, 0.000001, 'eBay EX must not inherit SG other fee when EX fields are partial');
assertNear(ebayExPartial.fixedServiceFee, 0.40, 0.000001, 'eBay EX missing fixed fee must fall back to the tab default');
const ebayPartial = calculateEbayPrice({
  costKrw: 13127,
  weightG: 150,
  countrySettings: ebayExPartial,
});
const ebayDefault = calculateEbayPrice({
  costKrw: 13127,
  weightG: 150,
  countrySettings: DEFAULT_COUNTRY_SETTINGS.EX,
});
assert(ebayPartial.ok && ebayDefault.ok, 'eBay EX price must calculate from partial and default settings');
assertNear(ebayPartial.ebayPrice, ebayDefault.ebayPrice, 0.000001, 'eBay EX partial settings must use the shared EX defaults');
const ebay1460 = calculateEbayPrice({
  costKrw: 13127,
  weightG: 150,
  countrySettings: { ...DEFAULT_COUNTRY_SETTINGS.EX, exchange_rate: 1460 },
});
assert(
  ebay1460.ok && ebay1460.ebayPrice !== ebayDefault.ebayPrice && ebay1460.ebayPrice < ebayDefault.ebayPrice,
  'eBay EX USD price must respond to an exchange-rate change such as 1380 -> 1460',
);

const qoo10 = calculateQoo10Price({
  costKrw: 10000,
  countrySettings: DEFAULT_COUNTRY_SETTINGS.Q10,
});
assert(qoo10.ok && qoo10.qoo10Price === 1490, 'Qoo10 price must use exchange 9.1, total fee 14%, target 10% sales-margin, and end in 90');
assertNear(qoo10.totalFeePct, 14, 0.000001, 'Qoo10 total fee must combine category, preorder, and Megawari fees');
assertNear(qoo10.targetMarginPct, 10, 0.000001, 'Qoo10 target margin must default to 10% of sale price');
assert(normalizeQoo10PriceEnding90(2288) === 2290, 'Qoo10 price 2288 must normalize to 2290');
assert(normalizeQoo10PriceEnding90(2290) === 2290, 'Qoo10 price already ending in 90 must stay unchanged');
assert(normalizeQoo10PriceEnding90(2291) === 2390, 'Qoo10 price above a 90 ending must move to the next 90 ending');

const qoo10NotMyNameAverage = calculateQoo10Price({
  costKrw: 20695,
  sourcingKrw: 15919,
  weightG: 380,
  countrySettings: DEFAULT_COUNTRY_SETTINGS.Q10,
});
assert(qoo10NotMyNameAverage.ok && qoo10NotMyNameAverage.qoo10Price === 3090, 'Qoo10 price must use sourcing_price first so NOT MY NAME aligns to the 3,090 JPY peer average');
assertNear(qoo10NotMyNameAverage.shippingFeeJpy, 590, 0.000001, 'Qoo10 NOT MY NAME 380g shipping fee must use the 500g bracket');

const qoo10WithShipping = calculateQoo10Price({
  costKrw: 10000,
  weightG: 100,
  countrySettings: DEFAULT_COUNTRY_SETTINGS.Q10,
});
assert(qoo10WithShipping.ok && qoo10WithShipping.qoo10Price === 2090, 'Qoo10 price must include shipping, 10% sales-margin, and end in 90');
assertNear(qoo10WithShipping.shippingFeeJpy, 450, 0.000001, 'Qoo10 100g shipping fee must be 450 JPY');
assertNear(getQoo10ShippingFeeJpy(100), 450, 0.000001, 'Qoo10 shipping 0-100g must be 450 JPY');
assertNear(getQoo10ShippingFeeJpy(101), 525, 0.000001, 'Qoo10 shipping over 100g must move to 250g bracket');
assertNear(getQoo10ShippingFeeJpy(250), 525, 0.000001, 'Qoo10 shipping 250g must be inclusive');
assertNear(getQoo10ShippingFeeJpy(251), 590, 0.000001, 'Qoo10 shipping over 250g must move to 500g bracket');
assertNear(getQoo10ShippingFeeJpy(750), 680, 0.000001, 'Qoo10 shipping 750g must be inclusive');
assertNear(getQoo10ShippingFeeJpy(751), 720, 0.000001, 'Qoo10 shipping over 750g must move to 1000g bracket');
assertNear(getQoo10ShippingFeeJpy(2000), 910, 0.000001, 'Qoo10 shipping 2000g must be inclusive');
assertNear(getQoo10ShippingFeeJpy(2001), 910, 0.000001, 'Qoo10 shipping over known brackets should keep the last known fee until configured');

const v2 = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const shopeeBridge = readFileSync(join(root, 'supabase', 'functions', 'shopee-bridge', 'index.ts'), 'utf8');
assert(v2.includes("from '/v2/price-engine.js'"), 'V2 must import the shared V1 parity price engine from the deployed /v2 path');
assert(v2.includes("bridgeUrl: SHOPEE_BRIDGE + '/update_price'"), 'V2 Shopee sync must use shop-level update_price');
assert(!v2.includes("bridgeUrl: SHOPEE_BRIDGE + '/update_global_price'"), 'V2 price sync must not build global update_price payloads');
assert(v2.includes('shop_item_id,shop_model_id,global_item_id,global_model_id,status,published_at,last_synced_price'), 'V2 listings fetch must carry Global Product ids so price sync can hydrate shop mappings');
assert(v2.includes("countrySettings: catCountrySettings('JM')"), 'V2 Joom price preview must use JM country_settings fee row');
assert(v2.includes("countrySettings: catCountrySettings('Q10')"), 'V2 Qoo10 price preview must use Q10 country_settings fee row');
assert(v2.includes('sourcingKrw: Number(row.sourcing_price || 0)'), 'V2 Qoo10 modal prices must pass product sourcing_price into the Qoo10 margin model');
assert(v2.includes('weightG: Number(row.weight_g || 0)'), 'V2 Qoo10 modal prices must pass product weight into the Qoo10 shipping table');
assert(v2.includes('const newPrice = catComputeQoo10Price(product, effectiveCost, catEffectiveWeight(product));'), 'V2 Qoo10 price preview must honor inline sourcing/cost/weight edits');
assert(v2.includes("const joomSettings = catCountrySettings('JM')"), 'V2 Joom bulk sync must load JM country_settings fee row');
assert(v2.includes("JOOM_BRIDGE + '/lookup-sku?sku='"), 'V2 Joom sync must resolve SKU before update-price');
assert(v2.includes("JOOM_BRIDGE + '/update-price'"), 'V2 Joom sync must call update-price');
assert(v2.includes("countrySettings: catCountrySettings('EX')"), 'V2 eBay price preview must use the EX country_settings fee row');
assert(v2.includes("_v2EbayExCountryCache = normalizeCountrySettings(data, 'EX')"), 'V2 eBay publish must normalize the EX row through the shared price engine');
assert(v2.includes('const ebayMapping = catEbayMapping(product);'), 'V2 eBay sync must resolve the current eBay mapping before live update');
assert(v2.includes('if (!ebayMapping.isMapped)'), 'V2 eBay sync must require a mapped listing before live update');
assert(v2.includes('if (!ebayMapping.offerId && !ebayMapping.itemId)'), 'V2 eBay sync must require an offer or item mapping before live update');
assert(v2.includes('productId: product.id'), 'V2 eBay sync must send productId so the bridge can run server-side price guards');
assert(v2.includes('function _v2LoadJoomCountry()'), 'V2 Joom publish must load the JM country_settings fee row');
assert(v2.includes('const listing = _v2JoomCalcListing(costKrw, weightG, joomCountry);'), 'V2 Joom publish variants must use the JM fee formula');
assert(v2.includes("'JM'") && v2.includes("Joom (Global)"), 'V2 fee settings must expose the Joom global fee row');
assert(v2.includes("'Q10'") && v2.includes("Qoo10 JP"), 'V2 fee settings must expose the Qoo10 JP fee row');
assert(v2.includes("chip.className = 'cat-market-chip' + (isActive ? ' active' : '')"), 'Shopee markets must render as compact chips instead of loose checkboxes');
assert(!v2.includes('id="cat-platform-tabs"'), 'Shopee price sync must not expose a generic Platform selector');
assert(!v2.includes('class="cat-platform-row"'), 'Shopee price sync must remove the Platform selector row entirely');
assert(v2.includes('main_image,shopee_option_image_url'), 'Shopee price sync product fetch must include saved Shopee/master image URLs');
assert(v2.includes('function catShopeeProductThumb'), 'Shopee price sync product cell must render a Shopee image thumbnail');
assert(v2.includes("mode === 'option'"), 'Shopee price sync thumbnails must distinguish representative rows from option rows');
assert(v2.includes("String(product?.main_image || product?.shopee_option_image_url || '').trim()"), 'Shopee price sync representative rows must match the Shopee tab thumbnail priority');
assert(v2.includes("String(product?.shopee_option_image_url || product?.main_image || '').trim()"), 'Shopee price sync expanded option rows may use option images first');
assert(v2.includes("thumbMode: isGroupChild ? 'option' : 'representative'"), 'Shopee price sync must use representative thumbnails for group/standalone rows and option thumbnails only for expanded options');
assert(v2.includes('id="cat-selected-count"'), 'Shopee price sync toolbar must show the selected row count near the action buttons');
assert(v2.includes('id="cat-dry-run-btn"'), 'Shopee price sync toolbar must expose a dedicated dry-run action');
assert(v2.includes('function catCurrentColCount()'), 'Shopee price sync loading/empty rows must use the compact 6-column table shape');
assert(v2.includes('function catBindSelectAll()'), 'Shopee price sync must re-bind select-all after dynamic header replacement');
assert(v2.includes('function catShopeeMarketsForProduct'), 'Shopee price sync must render compact market cards per product row');
assert(v2.includes('data-cat-markets-cell="1"'), 'Shopee price sync market preview must be replaceable after cost/weight edits');
assert(v2.includes("['[data-cat-markets-cell]', '[data-cat-sync-note]']"), 'Shopee cost/weight edits must refresh the compact Markets and Sync Note cells');
assert(v2.includes('class="cat-sourcing-input"') && v2.includes('data-cat-sourcing-pid'), 'Shopee KRW Base cell must keep 도매가 editing wired');
assert(v2.includes('class="cat-cost-input') && v2.includes('data-cat-cost-pid'), 'Shopee KRW Base cell must keep Cost editing wired');
assert(v2.includes('class="cat-weight-input mono"') && v2.includes('data-cat-weight-pid'), 'Shopee KRW Base cell must keep weight editing wired');
assert(v2.includes('function catFlushSelectedInlineEdits'), 'Shopee live sync must flush selected row cost/weight inputs before building payloads');
assert(/await catFlushSelectedInlineEdits\(\{\s*persistWeight:\s*false\s*\}\);[\s\S]*const \{ payloads \} = catBuildPriceSyncPayloads\(\)/.test(v2), 'Shopee live sync must read pending inline edits before empty-target validation without saving weight');
assert(v2.includes('catSuppressNextWeightBlurSave') && v2.includes("syncBtn.addEventListener('pointerdown', suppressWeightBlurSaveForSyncClick)"), 'Shopee sync button must suppress blur-triggered weight saves');
assert(/const targetRegions = CAT_REGIONS\.filter\(function\(r\) \{ return _catRegionVisible\.has\(r\); \}\)/.test(v2), 'Shopee price payload builder must honor active region chips for region-scoped 10-20 row batches');
assert(v2.includes('placeholder="아티스트 / SKU / 상품명 / 옵션 검색"'), 'Price sync search placeholder must make artist keyword search explicit');
assert(!v2.includes('id="login-github"'), 'V2 auth panel must not expose GitHub OAuth while the Supabase provider is disabled');
assert(!v2.includes("provider: 'github'"), 'V2 must not call Supabase GitHub OAuth while the provider is disabled');
assert(v2.includes('function catEnsureSelectedShopeeListings'), 'Shopee price sync must auto-resolve GLOBAL published_list mappings into shop listings before payload build');
assert(v2.includes("SHOPEE_BRIDGE + '/published_list?'"), 'Shopee price sync auto-resolution must use published_list from the global item id');
assert(v2.includes("SHOPEE_BRIDGE + '/lookup-sku?'"), 'Shopee price sync auto-resolution must fall back to SKU lookup when global_item_id is absent');
assert(v2.includes('price_sync_sku_lookup'), 'Shopee price sync SKU lookup fallback must mark listing rows with an audit source');
assert(v2.includes('function catProductGlobalModelId'), 'Shopee price sync must recover global_model_id from product/listing rows');
assert(v2.includes('global_model_id: globalModelId ||'), 'Shopee price sync hydrated mappings must preserve global_model_id for later exact model recovery');
assert(shopeeBridge.includes('"lookup-sku"'), 'Shopee bridge lookup-sku must be a public read-only action for browser mapping recovery');
assert(shopeeBridge.includes("if (action === 'lookup-sku' && req.method === 'GET')"), 'Shopee bridge must implement lookup-sku for price sync mapping recovery');
assert(shopeeBridge.includes('region_hits') && shopeeBridge.includes('region_results'), 'Shopee lookup-sku must return frontend-compatible region hit shapes');
assert(shopeeBridge.includes("source: 'product_shopee_listings'"), 'Shopee lookup-sku must use DB mappings before expensive remote scans');
assert(shopeeBridge.includes("'remote_list_items'"), 'Shopee lookup-sku must retain an explicit remote scan fallback');
assert(shopeeBridge.includes("if (action === 'update_item_logistics' && req.method === 'POST')"), 'Shopee bridge must expose explicit item logistics updates for price-limit recovery');
assert(shopeeBridge.includes("shopApiCall(r, '/api/v2/product/update_item'"), 'Shopee item logistics recovery must use product.update_item per local API docs');
assert(v2.includes("SHOPEE_BRIDGE + '/tokens?region=SG&account_key='"), 'Shopee published_list auto-resolution must map shop_id back to region using token shop ids');
assert(v2.includes('function catShopeePublishedCandidateScore'), 'Shopee published_list auto-resolution must rank candidates before choosing a shop item');
assert(v2.includes('catShopeePublishedRegionMatchRank'), 'Shopee published_list auto-resolution must prefer the active region shop_id over stale same-region shop rows');
assert(v2.includes('catShopeePublishedStatusRank'), 'Shopee published_list auto-resolution must prefer NORMAL/status=1 rows over ITEM_UNLIST/status=8 rows');
assert(v2.includes('function catShopeeLookupNameTerms'), 'Shopee SKU fallback must send bounded product-name terms for item_name recovery');
assert(/catFetchShopeeSkuLookupHits\(sku,\s*targetRegions,\s*product\)/.test(v2), 'Shopee SKU fallback must pass the selected product into lookup-sku for item_name recovery');
assert(v2.includes('function catProductNeedsShopeeModel'), 'Variant/global-model rows must require shop_model_id during auto-resolution');
assert(v2.includes('function catShopeeTierIndexMatches') && v2.includes('variationTierIndex'), 'Shopee shop model matching must fall back to tier_index when SKU/name differ');
assert(/await catEnsureSelectedShopeeListings\(\);[\s\S]*const \{ payloads \} = catBuildPriceSyncPayloads\(\)/.test(v2), 'Shopee live sync must hydrate shop listings before empty-target validation');
assert(!/Shopee 가격을 실동기화합니다\.[\s\S]{0,200}confirm\(/.test(v2), 'V2 Shopee sync should match V1 one-click live update flow without an extra confirm blocker');

console.log('v2 price sync V1 parity checks passed');
