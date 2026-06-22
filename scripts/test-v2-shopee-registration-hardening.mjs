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
const adapter = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'shopee.ts'), 'utf8');

const rshBlock = sliceBetween(html, 'PHASE B', '// P2-1: Legacy modal URL flag');
const registerCbscBlock = sliceBetween(bridge, "if (action === 'register_cbsc' && req.method === 'POST')", "if (action === 'item_info')");
const multiRegionBlock = sliceBetween(adapter, 'async function handleCreateListingMultiRegion', 'async function handleCreateListing(ctx');
const singleRegionBlock = sliceBetween(adapter, 'async function handleCreateListing', 'async function handleUpdateMetadata');

assert(
  rshBlock.includes('function rshVariantValidationErrors')
    && rshBlock.includes('function rshGroupVariantPreflightMessage')
    && rshBlock.includes('Option stock must be 1 or more')
    && rshBlock.includes('variantErrors.length > 0')
    && rshBlock.includes('type="number" min="1" step="1" value="${text(String(stock))}"')
    && html.includes('id="rsh-var-bulk-stock" type="number" min="1"'),
  'Shopee modal must preflight option stock/price/SKU/weight before enabling registration',
);

assert(
  rshBlock.includes('function rshMissingProductImageRegions')
    && rshBlock.includes('function rshMergeRegionImageIds')
    && rshBlock.includes('cached image_id cannot satisfy missing target-region image uploads')
    && rshBlock.includes('Missing or insufficient image_id_list'),
  'Shopee modal must treat target-region product image IDs as required while leaving option images optional',
);

assert(
  bridge.includes('function hasShopeeProductImageInput')
    && bridge.includes('function validateRegisterStockInput')
    && bridge.includes('function validateRegisterPriceInput')
    && registerCbscBlock.includes("stage: 'image_preflight'")
    && registerCbscBlock.includes("stage: 'stock_preflight'")
    && registerCbscBlock.includes("stage: 'price_preflight'")
    && registerCbscBlock.indexOf("stage: 'stock_preflight'") < registerCbscBlock.indexOf("'/api/v2/global_product/add_global_item'"),
  'Shopee bridge register_cbsc must reject missing product image, invalid stock, and invalid price before Shopee API calls',
);

assert(
  multiRegionBlock.includes('const missingRegionImageUpload = regions.some')
    && multiRegionBlock.includes('const missingRequiredRegionImages = regions.filter')
    && multiRegionBlock.includes('invalid_option_stock')
    && multiRegionBlock.includes('invalid_option_price')
    && multiRegionBlock.includes('seller_stock: [{ stock: Math.max(1'),
  'platform-publish Shopee multi-region adapter must upload missing region images and reject zero-stock option models',
);

assert(
  singleRegionBlock.includes('Number(stock) < 1')
    && singleRegionBlock.includes('PLATFORM_VALIDATION_ERROR'),
  'platform-publish Shopee single-region adapter must reject zero stock before register_cbsc',
);

console.log('v2 Shopee registration hardening checks passed');
