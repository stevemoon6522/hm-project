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
  'ebay-register',
  "confirm: live ? CONFIRM.ebayPublish : undefined",
  'DEFAULT_TEST_IMAGE',
  'function joomPublishBody',
  'function joomCycle',
  'product_ids: productIds',
  'joom-register',
  'joom-cycle',
  "live ? 'publish' : 'dryrun'",
  'ebay-policy',
  "confirm: live ? CONFIRM.ebayPolicy : undefined",
  'dry-run-all',
  'joom_register: await joomRegister',
  'cleanup-all',
  'PLATFORM_BRIDGE_INTERNAL_TOKEN is required',
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
  'C:\\dev\\api-refs\\marketplaces\\qoo10\\api-pages\\상품-수정\\10013-EditGoodsStatus.md',
  'C:\\dev\\api-refs\\marketplaces\\shopee\\docs_ai\\apis\\global_product\\v2.global_product.delete_global_item.json',
]) {
  assert(docs.includes(pathToken), `test cycle docs must cite local API doc path: ${pathToken}`);
}

for (const token of ['joom-cycle --live', 'POST /products/create', 'POST /products/update', 'POST /products/remove']) {
  assert(docs.includes(token), `test cycle docs must describe Joom disposable cycle token: ${token}`);
}

console.log('v2 platform test cycle static checks passed');
