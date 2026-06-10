import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const fulfillment = readFileSync(join(root, 'supabase/functions/platform-publish/_shared/fulfillment.ts'), 'utf8');
const shopeeAdapter = readFileSync(join(root, 'supabase/functions/platform-publish/adapters/shopee.ts'), 'utf8');
const qoo10Adapter = readFileSync(join(root, 'supabase/functions/platform-publish/adapters/qoo10.ts'), 'utf8');
const ebayAdapter = readFileSync(join(root, 'supabase/functions/platform-publish/adapters/ebay.ts'), 'utf8');
const ebayBridge = readFileSync(join(root, 'supabase/functions/ebay-bridge/index.ts'), 'utf8');
const edgeEbayBridge = readFileSync(join(root, 'edge-functions/ebay-bridge/index.ts'), 'utf8');

for (const token of [
  'READY_STOCK_SHOPEE_DTS',
  'SG: 2',
  'TW: 1',
  'TH: 2',
  'MY: 2',
  'PH: 2',
  'BR: 3',
  'PRE_ORDER_SHOPEE_DTS = 60',
  "EBAY_READY_STOCK_FULFILLMENT_POLICY_ID = '233825118025'",
  "EBAY_PRE_ORDER_FULFILLMENT_POLICY_ID = '253030471025'",
  "QOO10_READY_STOCK_AVAILABLE_DATE_TYPE = '0'",
  "QOO10_READY_STOCK_AVAILABLE_DATE_VALUE = '3'",
  "QOO10_PRE_ORDER_AVAILABLE_DATE_TYPE = '2'",
  'resolveShopeeDaysToShip',
  'resolveQoo10AvailableDate',
  'resolveEbayFulfillmentPolicy',
]) {
  assert(fulfillment.includes(token), `fulfillment resolver missing ${token}`);
}

assert(
  shopeeAdapter.includes("import { resolveShopeeDaysToShip } from '../_shared/fulfillment.ts'")
    && shopeeAdapter.includes('days_to_ship: resolveShopeeDaysToShip(lifecycle_state, r)')
    && shopeeAdapter.includes('const days_to_ship = resolveShopeeDaysToShip(lifecycle_state, region)')
    && shopeeAdapter.includes('targets: [{ region, shop_id: Number(shopId), days_to_ship }]'),
  'Shopee adapter must derive DTS from lifecycle fulfillment rules for multi-region and single-region publish',
);

assert(
  !shopeeAdapter.includes('days_to_ship: dtsSection[r] ?? 2')
    && !shopeeAdapter.includes('is_pre_order ? 10 : 2'),
  'Shopee adapter must not fall back to stale ad hoc DTS defaults',
);

assert(
  qoo10Adapter.includes("import { resolveQoo10AvailableDate } from '../_shared/fulfillment.ts'")
    && qoo10Adapter.includes('return resolveQoo10AvailableDate(lifecycle, releaseDate)')
    && qoo10Adapter.includes("available.type === '2'")
    && qoo10Adapter.includes('Qoo10 release date is required as YYYY-MM-DD for pre-order listings'),
  'Qoo10 adapter must force lifecycle-derived AvailableDateType/Value and require PRE ORDER release dates',
);

assert(
  !qoo10Adapter.includes("if (!explicitType && lifecycle !== 'pre_order' && type === '2') type = '0';"),
  'Qoo10 adapter must not preserve the old stale stored preorder-type fallback',
);

assert(
  ebayAdapter.includes("import { resolveEbayFulfillmentPolicy } from '../_shared/fulfillment.ts'")
    && ebayAdapter.includes('const fulfillmentPolicy = resolveEbayFulfillmentPolicy(lifecycleState)')
    && ebayAdapter.includes('fulfillmentPolicyId: fulfillmentPolicy.fulfillmentPolicyId')
    && ebayAdapter.includes('fulfillmentPolicyName: fulfillmentPolicy.fulfillmentPolicyName'),
  'eBay adapter must pass the lifecycle-derived fulfillment policy into ebay-bridge publish payloads',
);

for (const [label, bridge] of [['Supabase', ebayBridge], ['edge mirror', edgeEbayBridge]]) {
  assert(bridge.includes('const EBAY_READY_STOCK_FULFILLMENT_POLICY_ID = "233825118025"'), `${label} eBay bridge missing READY STOCK policy`);
  assert(bridge.includes('const EBAY_PRE_ORDER_FULFILLMENT_POLICY_ID = "253030471025"'), `${label} eBay bridge missing PRE ORDER policy`);
}

console.log('platform fulfillment rule checks passed');
