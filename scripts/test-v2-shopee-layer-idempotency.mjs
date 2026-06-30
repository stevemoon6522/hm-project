import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'v2', 'index.html'), 'utf8');
const shopeeAdapter = fs.readFileSync(path.join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'shopee.ts'), 'utf8');

function extractFunctionBlock(source, functionName) {
  let start = source.indexOf(`function ${functionName}(`);
  assert(start >= 0, `${functionName} must exist`);
  const asyncStart = start - 'async '.length;
  if (asyncStart >= 0 && source.slice(asyncStart, start) === 'async ') start = asyncStart;
  const paramsEnd = source.indexOf(')', start);
  assert(paramsEnd > start, `${functionName} must close its parameter list`);
  const open = source.indexOf('{', paramsEnd);
  assert(open > start, `${functionName} must have a body`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${functionName} body must close`);
}

const factory = new Function(
  `${extractFunctionBlock(html, 'sdProductImagePublicStoragePath')}
   ${extractFunctionBlock(html, 'sdIsProductImagePublicUrl')}
   ${extractFunctionBlock(html, 'platformSourceImageAlreadyHasShopLayer')}
   ${extractFunctionBlock(html, 'platformShouldApplyShopLayer')}
   ${extractFunctionBlock(html, 'rshSourceImageAlreadyHasShopLayer')}
   ${extractFunctionBlock(html, 'rshShouldApplyShopLayer')}
   return {
     sdProductImagePublicStoragePath,
     sdIsProductImagePublicUrl,
     platformSourceImageAlreadyHasShopLayer,
     platformShouldApplyShopLayer,
     rshSourceImageAlreadyHasShopLayer,
     rshShouldApplyShopLayer,
   };`,
);

const {
  sdProductImagePublicStoragePath,
  sdIsProductImagePublicUrl,
  platformSourceImageAlreadyHasShopLayer,
  platformShouldApplyShopLayer,
  rshSourceImageAlreadyHasShopLayer,
  rshShouldApplyShopLayer,
} = factory();

const storedRepresentative =
  'https://bpdafetvjyvvwbksvowu.supabase.co/storage/v1/object/public/product-images/v2-master/2026-06-30/BTS-BTSLIGHT-representative-11111111-2222-4333-8444-555555555555.png';
const storedCustomCover =
  'https://bpdafetvjyvvwbksvowu.supabase.co/storage/v1/object/public/product-images/v2-master-custom/2026-06-30/BTS-BTSLIGHT-cover-11111111-2222-4333-8444-555555555555.jpg';
const storedQoo10Cover =
  'https://bpdafetvjyvvwbksvowu.supabase.co/storage/v1/object/public/product-images/q10/2026-06-30/BTS-BTSLIGHT-cover-11111111-2222-4333-8444-555555555555.jpg';
const storedEbayCover =
  'https://bpdafetvjyvvwbksvowu.supabase.co/storage/v1/object/public/product-images/ebay/2026-06-30/BTS-BTSLIGHT-cover-11111111-2222-4333-8444-555555555555.jpg';
const storedDetail =
  'https://bpdafetvjyvvwbksvowu.supabase.co/storage/v1/object/public/product-images/v2-master/2026-06-30/BTS-BTSLIGHT-detail-11111111-2222-4333-8444-555555555555.jpg';
const rawStaronemallImage =
  'https://cdn.staronemall.com/shopimages/staronemall/012345000999.jpg';

assert.equal(
  sdProductImagePublicStoragePath(storedRepresentative),
  'v2-master/2026-06-30/BTS-BTSLIGHT-representative-11111111-2222-4333-8444-555555555555.png',
  'product-images public URL path should be extracted without the storage prefix',
);
assert.equal(sdIsProductImagePublicUrl(storedRepresentative), true, 'product-images representative URL should be recognized');
assert.equal(platformSourceImageAlreadyHasShopLayer(storedRepresentative), true, 'stored representative images are final cross-platform shop-layer sources');
assert.equal(platformSourceImageAlreadyHasShopLayer(storedCustomCover), true, 'stored custom cover images are final cross-platform shop-layer sources');
assert.equal(platformSourceImageAlreadyHasShopLayer(storedQoo10Cover), true, 'stored Qoo10 cover images are final cross-platform shop-layer sources');
assert.equal(platformSourceImageAlreadyHasShopLayer(storedEbayCover), true, 'stored eBay cover images are final cross-platform shop-layer sources');
assert.equal(platformShouldApplyShopLayer(storedRepresentative), false, 'stored representative images must not receive a second platform shop layer');
assert.equal(platformShouldApplyShopLayer(storedCustomCover), false, 'stored custom cover images must not receive a second platform shop layer');
assert.equal(platformShouldApplyShopLayer(storedQoo10Cover), false, 'stored Qoo10 cover images must not receive a second platform shop layer');
assert.equal(platformShouldApplyShopLayer(storedEbayCover), false, 'stored eBay cover images must not receive a second platform shop layer');
assert.equal(platformShouldApplyShopLayer(storedDetail), true, 'stored detail images are not representative covers and can be uploaded raw');
assert.equal(platformShouldApplyShopLayer(rawStaronemallImage), true, 'raw StarOneMall images still need the platform shop layer');
assert.equal(rshSourceImageAlreadyHasShopLayer(storedRepresentative), true, 'stored representative images are final shop-layer sources');
assert.equal(rshSourceImageAlreadyHasShopLayer(storedCustomCover), true, 'stored custom cover images are final shop-layer sources');
assert.equal(rshShouldApplyShopLayer(storedRepresentative), false, 'stored representative images must not receive a second shop layer');
assert.equal(rshShouldApplyShopLayer(storedCustomCover), false, 'stored custom cover images must not receive a second shop layer');
assert.equal(rshShouldApplyShopLayer(storedDetail), true, 'stored detail images are not representative covers and can be uploaded raw');
assert.equal(rshShouldApplyShopLayer(rawStaronemallImage), true, 'raw StarOneMall images still need the shop layer');

const useMasterImagesFn = extractFunctionBlock(html, 'rshUseMasterImages');
assert(
  useMasterImagesFn.includes('platformBuildLayerAwareCoverRef(mainUrl'),
  'Shopee modal master image preview must use the platform layer-aware cover builder',
);

const prepareForAccountFn = extractFunctionBlock(html, 'rshPrepareImagesForAccount');
assert(
  prepareForAccountFn.includes('platformBuildLayerAwareCoverRef(sourceUrl'),
  'account-specific image preparation must keep already-layered product-images idempotent',
);

const platformUploadFn = extractFunctionBlock(html, 'platformShopeeUploadImageRef');
assert(
  platformUploadFn.includes('const shouldLayer = layered && platformShouldApplyShopLayer(imageUrl);')
    && platformUploadFn.includes('if (shouldLayer)'),
  'Shopee master-sync image upload must send layer_version only when a layer was actually applied',
);

const marketplaceLayerFn = extractFunctionBlock(html, 'mrBuildMarketplaceLayeredMainImageUrl');
assert(
  marketplaceLayerFn.includes('platformBuildLayerAwareCoverDataUrl(sourceUrl'),
  'Qoo10/eBay shared representative image upload must use the platform layer-aware data URL builder',
);

const bulkRegionUploadFn = extractFunctionBlock(html, 'mrUploadRegionImages');
assert(
  bulkRegionUploadFn.includes('const shouldApplyLayer = isMainImage && platformShouldApplyShopLayer(imageUrl);')
    && bulkRegionUploadFn.includes('if (shouldApplyLayer)')
    && bulkRegionUploadFn.includes('layer_version: shouldApplyLayer ? sdShopeeLayerVersion(accountKey) : undefined'),
  'URL-bulk regional image upload must not re-layer product-images cover sources',
);

assert.match(
  shopeeAdapter,
  /function platformImageAlreadyHasShopLayer\(/,
  'server-side Shopee platform-publish adapter must recognize already-layered product-images covers',
);
assert.match(
  shopeeAdapter,
  /const shouldLayer = ref\.layered && !platformImageAlreadyHasShopLayer\(ref\.imageUrl\)/,
  'server-side Shopee platform-publish adapter must avoid re-layering already-layered covers',
);

console.log('v2 platform layer idempotency checks passed');
