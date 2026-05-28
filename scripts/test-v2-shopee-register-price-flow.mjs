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

for (const token of [
  'const RSH_SETTLEMENT_MULTIPLIER = 1.30',
  'sourcing_price',
  'rshSettlementFromSourcing',
  'calculateShopeePrice',
  'rshBuildSingleRegionPrices',
  'region_prices: rshBuildSingleRegionPrices',
  'modelForRegion(region)',
  'price: calc.originalPrice',
]) {
  assert(rshBlock.includes(token), `RSH price flow missing token: ${token}`);
}

assert(
  rshBlock.includes('targetPrice = Number.isFinite(computedPrice) && computedPrice > 0 ? computedPrice : cost_krw')
    || shopeeAdapter.includes('targetPrice = Number.isFinite(computedPrice) && computedPrice > 0 ? computedPrice : cost_krw'),
  'single-product platform publish must accept UI-computed per-region prices',
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
]) {
  assert(dispatcher.includes(token), `dispatcher missing token: ${token}`);
}

for (const token of [
  'const regionPrices',
  'price: targetPrice',
]) {
  assert(shopeeAdapter.includes(token), `Shopee adapter missing token: ${token}`);
}

for (const token of [
  'normalizeVariation(target.variation || body.variation)',
  'item.tier_variation = publishVariation.tier_variation',
  'item.model = buildPublishModels(publishVariation, price)',
]) {
  assert(publishItemBlock.includes(token), `register_cbsc publish payload missing token: ${token}`);
}

console.log('v2 Shopee register price flow checks passed');
