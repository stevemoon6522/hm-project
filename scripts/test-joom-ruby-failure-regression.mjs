import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const bridge = readFileSync(join(root, 'supabase', 'functions', 'joom-bridge', 'index.ts'), 'utf8');
const edgeBridge = readFileSync(join(root, 'edge-functions', 'joom-bridge', 'index.ts'), 'utf8');
const joomAdapter = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'joom.ts'), 'utf8');
const openapi = readFileSync('C:/dev/api-refs/marketplaces/joom/openapi.yaml', 'utf8');
const decorativeEmojiMarkers = ['\u{1F4BF}', '\u{1F4CA}', '\u{1F4E6}', '\u{1F4CC}', '\u{26A0}\u{FE0F}'];

const rubyFixture = {
  sku: 'F4-JEN-RUBY-DIG-',
  title: '[READY STOCK] (JENNIE) The 1st Studio Album [Ruby] (CD Digipack)',
  detail: { width: 1000, height: 1500 },
  brand: 'BLACKPINK',
  priorJoomState: 'rejected',
  infractions: ['J1007', 'J1008', 'J1147'],
};

assert.match(openapi, /'\/products\/update':[\s\S]*Either `id` or\u00a0`sku` must be specified/, 'Local Joom docs must confirm SKU-based product update');
assert.match(openapi, /productSku:[\s\S]*in: query[\s\S]*name: sku/, 'Local Joom docs must define productSku query parameter as sku');
assert.match(openapi, /description:[\s\S]*Description of the[\s\S]*plain text[\s\S]*HTML markup will not/, 'Local Joom docs must require plain-text descriptions without HTML');

assert.match(bridge, /async function createOrUpdateJoomProduct/, 'Joom bridge must have a create-or-update publish path');
assert.match(bridge, /const existing = await lookupJoomProductBySku\(productSku\)/, 'Joom bridge must look up existing merchant SKU before create');
assert.match(bridge, /String\(existing\.state \|\| ""\)\.toLowerCase\(\) !== "archived"[\s\S]*\/products\/update\?sku=/, 'Existing non-archived Joom products, including rejected Ruby, must be updated instead of duplicated');
assert.match(bridge, /recovered_existing_product_id/, 'Joom publish response must expose recovered existing product id for operator/debug visibility');
assert.match(bridge, /function imageBundleSummary/, 'Joom bridge lookup must expose a protected image audit summary for operational verification');
assert.match(bridge, /image_audit:[\s\S]*extraImages:[\s\S]*imageBundleSummary/, 'Joom lookup must include extraImages dimensions for square-image verification');
assert.match(bridge, /infractions:[\s\S]*product\?\.review[\s\S]*variantSku/, 'Joom lookup must expose review infractions for warning-state diagnosis');
assert.match(bridge, /action === "update-images"[\s\S]*\/products\/update\?sku=/, 'Joom bridge must provide a protected extraImages-only recovery path for rejected products');
assert.match(bridge, /body: JSON\.stringify\(\{ extraImages: processedExtras \}\)/, 'Joom image recovery must update only extraImages and avoid price/inventory mutation');
assert.match(bridge, /clear_extra_images[\s\S]*body: JSON\.stringify\(\{ extraImages: \[\] \}\)/, 'Joom image recovery must allow explicit extraImages clearing for download-failed warning cleanup');
assert.match(bridge, /products\/update is PATCH-like; explicitly sending extraImages updates that field only/, 'Joom extraImages clearing must cite the local PATCH-like update docs');
assert.match(bridge, /JOOM_REVIEW_FIELDS_CONFIRM_PHRASE = "UPDATE_JOOM_REVIEW_FIELDS"/, 'Joom review-field recovery must require an explicit confirmation phrase');
assert.match(bridge, /const reviewBrand = String[\s\S]*if \(reviewBrand\) updatePayload\.brand = reviewBrand[\s\S]*updatePayload\.brand = null[\s\S]*updatePayload\.extraImages = \[\]/, 'Joom review-field recovery must allow explicit brand setting/clearing and extraImages cleanup');
assert.match(bridge, /explicit null resets optional fields such as brand/, 'Joom review-field recovery must cite the local null-reset update docs');
assert.match(bridge, /function decodeBase64Image/, 'Joom image recovery must support client-provided square image bytes when source CDN blocks Edge fetch');
assert.match(bridge, /imageDataRows[\s\S]*uploadTileToCloudinary\(bytes\)[\s\S]*uploadTileToProductStorage\(bytes/, 'Joom image recovery must upload provided image bytes before updating extraImages');

const goesToNearSquarePadding = !(rubyFixture.detail.height > rubyFixture.detail.width * 1.5)
  && !(rubyFixture.detail.width > rubyFixture.detail.height * 1.5);
assert.equal(goesToNearSquarePadding, true, 'Ruby 1000x1500 detail image sits exactly on the old tall-image threshold boundary');
assert.match(bridge, /const tileSize = Math\.max\(img\.width, img\.height\)/, 'Ruby threshold detail image must enter the near-square padding branch');
assert.match(bridge, /c_pad,b_white,w_\$\{targetSize\},h_\$\{targetSize\}/, 'Ruby detail image output must be square padded through Cloudinary fetch');
assert.match(bridge, /async function buildCloudinaryUnknownSquare/, 'Joom bridge must have a Cloudinary square fallback when Edge cannot read source image dimensions');
assert.match(bridge, /readImageDimensions failed[\s\S]*buildCloudinaryUnknownSquare/, 'Joom detail processing must continue through Cloudinary when source dimension fetch is blocked');
assert.doesNotMatch(bridge, /return \[imageUrl\];/, 'Joom bridge must never fall back to raw rectangular detail images');

assert.match(bridge, /function joomPlainText/, 'Joom bridge must sanitize descriptions centrally');
assert.match(bridge, /replace\(\/<\[\^>\]\+>\/g, " "\)/, 'Joom bridge must strip HTML tags from product descriptions');
assert.ok((bridge.match(/replace\(\/<\[\^>\]\+>\/g, " "\)/g) || []).length >= 2, 'Joom bridge must strip encoded HTML tags after entity decoding');
assert.match(bridge, /replace\(\/\[\^\\x09\\x0A\\x0D\\x20-\\x7E\]\/g, ""\)/, 'Joom bridge must strip non-ASCII text that triggered wrong-language review');
assert.equal(decorativeEmojiMarkers.some((marker) => bridge.includes(`"${marker}`)), false, 'Joom bridge fixed description template must not contain decorative emoji');

assert.match(bridge, /const brandName = String\(brand \|\| ""\)\.trim\(\)/, 'Joom bridge must require a selected brand');
assert.match(joomAdapter, /master\.shopee_brand_name/, 'Joom adapter must use registered Shopee brand fallback');
assert.match(joomAdapter, /master\.qoo10_brand_name/, 'Joom adapter must use registered Qoo10 brand fallback');
assert.match(joomAdapter, /categoryId and brand/, 'Joom adapter validation must block brandless creates before bridge publish');
assert.equal(rubyFixture.brand, 'BLACKPINK', 'Ruby fixture brand should be the registered marketplace brand candidate');

for (const source of [bridge, edgeBridge]) {
  assert.match(source, /async function createOrUpdateJoomProduct/, 'Supabase and edge Joom bridge mirrors must both recover existing SKUs');
  assert.match(source, /function joomPlainText/, 'Supabase and edge Joom bridge mirrors must both sanitize descriptions');
  assert.match(source, /function imageBundleSummary/, 'Supabase and edge Joom bridge mirrors must both expose image audit summaries');
  assert.match(source, /infractions:[\s\S]*product\?\.review/, 'Supabase and edge Joom bridge mirrors must both expose warning infractions');
  assert.match(source, /action === "update-images"/, 'Supabase and edge Joom bridge mirrors must both support extraImages-only recovery');
  assert.match(source, /clear_extra_images[\s\S]*extraImages: \[\]/, 'Supabase and edge Joom bridge mirrors must both support explicit extraImages clearing');
  assert.match(source, /action === "update-review-fields"/, 'Supabase and edge Joom bridge mirrors must both support confirmed review-field recovery');
  assert.match(source, /function decodeBase64Image/, 'Supabase and edge Joom bridge mirrors must both support inline square image recovery');
  assert.doesNotMatch(source, /return \[imageUrl\];/, 'Supabase and edge Joom bridge mirrors must both avoid raw detail image fallback');
}

console.log('Joom Ruby failure regression checks passed');
