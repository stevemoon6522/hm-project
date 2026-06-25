import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const edgePath = join(root, 'supabase', 'functions', 'ebay-bridge', 'index.ts');
const edgeMirrorPath = join(root, 'edge-functions', 'ebay-bridge', 'index.ts');

for (const path of [edgePath, edgeMirrorPath]) {
  assert.equal(existsSync(path), true, `${path} must exist`);
}

const edge = readFileSync(edgePath, 'utf8');
const edgeMirror = readFileSync(edgeMirrorPath, 'utf8');
const hash = (s) => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex');
assert.equal(hash(edge), hash(edgeMirror), 'supabase and edge-functions ebay-bridge copies must match');

const handleStart = edge.indexOf('async function handleRequest');
const registerRoute = edge.indexOf('action === "register-product" && req.method === "POST"', handleStart);
const policyRoute = edge.indexOf('action === "ensure-fulfillment-policy" && req.method === "POST"', handleStart);
const authGate = edge.indexOf('const authResult = await requireAuthenticatedUser(req);', handleStart);
assert(handleStart >= 0, 'handleRequest must exist');
assert(registerRoute > handleStart, 'register-product route must exist in handleRequest');
assert(authGate > registerRoute, 'headless register-product must run before browser-session auth gate');
assert(edge.slice(registerRoute, authGate).includes('action === "lookup-item" && req.method === "GET"'), 'lookup-item must accept internal bridge verification before browser-session auth gate');
assert(edge.slice(registerRoute, authGate).includes('action === "lookup-group" && req.method === "GET"'), 'lookup-group must accept internal bridge verification before browser-session auth gate');
assert(edge.slice(registerRoute, authGate).includes('requireBridgeTokenOrAuthenticatedUser(req)'), 'read-only eBay lookup routes must allow either internal bridge token or browser auth');
assert(edge.slice(registerRoute, authGate).includes('requireInternalBridge(req)'), 'register-product route must require internal bridge token');
assert(!edge.slice(registerRoute, authGate).includes('requireAuthenticatedUser(req)'), 'register-product route must not require a Supabase browser session');
assert(policyRoute > registerRoute && policyRoute < authGate, 'ensure-fulfillment-policy route must exist before browser-session auth gate');
assert(edge.slice(policyRoute, authGate).includes('requireInternalBridge(req)'), 'ensure-fulfillment-policy must require internal bridge token');

for (const token of [
  'const EBAY_HEADLESS_CONFIRM_PHRASE = "PUBLISH_EBAY_LISTING"',
  'const EBAY_HEADLESS_POLICY_CONFIRM_PHRASE = "UPDATE_EBAY_FULFILLMENT_POLICY"',
  'const EBAY_READY_STOCK_FULFILLMENT_POLICY_ID = "233825118025"',
  'function ebayFulfillmentPolicyForLifecycle',
  'async function handleEnsureFulfillmentPolicy',
  'buildOfferPolicyUpdatePayload',
  'const dryRun = body?.dry_run !== false && body?.dryRun !== false',
  'body?.confirm === EBAY_HEADLESS_CONFIRM_PHRASE || body?.confirm_publish === true',
  'body?.confirm === EBAY_HEADLESS_POLICY_CONFIRM_PHRASE || body?.confirm_policy_update === true',
  'async function buildHeadlessEbayProductPayload',
  'normalizeEbayLifecycleState(body.lifecycleState || body.lifecycle_state || product.lifecycle_state) || "pre_order"',
  'async function handleRegisterProduct',
  'fulfillmentPolicyPreview',
  'await handlePublish(payload)',
  'await handleLookupItem(payload.sku, payload.marketplaceId || "EBAY_US")',
  'async function persistHeadlessEbayPublishResult',
  'async function persistEbayPublishPlatformMappings',
  'await persistEbayPublishPlatformMappings("single", payload, publishJson)',
  'publish_origin: "v2_created"',
  'platform_item_id: ebayItemId',
  'ebay_listing_mode: "single"',
  'ebay_mapping_status: "mapped"',
  'shippingSurchargePolicy: "delta_vs_us_baseline"',
  'loadEbayShippingSurchargeRows',
  'ebay_shipping_country_rates',
  'async function guardEbayUpdatePrice',
  'price_guard_failed',
  'price_delta_guard_failed',
  'serverPriceUsd: priceGuard.serverPriceUsd',
  'product_mapping_required',
  'EBAY_PRICE_GUARD_MAX_DELTA_RATIO',
  'const artist = String(derived.artist || (isListingStatusTag(storedArtist) ? "" : storedArtist) || "").trim().slice(0, 50)',
]) {
  assert(edge.includes(token), `headless eBay register path missing token: ${token}`);
}

function extractBlock(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start);
  assert(start >= 0 && end > start, `could not extract ${startToken} block`);
  return source.slice(start, end);
}

function stripTinyTs(block) {
  return block
    .replace(/\)\s*:\s*\{[^}]+\}\s*\{/g, ') {')
    .replace(/: unknown/g, '')
    .replace(/: string\[\]/g, '')
    .replace(/: RegExpExecArray \| null/g, '')
    .replace(/: boolean/g, '')
    .replace(/: string/g, '')
    .replace(/\)\s*:\s*number/g, ')');
}

const parserBlock = stripTinyTs(extractBlock(edge, 'function stripLifecycleTags', 'function ebayShippingWeightBucketG'));
const deriveEbayKpopFromTitle = new Function(
  `function s(value, fallback = "") { return value == null ? fallback : String(value); }\n${parserBlock}\nreturn deriveEbayKpopFromTitle;`,
)();

assert.deepEqual(
  deriveEbayKpopFromTitle('[READY STOCK] (JENNIE) The 1st Studio Album [Ruby] (CD Digipack)'),
  { artist: 'JENNIE', album: 'Ruby', version: 'CD Digipack', member: '' },
  'headless builder must derive JENNIE Ruby eBay aspects from the target product title',
);
assert.deepEqual(
  deriveEbayKpopFromTitle('[READY STOCK] CORTIS - [ GREENGREEN ] 2ND EP (WEVERSE Ver.)'),
  { artist: 'CORTIS', album: 'GREENGREEN', version: 'WEVERSE', member: '' },
  'headless builder must ignore stock-state tags for artist/album/version derivation',
);
assert.deepEqual(
  deriveEbayKpopFromTitle('[READY STOCK] (ILLIT) - NOT CUTE ANYMORE [NOT CUTE Ver. / NOT MY NAME Ver.]'),
  { artist: 'ILLIT', album: 'NOT CUTE ANYMORE', version: '', member: '' },
  'headless builder must mirror shared master-title parsing for parenthesized dash-prefix artists and bracketed option versions',
);

const ratesMatch = edge.match(/const EBAY_US_DIRECT_SHIPPING_RATES_KRW: Record<number, number> = \{([\s\S]*?)\};/);
assert(ratesMatch, 'US direct shipping rates must be declared');
const rates = Function(`return ({${ratesMatch[1]}});`)();
assert.equal(rates[200], 8900, '150g target product must use the 200g US shipping bucket baseline');

console.log('v2 eBay headless register-product static checks passed');
