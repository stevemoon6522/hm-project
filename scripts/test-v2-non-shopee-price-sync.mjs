import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  assert(from >= 0, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert(to > from, `missing end marker after ${start}: ${end}`);
  return source.slice(from, to);
}

const v2 = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const qoo10Bridge = readFileSync(join(root, 'supabase', 'functions', 'qoo10-bridge', 'index.ts'), 'utf8');
const ebayBridge = readFileSync(join(root, 'supabase', 'functions', 'ebay-bridge', 'index.ts'), 'utf8');
const edgeEbayBridge = readFileSync(join(root, 'edge-functions', 'ebay-bridge', 'index.ts'), 'utf8');

const ebaySync = sliceBetween(v2, 'async function catExecuteEbaySync()', '  // ── Platform + Shopee market controls');
assert(
  /await catFlushPendingFeeSettings\(\);\s*await catReloadCountrySettings\(\);\s*applyAndRenderCatalog\(\);/.test(ebaySync),
  'eBay sync must flush pending fee-setting autosaves and reload country_settings before computing USD prices',
);
assert(
  /catPersistProductCost\(product\.id,\s*newCost,\s*now\)[\s\S]*fetch\(EBAY_BRIDGE \+ '\/update-price'/.test(ebaySync),
  'eBay sync must persist the edited settlement price before /update-price so the server-side price guard recomputes from the same cost',
);
assert(
  !/fetch\(EBAY_BRIDGE \+ '\/update-price'[\s\S]*catPersistProductCost\(product\.id,\s*newCost,\s*now\)/.test(ebaySync),
  'eBay sync must not wait until after /update-price to persist cost_krw',
);
assert(v2.includes('platform_listings') && v2.includes('external_variant_id') && v2.includes('catAttachPlatformListingsToProducts'), 'price sync catalog must load platform_listings mappings, including variant identity');
assert(v2.includes('function catEbayMapping(product)') && v2.includes('catEbayMappedSku(product)'), 'eBay price sync must resolve mapping through platform_listings, not only products.ebay_* columns');
assert(ebaySync.includes('const ebayMapping = catEbayMapping(product);'), 'eBay price sync must use the unified mapping resolver');
assert(ebaySync.includes('sku: sku,') && ebaySync.includes('itemId: ebayMapping.itemId || undefined') && ebaySync.includes('legacyVariantSku: ebayMapping.legacyVariantSku || undefined'), 'eBay price sync must send legacy item id and variation SKU to update-price');
assert(v2.includes('const legacyVariantSku = variantLooksLikeSku ? externalVariantId : (platformSku || sku);'), 'SKU-backed single eBay listings must use platform_listings.external_sku as the legacy Trading SKU when external_variant_id is absent');
assert(!ebaySync.includes("product.ebay_sku;\n        if (!sku)"), 'eBay price sync must not require products.ebay_sku when platform_listings.external_sku is mapped');
assert(!ebaySync.includes("ebayStatus !== 'PUBLISHED' || !product.ebay_offer_id"), 'eBay price sync must not reject mapped platform_listings rows for missing products.ebay_offer_id');
const platformEditFlow = sliceBetween(v2, 'async function platformOpenEditFlow(platform, productIds = [])', '  async function platformSyncSelected(platform');
assert(platformEditFlow.includes('_catCache = null') && platformEditFlow.includes('await renderCatalogView(true)'), 'platform price edit flow must bypass the price-sync cache so new eBay mappings show immediately');

const feeFlush = sliceBetween(v2, 'async function feeFlushInner()', '    async function feeWriteRow(code)');
assert(feeFlush.includes('feeApplyRowsToPriceSyncCaches(toSave);'), 'fee saves must apply saved country_settings rows to the price-sync settings map');
assert(feeFlush.includes('await feeRefreshOpenPriceSyncPreview(toSave);'), 'fee saves must immediately re-render an open price-sync table');
const feeInvalidation = sliceBetween(v2, 'function feeInvalidateCaches()', '    async function feeResetActive()');
assert(!feeInvalidation.includes('_catCache = null'), 'fee invalidation must not drop the rendered price-sync cache before preview refresh');
assert(!feeInvalidation.includes('_catCountrySettingsByRegion = new Map()'), 'fee invalidation must not clear the price-sync country_settings map and fall back to default EX exchange rates');
assert(v2.includes('async function catReloadCountrySettings()'), 'price sync must share a reload helper for country_settings');
assert(v2.includes('function catApplyCountrySettingsRows(rows)'), 'fee saves must be able to patch country_settings in the price-sync cache without a full product reload');
assert(v2.includes('_feeSettingsFlushNow = async function()'), 'fee settings must expose a pending autosave flush for live sync actions');

for (const [label, source] of [['Supabase', ebayBridge], ['edge mirror', edgeEbayBridge]]) {
  assert(source.includes('ReviseInventoryStatus') && source.includes('legacy_trading_price_update'), `${label} eBay bridge must support Trading ReviseInventoryStatus for legacy mapped variation price updates`);
  assert(source.includes('platform_listings') && source.includes('external_variant_id'), `${label} eBay price guard must accept platform_listings mapping identity`);
  assert(source.includes('const legacyVariantSku = platformSku || productSku;'), `${label} eBay price guard must support SKU-backed single fixed-price listings through platform_listings.external_sku`);
  assert(source.includes('if (legacyItemId && legacyVariantSku) {'), `${label} eBay bridge must route ItemID + SKU legacy listings to ReviseInventoryStatus when no REST offer is found`);
}

const joomSync = sliceBetween(v2, 'async function catExecuteJoomSync()', '  async function catExecuteEbaySync()');
assert(
  /const newCost = productId in pendingCostEdits \? pendingCostEdits\[productId\] : Number\(product\.cost_krw \|\| 0\)/.test(joomSync),
  'Joom sync must compute price from the edited settlement price when one is pending',
);
assert(
  /JOOM_BRIDGE \+ '\/update-price'[\s\S]*price:\s*calc\.joomPrice/.test(joomSync),
  'Joom sync must send the newly computed Joom price to update-price',
);

assert(v2.includes('async function catExecuteQoo10Sync()'), 'V2 must implement a Qoo10 live price sync function');
assert(
  /case 'qoo10':\s*catExecuteQoo10Sync\(\);\s*break;/.test(v2),
  'Qoo10 tab sync button must route to catExecuteQoo10Sync, not a preview-only toast',
);
assert(v2.includes("QOO10_BRIDGE + '/lookup-sku?sku='"), 'Qoo10 sync must resolve the live goods_no by SKU before price update');
assert(v2.includes("QOO10_BRIDGE + '/set-price'"), 'Qoo10 sync must call the Qoo10 set-price bridge route');
assert(v2.includes('qoo10_last_synced_price'), 'V2 must cache Qoo10 last synced price for current/new delta display');

const setPrice = sliceBetween(qoo10Bridge, 'async function handleSetPrice', 'async function handleDeleteListing');
assert(setPrice.includes('10024-SetGoodsPriceQty.md'), 'Qoo10 set-price handler must cite the local SetGoodsPriceQty API doc');
assert(setPrice.includes('ItemsOrder.SetGoodsPriceQty'), 'Qoo10 set-price handler must call ItemsOrder.SetGoodsPriceQty');
assert(/Price:\s*String\(priceJpy\)/.test(setPrice), 'Qoo10 set-price handler must send Price from the computed JPY value');
assert(
  !/qoo10Fetch\("ItemsOrder\.SetGoodsPriceQty"[\s\S]{0,400}\bQty\s*:/.test(setPrice),
  'Qoo10 set-price handler must omit Qty so price sync does not change stock',
);
assert(
  /if \(action === "set-price" && req\.method === "POST"\)/.test(qoo10Bridge),
  'Qoo10 bridge router must expose POST /set-price',
);

console.log('non-Shopee price sync regression checks passed');
