import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

const grouping = read('supabase', 'functions', 'platform-publish', '_shared', 'grouping.ts');
const dispatcher = read('supabase', 'functions', 'platform-publish', 'index.ts');
const shopee = read('supabase', 'functions', 'platform-publish', 'adapters', 'shopee.ts');
const joom = read('supabase', 'functions', 'platform-publish', 'adapters', 'joom.ts');
const qoo10 = read('supabase', 'functions', 'platform-publish', 'adapters', 'qoo10.ts');
const ebay = read('supabase', 'functions', 'platform-publish', 'adapters', 'ebay.ts');

assert.match(grouping, /function publishableGroupRows/, 'shared grouping helper must expose publishable group row selection');
assert.match(grouping, /rowHasPublishableStock/, 'group helper must avoid ready-stock zero-inventory options when alternatives exist');
assert.match(grouping, /effectiveVariationSpec/, 'group helper must collapse stale constant variation axes');
assert.match(grouping, /inferKpopBrandName/, 'group helper must preserve K-pop brand fallback for Joom');
assert.match(grouping, /inferKpopArtistName/, 'group helper must preserve K-pop artist fallback for eBay aspects');

assert.match(dispatcher, /const PRODUCT_SELECT = .*variation_tier_names.*variation_option_names.*variation_tier_index/s, 'dispatcher must select variation metadata');
assert.match(dispatcher, /const PRODUCT_SELECT = .*ebay_sku.*shopee_global_model_sku/s, 'dispatcher must select per-platform option SKU fields');
assert.match(dispatcher, /let groupProducts: any\[\] = \[\]/, 'dispatcher must prepare grouped products for create flows');
assert.match(dispatcher, /eq\('product_group_id', product\.product_group_id\)/, 'dispatcher must fetch sibling products by product_group_id');
assert.match(dispatcher, /groupProducts,\s+shopId/s, 'dispatcher must pass grouped products into adapters');
assert.match(dispatcher, /\['qoo10', 'joom', 'ebay'\]\.includes\(platform\)/, 'dispatcher must absorb grouped option mappings for non-Shopee marketplaces');

assert.match(shopee, /publishableGroupRows\(master/, 'Shopee adapter must detect grouped master products');
assert.match(shopee, /bridgeParentSku/, 'Shopee adapter must use a parent SKU for grouped Global Product registration');
assert.match(shopee, /global_model_sku: String\(row\.shopee_global_model_sku \|\| row\.sku/, 'Shopee adapter must send option SKUs as global model SKUs');
assert.match(shopee, /variation: shopeeVariation \|\| undefined/, 'Shopee adapter dry-run payload must include generated variation data');
assert.match(shopee, /listingProducts = variationRows\.length > 1 \? variationRows : \[master\]/, 'Shopee adapter must store per-option region mappings');
assert.match(shopee, /bridgePost\('upload_image'/, 'Shopee adapter must upload main_image URL before live Global Product registration');
assert.match(shopee, /image_base64: imageData\.image_base64/, 'Shopee adapter must send upload_image a base64 JPEG/PNG payload');
assert.match(shopee, /SHOPEE_IMAGE_UPLOAD_FAILED/, 'Shopee adapter must surface image upload failures before register_cbsc');
assert.match(shopee, /function normalizeShopeeAttributeList/, 'Shopee adapter must normalize stored extra attributes before register_cbsc');
assert.match(shopee, /else if \(originalValueName\) entry\.value_id = 0/, 'Shopee adapter must send custom attribute values as value_id=0 plus original_value_name');
assert.match(shopee, /const failedSummary = regionSummary/, 'Shopee adapter must surface a top-level failure summary when every region fails');

assert.match(joom, /inferKpopBrandName/, 'Joom adapter must infer a usable brand when Shopee brand is No Brand');
assert.match(joom, /const variationBundle = groupRows\.length > 1 \? buildVariationItems/, 'Joom adapter must build grouped variation options');
assert.match(joom, /variantsConfig = variationBundle/, 'Joom adapter must send all variants through variantsConfig');
assert.match(joom, /option_products/, 'Joom adapter must return option mapping hints after grouped create');

assert.match(qoo10, /QOO10_DEFAULT_SHIPPING_NO = '715009'/, 'Qoo10 adapter must apply the UI default shipping template');
assert.match(qoo10, /qoo10PriceFromCost/, 'Qoo10 adapter must compute a base price when modal payload is absent');
assert.match(qoo10, /reconcileQoo10BaseAndOptions/, 'Qoo10 adapter must reconcile grouped base and option prices before bridge publish');
assert.match(qoo10, /auto_max_option_base_clamped_options/, 'Qoo10 adapter must default grouped base price to the highest option target');
assert.match(qoo10, /qoo10ClampOptionPrice/, 'Qoo10 adapter must clamp option prices into Qoo10 delta limits');
assert.match(qoo10, /if \(ctx\.dryRun\)[\s\S]*dry_run: true[\s\S]*payload/, 'Qoo10 adapter must stop dry-runs before qoo10-bridge create-listing');
assert.match(qoo10, /publishableGroupRows\(ctx\.masterProduct/, 'Qoo10 adapter must build option payloads from grouped products');
assert.doesNotMatch(qoo10, /BrandNo is required/, 'Qoo10 adapter must not require optional BrandNo from SetNewGoods docs');

assert.match(ebay, /bridgePost\('publish-variation'/, 'eBay adapter must route grouped creates through publish-variation');
assert.match(ebay, /inventoryGroupKey\(master, groupRows\)/, 'eBay adapter must generate a stable inventory item group key');
assert.match(ebay, /variationAxis: 'Version'/, 'eBay adapter must use a Version variation axis for grouped K-pop albums');
assert.match(ebay, /option_products/, 'eBay adapter must return option mapping hints after grouped create');
assert.match(ebay, /inferKpopArtistName/, 'eBay adapter must infer artist aspects instead of using No Brand');

console.log('platform-publish grouped registration checks passed');
