import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sliceBetween(source, start, end) {
  const s = source.indexOf(start);
  assert(s >= 0, `missing start token: ${start}`);
  const e = source.indexOf(end, s);
  assert(e > s, `missing end token after ${start}`);
  return source.slice(s, e);
}

const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const bridge = readFileSync(join(root, 'supabase', 'functions', 'shopee-bridge', 'index.ts'), 'utf8');
const dispatcher = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'index.ts'), 'utf8');
const shopeeAdapter = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'shopee.ts'), 'utf8');

const rshBlock = sliceBetween(html, 'PHASE B', '// P2-1: Legacy modal URL flag');
const mrBlock = sliceBetween(html, 'const MR_MASTER_ONLY_MODE', "// country_settings 'EX' row");
const publishItemBlock = sliceBetween(bridge, 'function buildPublishItemPayload', 'function isPublishPending');
const registerCbscBlock = sliceBetween(bridge, "if (action === 'register_cbsc' && req.method === 'POST')", "if (action === 'item_info')");

for (const token of [
  'const RSH_SETTLEMENT_MULTIPLIER = 1.30',
  'sourcing_price',
  'rshSettlementFromSourcing',
  'calculateShopeePrice',
  'rshBuildSingleRegionPrices',
  'rshMapWithConcurrency',
  'const uploadedByRegion = await rshMapWithConcurrency(targetRegions, 3',
  'region_prices: rshBuildSingleRegionPrices',
  'modelForRegion(region)',
  'price: calc.originalPrice',
]) {
  assert(rshBlock.includes(token), `RSH price flow missing token: ${token}`);
}

assert(
  shopeeAdapter.includes('const missingRegionPrices = regions.filter')
    && shopeeAdapter.includes('Shopee registration requires dashboard-computed region_prices')
    && shopeeAdapter.includes('const targetPrice = Number(regionPrices[r])'),
  'single-product platform publish must require UI-computed per-region prices and never fall back to KRW cost',
);

for (const token of [
  'r.sourcing_price',
  'r.cost_krw = rshSettlementFromSourcing(r.sourcing_price)',
  '도매가(KRW)',
  '정산가(KRW)',
  'sourcing_price: Number(r._sourcing_price',
]) {
  assert(mrBlock.includes(token), `master register cost flow missing token: ${token}`);
}

for (const token of [
  'region_prices: (body as any).region_prices || {}',
  "shopee_description: (body as any).shopee_description || ''",
  "shopee_product_name: (body as any).shopee_product_name || ''",
  'stock_override: (body as any).stock_override',
  'shopee_extra_image_ids',
]) {
  assert(dispatcher.includes(token), `dispatcher missing token: ${token}`);
}

for (const token of [
  'const SHOPEE_MAX_PRODUCT_IMAGES = 9',
  'const regionPrices',
  'const baseImageIds',
  'master.shopee_extra_image_ids',
  'const registerName',
  '(ctx as any).shopee_product_name',
  'name: registerName',
  'image_id_list: baseImageIds.length ? baseImageIds : undefined',
  'price: targetPrice',
  'const registerDescription',
  'shopeeSellerCenterDescription',
  'const registerStock',
  '(ctx as any).stock_override',
  'stock: registerStock',
  'description: registerDescription || registerName || master.sku',
]) {
  assert(shopeeAdapter.includes(token), `Shopee adapter missing token: ${token}`);
}

assert(
  shopeeAdapter.includes('[Official & Authentic K-POP Album]')
    && shopeeAdapter.includes('[Contents]')
    && shopeeAdapter.includes('[COD Policy]')
    && !shopeeAdapter.includes('|| master.shopee_description')
    && !shopeeAdapter.includes('|| master.description'),
  'Shopee adapter must generate the API-safe plain Seller Center description instead of reusing stored HTML descriptions',
);

assert(
  !bridge.includes("requestPayload.description !== undefined && !flags.probe_item_name_ok"),
  'Shopee global description update must not be blocked by the item-name probe gate',
);

for (const token of [
  'function rshCanonicalShopeeProductName',
  'shopee_product_name: shopeeProductName',
  'rshExtractRegionResults(dispatchResult)',
  'await rshFetchShopeeListingResults(_rsh.productId, activeRegions)',
  ".from('product_shopee_listings')",
]) {
  assert(rshBlock.includes(token), `single-product Shopee result/name flow missing token: ${token}`);
}

for (const token of [
  'normalizeVariation(target.variation || body.variation)',
  'buildStandardiseTierVariation(publishVariation.tier_variation)',
  'item.standardise_tier_variation = standardiseTierVariation',
  'item.model = buildPublishModels(publishVariation, price)',
  'const description = sanitizeShopeePlainTextDescription(target.description ?? body.description)',
  'description,',
]) {
  assert(publishItemBlock.includes(token), `register_cbsc publish payload missing token: ${token}`);
}

assert(
  bridge.includes('function sanitizeShopeePlainTextDescription')
    && bridge.includes('description: sanitizeShopeePlainTextDescription(body.description)'),
  'register_cbsc global/publish descriptions must be normalized to plain text before calling Shopee',
);

assert(
  bridge.includes('async function finalizePublishOutcomeAfterSuccess')
    && bridge.includes("outcome.stage = 'post_publish_price_sync'")
    && registerCbscBlock.includes('await finalizePublishOutcomeAfterSuccess(outcome, targetRegion, target, body, accountKey)'),
  'register_cbsc must sync shop prices after normal publish success and fail the region when price sync cannot be confirmed',
);

for (const token of [
  'const READY_STOCK_GLOBAL_DTS = 1',
  'const PRE_ORDER_GLOBAL_DTS = 10',
  'function resolveGlobalProductDts',
  'pre_order: { days_to_ship: resolveGlobalProductDts(body) }',
  'days_to_ship: resolveGlobalProductDts(body)',
  "'update_shop_item_description'",
  '/api/v2/product/update_item',
  'sent_description_length',
]) {
  assert(bridge.includes(token), `Global Product DTS policy missing token: ${token}`);
}
assert(
  !registerCbscBlock.includes('clampReadyStockDts(targetInputs[0]?.days_to_ship'),
  'register_cbsc must not derive Global Product ready-stock DTS from the first region target',
);

assert(
  registerCbscBlock.includes('await mapWithConcurrency(targetInputs, 2, async (target: any) => {')
    && registerCbscBlock.includes('/api/v2/global_product/create_publish_task')
    && registerCbscBlock.includes('/api/v2/global_product/get_publish_task_result'),
  'register_cbsc must publish target regions with bounded concurrency and still poll publish task results',
);

console.log('v2 Shopee register price flow checks passed');
