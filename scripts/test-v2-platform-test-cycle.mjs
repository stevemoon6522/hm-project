import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const targetPath = join(root, 'scripts', 'platform-test-target.json');
const cyclePath = join(root, 'scripts', 'platform-test-cycle.mjs');
const docsPath = join(root, 'docs', 'platform-test-cycle.md');
const ebayBridge = readFileSync(join(root, 'supabase', 'functions', 'ebay-bridge', 'index.ts'), 'utf8');
const ebayMirror = readFileSync(join(root, 'edge-functions', 'ebay-bridge', 'index.ts'), 'utf8');
const joomBridge = readFileSync(join(root, 'supabase', 'functions', 'joom-bridge', 'index.ts'), 'utf8');
const joomMirror = readFileSync(join(root, 'edge-functions', 'joom-bridge', 'index.ts'), 'utf8');
const qoo10Bridge = readFileSync(join(root, 'supabase', 'functions', 'qoo10-bridge', 'index.ts'), 'utf8');
const shopeeBridge = readFileSync(join(root, 'supabase', 'functions', 'shopee-bridge', 'index.ts'), 'utf8');
const shopeeMirror = readFileSync(join(root, 'edge-functions', 'shopee-bridge', 'index.ts'), 'utf8');
const sharedAuth = readFileSync(join(root, 'supabase', 'functions', '_shared', 'auth.ts'), 'utf8');
const cycle = readFileSync(cyclePath, 'utf8');
const docs = readFileSync(docsPath, 'utf8');
const hash = (s) => createHash('sha256').update(s).digest('hex');

assert.equal(existsSync(targetPath), true, 'canonical platform test target JSON must exist');
const target = JSON.parse(readFileSync(targetPath, 'utf8'));
assert.equal(target.product_id, 'f8115948-0f45-40f1-99d8-30b9fc7fb4d9', 'test target must pin the JENNIE Ruby product id');
assert.equal(target.sku, 'F4-JEN-RUBY-DIG-', 'test target must pin the JENNIE Ruby SKU');
assert(target.marketplaces.includes('ebay') && target.marketplaces.includes('joom') && target.marketplaces.includes('shopee') && target.marketplaces.includes('qoo10'), 'test target must cover all live registration platforms');

assert.equal(hash(ebayBridge), hash(ebayMirror), 'eBay bridge mirror must match supabase function source');
assert.equal(hash(joomBridge), hash(joomMirror), 'Joom bridge mirror must match supabase function source');
assert.equal(hash(shopeeBridge), hash(shopeeMirror), 'Shopee bridge mirror must match supabase function source');

assert.match(
  sharedAuth,
  /SUPABASE_SERVICE_ROLE_KEY[\s\S]*payload\.role === ["']service_role["'][\s\S]*token === SUPABASE_SERVICE_ROLE_KEY/,
  'Edge auth helper must allow exact service-role bearer tokens for server-side operator smoke tests',
);
assert.match(
  sharedAuth,
  /payload\.role === ["']service_role["'][\s\S]*allowGatewayVerifiedServiceRole/,
  'Edge auth helper must expose an explicit opt-in for gateway-verified service-role JWTs',
);
assert.match(
  cycle,
  /function requireBridgeOperatorAuth[\s\S]*PLATFORM_BRIDGE_INTERNAL_TOKEN[\s\S]*SUPABASE_SERVICE_ROLE_KEY/,
  'platform test cycle must allow live bridge calls with either internal token or service-role operator auth',
);
assert.match(
  cycle,
  /Authorization:\s*`Bearer \$\{serviceKey \|\| env\.anon\}`/,
  'platform test cycle must forward service-role bearer tokens to authenticated bridge routes when internal token is absent',
);
assert.match(
  cycle,
  /apikey:\s*serviceKey \|\| env\.anon/,
  'platform test cycle must use the service-role key as Supabase apikey for server-side bridge smoke tests when available',
);
assert.match(
  cycle,
  /async function loadShopeeRows\(env, productId, key = env\.anon\)[\s\S]*restGet\(env, 'product_shopee_listings', query, key\)/,
  'platform test cycle must allow service-role reads for Shopee mapping preflight rows',
);
assert.match(
  cycle,
  /const shopeeRows = await loadShopeeRows\(env, product\.id, serviceKey \|\| env\.anon\)/,
  'platform test cycle must read Shopee mapping preflight rows with service-role auth when available',
);
assert.match(
  cycle,
  /process\.env\.SUPABASE_URL[\s\S]*process\.env\.SUPABASE_ANON_KEY[\s\S]*process\.env\.SUPABASE_ANON/,
  'platform test cycle must allow env overrides so smoke tests are not coupled to dirty local v2/index.html config',
);
assert.doesNotMatch(
  cycle,
  /const select = \[[\s\S]*'joom_category_id'[\s\S]*\]\.join\(','\);/,
  'platform test cycle product SELECT must not request optional columns missing from the live products table',
);
assert.doesNotMatch(
  cycle,
  /const select = \[[\s\S]*'ebay_(?:sku|offer_id|item_id|status|marketplace_id)'[\s\S]*\]\.join\(','\);/,
  'platform test cycle product SELECT must not request legacy eBay mapping columns missing from the live products table',
);
assert.doesNotMatch(
  cycle,
  /select=id,platform,shop_id,country,platform_item_id,listing_status,mapping_status,error_msg,deleted_at/,
  'platform test cycle platform_listings preflight SELECT must not request mapping_status when the live table lacks it',
);
for (const token of [
  "'shopee_category_id'",
  "'shopee_brand_id'",
  "'shopee_image_id'",
  "'shopee_extra_attributes'",
  "'shopee_description'",
  "'shopee_days_to_ship'",
  'function defaultShopeeAttributeList',
  'function mergeShopeeAttributeLists',
  'function resolveShopeeDaysToShip',
  'body.attribute_list = attributeList',
]) {
  assert(cycle.includes(token), `Shopee cycle payload must mirror V2 registration field token: ${token}`);
}
assert.match(
  cycle,
  /function shopeeRegisterBody[\s\S]*const body = \{[\s\S]*product_id: product\.id/,
  'Shopee cycle register_cbsc payload must include product_id so successful remote registration is mapped locally before returning',
);

for (const token of [
  'const EBAY_HEADLESS_CONFIRM_PHRASE = "PUBLISH_EBAY_LISTING"',
  'const EBAY_HEADLESS_POLICY_CONFIRM_PHRASE = "UPDATE_EBAY_FULFILLMENT_POLICY"',
  'async function handleEnsureFulfillmentPolicy',
  'action === "ensure-fulfillment-policy" && req.method === "POST"',
  'body?.confirm === EBAY_HEADLESS_POLICY_CONFIRM_PHRASE || body?.confirm_policy_update === true',
  'const EBAY_HEADLESS_WITHDRAW_CONFIRM_PHRASE = "WITHDRAW_EBAY_LISTING"',
  'async function handleWithdrawProduct',
  'action === "withdraw-product" && req.method === "POST"',
  'requireBridgeTokenOrAuthenticatedUser(req)',
  '/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw',
  'async function handleHeadlessPublishPayload',
  'action === "publish-headless" && req.method === "POST"',
  'return await handleHeadlessPublishPayload(body)',
  'async function handleWithdrawSku',
  'action === "withdraw-sku" && req.method === "POST"',
  'return await handleWithdrawSku(body)',
  '/sell/inventory/v1/offer/withdraw_by_inventory_item_group',
  'ebay_status: "WITHDRAWN"',
  'markEbayPlatformListingsWithdrawn',
]) {
  assert(ebayBridge.includes(token), `eBay cleanup path missing token: ${token}`);
}

for (const token of [
  'const JOOM_DELETE_CONFIRM_PHRASE = "DELETE_JOOM_PRODUCT"',
  'const dryRun = body?.dry_run !== false && body?.dryRun !== false',
  'body.confirm === JOOM_DELETE_CONFIRM_PHRASE || body.confirm_delete === true',
  'command: "/products/remove"',
  'markJoomListingRemoved',
]) {
  assert(joomBridge.includes(token), `Joom delete safety path missing token: ${token}`);
}

for (const token of [
  'const QOO10_DELETE_CONFIRM_PHRASE = "DELETE_QOO10_LISTING"',
  'async function requireBridgeTokenOrAuthenticatedUser',
  'async function handleDeleteListing',
  'ItemsBasic.EditGoodsStatus',
  'Status=3 means Deleted/Discontinued',
  'action === "delete" && req.method === "POST"',
  'markQoo10ListingDeleted',
]) {
  assert(qoo10Bridge.includes(token), `Qoo10 delete/status path missing token: ${token}`);
}

for (const token of [
  "const SHOPEE_HEADLESS_DELETE_CONFIRM_PHRASE = 'DELETE_SHOPEE_GLOBAL_ITEM'",
  'async function handleHeadlessDeleteGlobalItem',
  "action === 'delete_global_item_headless' && req.method === 'POST'",
  "requireBridgeTokenOrAuthenticatedUser(req)",
  "/api/v2/global_product/delete_global_item",
  "status: 'deleted'",
]) {
  assert(shopeeBridge.includes(token), `Shopee headless delete path missing token: ${token}`);
}

for (const token of [
  'ensure-product',
  'async function ensureProduct',
  'DIAGNOSIS_PACKS',
  'shopee-registration',
  'price-sync',
  'joom-registration',
  'local_api_docs',
  'regression_commands',
  'ebay-register',
  'function uniqueEbayTestSku',
  'function ebayCycle',
  'ebay-cycle',
  'ebay-withdraw-sku',
  "'publish-headless'",
  "'withdraw-sku'",
  "confirm: live ? CONFIRM.ebayPublish : undefined",
  'DEFAULT_TEST_IMAGE',
  'function joomPublishBody',
  'function joomCycle',
  'product_ids: productIds',
  'joom-register',
  'joom-cycle',
  "live ? 'publish' : 'dryrun'",
  'function qoo10RegisterBody',
  'function qoo10Cycle',
  'qoo10-register',
  'qoo10-cycle',
  'qoo10_register: await qoo10Register',
  'function shopeeRegisterBody',
  'function shopeeCycle',
  'function fetchImageDataUrl',
  "'upload_image'",
  'shopee-register',
  'shopee-cycle',
  'detail?.global_item_id',
  'reset_local: true',
  'ebay-policy',
  "confirm: live ? CONFIRM.ebayPolicy : undefined",
  'dry-run-all',
  'joom_register: await joomRegister',
  'cleanup-all',
  'PLATFORM_BRIDGE_INTERNAL_TOKEN or SUPABASE_SERVICE_ROLE_KEY is required',
  "confirm: live ? CONFIRM.ebayWithdraw : undefined",
  "confirm: live ? CONFIRM.joomDelete : undefined",
  "confirm: live ? CONFIRM.qoo10Delete : undefined",
  "confirm: live ? CONFIRM.shopeeDelete : undefined",
  'SUPABASE_SERVICE_ROLE_KEY not set',
]) {
  assert(cycle.includes(token), `platform test CLI missing token: ${token}`);
}

for (const pathToken of [
  'C:\\dev\\api-refs\\marketplaces\\ebay\\sell\\inventory.yaml',
  'C:\\dev\\api-refs\\marketplaces\\joom\\openapi.yaml',
  'C:\\dev\\api-refs\\marketplaces\\qoo10\\api-pages\\상품-등록\\10009-SetNewGoods.md',
  'C:\\dev\\api-refs\\marketplaces\\qoo10\\api-pages\\상품-수정\\10013-EditGoodsStatus.md',
  'C:\\dev\\api-refs\\marketplaces\\shopee\\docs_ai\\apis\\global_product\\v2.global_product.add_global_item.json',
  'C:\\dev\\api-refs\\marketplaces\\shopee\\docs_ai\\apis\\global_product\\v2.global_product.create_publish_task.json',
  'C:\\dev\\api-refs\\marketplaces\\shopee\\docs_ai\\apis\\global_product\\v2.global_product.get_publish_task_result.json',
  'C:\\dev\\api-refs\\marketplaces\\shopee\\docs_ai\\apis\\global_product\\v2.global_product.delete_global_item.json',
]) {
  assert(docs.includes(pathToken), `test cycle docs must cite local API doc path: ${pathToken}`);
}

for (const token of ['joom-cycle --live', 'POST /products/create', 'POST /products/update', 'POST /products/remove']) {
  assert(docs.includes(token), `test cycle docs must describe Joom disposable cycle token: ${token}`);
}

for (const token of ['ebay-cycle --live', 'publish-headless', 'withdraw-sku', 'sell\\inventory.yaml']) {
  assert(docs.includes(token), `test cycle docs must describe eBay disposable cycle token: ${token}`);
}

for (const token of ['qoo10-cycle --live', '10009-SetNewGoods.md', '10013-EditGoodsStatus.md', 'Status=3']) {
  assert(docs.includes(token), `test cycle docs must describe Qoo10 disposable cycle token: ${token}`);
}

for (const token of ['shopee-cycle --live', 'v2.global_product.add_global_item.json', 'v2.global_product.create_publish_task.json', 'v2.global_product.get_publish_task_result.json']) {
  assert(docs.includes(token), `test cycle docs must describe Shopee disposable cycle token: ${token}`);
}

for (const token of [
  'inspect --pack shopee-registration',
  'inspect --pack price-sync',
  'inspect --pack joom-registration',
]) {
  assert(docs.includes(token), `test cycle docs must describe diagnosis pack token: ${token}`);
}

console.log('v2 platform test cycle static checks passed');
