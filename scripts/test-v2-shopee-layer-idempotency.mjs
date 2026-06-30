import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'v2', 'index.html'), 'utf8');

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
   ${extractFunctionBlock(html, 'rshSourceImageAlreadyHasShopLayer')}
   ${extractFunctionBlock(html, 'rshShouldApplyShopLayer')}
   return {
     sdProductImagePublicStoragePath,
     sdIsProductImagePublicUrl,
     rshSourceImageAlreadyHasShopLayer,
     rshShouldApplyShopLayer,
   };`,
);

const {
  sdProductImagePublicStoragePath,
  sdIsProductImagePublicUrl,
  rshSourceImageAlreadyHasShopLayer,
  rshShouldApplyShopLayer,
} = factory();

const storedRepresentative =
  'https://bpdafetvjyvvwbksvowu.supabase.co/storage/v1/object/public/product-images/v2-master/2026-06-30/BTS-BTSLIGHT-representative-11111111-2222-4333-8444-555555555555.png';
const storedCustomCover =
  'https://bpdafetvjyvvwbksvowu.supabase.co/storage/v1/object/public/product-images/v2-master-custom/2026-06-30/BTS-BTSLIGHT-cover-11111111-2222-4333-8444-555555555555.jpg';
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
assert.equal(rshSourceImageAlreadyHasShopLayer(storedRepresentative), true, 'stored representative images are final shop-layer sources');
assert.equal(rshSourceImageAlreadyHasShopLayer(storedCustomCover), true, 'stored custom cover images are final shop-layer sources');
assert.equal(rshShouldApplyShopLayer(storedRepresentative), false, 'stored representative images must not receive a second shop layer');
assert.equal(rshShouldApplyShopLayer(storedCustomCover), false, 'stored custom cover images must not receive a second shop layer');
assert.equal(rshShouldApplyShopLayer(storedDetail), true, 'stored detail images are not representative covers and can be uploaded raw');
assert.equal(rshShouldApplyShopLayer(rawStaronemallImage), true, 'raw StarOneMall images still need the shop layer');

const useMasterImagesFn = extractFunctionBlock(html, 'rshUseMasterImages');
assert(
  useMasterImagesFn.includes('rshBuildLayerAwareCoverRef(mainUrl'),
  'Shopee modal master image preview must use the layer-aware cover builder',
);

const prepareForAccountFn = extractFunctionBlock(html, 'rshPrepareImagesForAccount');
assert(
  prepareForAccountFn.includes('rshBuildLayerAwareCoverRef(sourceUrl'),
  'account-specific image preparation must keep already-layered product-images idempotent',
);

const platformUploadFn = extractFunctionBlock(html, 'platformShopeeUploadImageRef');
assert(
  platformUploadFn.includes('const shouldLayer = layered && rshShouldApplyShopLayer(imageUrl);')
    && platformUploadFn.includes('if (shouldLayer)'),
  'Shopee master-sync image upload must send layer_version only when a layer was actually applied',
);

console.log('v2 Shopee layer idempotency checks passed');
