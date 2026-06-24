import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'v2', 'index.html'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'ebay-bridge', 'index.ts'), 'utf8');

function assertIncludes(source, needle, label) {
  assert(source.includes(needle), `${label} missing: ${needle}`);
}

assertIncludes(html, 'async function platformBuildEbayMasterSyncPayload', 'V2 eBay master sync payload builder');
assertIncludes(html, 'async function platformApplyEbayMasterSync', 'V2 eBay master sync executor');
assertIncludes(html, "coverageBridgeUrl('ebay')}/sync-master-content", 'V2 eBay bridge route');
assertIncludes(html, 'platformEbaySortVariationsSetLast', 'V2 eBay SET-last sorter');
assertIncludes(html, 'payload.variations = platformEbaySortVariationsSetLast(payload.variations)', 'V2 eBay variation reorder before API');
assertIncludes(html, 'Default photos use only the layered master main image plus detail images', 'V2 eBay default photo warning');
assertIncludes(html, "if (platform === 'ebay') return platformApplyEbayMasterSync(group)", 'V2 master sync dispatcher');
assertIncludes(html, 'mrEbayPayloadFromDraft(draft)', 'V2 reuses registration draft payload');

const validationStart = html.indexOf("if (platform === 'ebay') {", html.indexOf('function platformMasterSyncValidation'));
const validationEnd = html.indexOf('return { errors, warnings };', validationStart);
assert(validationStart > 0 && validationEnd > validationStart, 'eBay master sync validation block must exist');
const validationBlock = html.slice(validationStart, validationEnd);
assert(!validationBlock.includes('bridge route missing'), 'eBay validation must not block master sync as missing bridge');

assertIncludes(bridge, 'async function handleSyncMasterContent', 'eBay bridge sync dispatcher');
assertIncludes(bridge, 'async function handleSyncVariationMasterContent', 'eBay bridge variation sync');
assertIncludes(bridge, 'async function handleSyncSingleMasterContent', 'eBay bridge single sync');
assertIncludes(bridge, 'action === "sync-master-content" && req.method === "POST"', 'eBay bridge route');
assertIncludes(bridge, 'requireBridgeTokenOrAuthenticatedUser(req)', 'eBay bridge browser/internal auth');
assertIncludes(bridge, 'sortEbayVariationsSetLast(normalized)', 'eBay bridge SET-last normalization');
assertIncludes(bridge, 'async function loadMasterOptionImagesForEbayVariation', 'eBay bridge master option image resolver');
assertIncludes(bridge, 'shopee_option_image_url,main_image', 'eBay bridge reads master option image fields');
assertIncludes(bridge, 'source: product?.shopee_option_image_url ? "products.shopee_option_image_url" : "products.main_image"', 'eBay bridge reports option image source');
assertIncludes(bridge, 'variantSKUs: skus', 'eBay bridge replaces group SKUs in sorted order');
assertIncludes(bridge, 'specifications: [{ name: axis, values }]', 'eBay bridge replaces variation values in sorted order');
assertIncludes(bridge, 'imageUrls: safeImageUrls', 'eBay bridge default photos from payload only');
assertIncludes(bridge, 'delete nextProduct.title', 'eBay variation item must not override group title');
assertIncludes(bridge, 'delete nextProduct.description', 'eBay variation item must not override group description');
assertIncludes(bridge, 'desired_image_urls: optionImages', 'eBay bridge exposes desired option images for verification');
assertIncludes(bridge, 'operation: "sync-master-content"', 'eBay bridge response operation marker');

console.log('v2 eBay master sync static checks passed');
