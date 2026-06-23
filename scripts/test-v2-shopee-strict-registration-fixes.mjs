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
const shopeeAdapter = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'shopee.ts'), 'utf8');

const rshBlock = sliceBetween(html, 'PHASE B', '// P2-1: Legacy modal URL flag');
const groupPayloadBlock = sliceBetween(rshBlock, 'function rshBuildGroupRegisterPayload', 'async function rshRegisterOptionGroupViaCbsc');
const specBlock = sliceBetween(rshBlock, 'function rshWireBrandSearch', 'function rshReadCondition');
const registerCbscBlock = sliceBetween(bridge, "if (action === 'register_cbsc' && req.method === 'POST')", "if (action === 'item_info')");

assert(
  rshBlock.includes('function rshRawComponentsBlock')
    && rshBlock.includes('const componentBlock = rshRawComponentsBlock(components)')
    && !rshBlock.includes('const componentBlock = rshFormatComponentsBlock(components)'),
  'Shopee description must insert master component lines verbatim instead of reformatting/summarising them',
);

assert(
  specBlock.includes('async function rshLoadGlobalAttributes')
    && specBlock.includes('function rshRenderSpecAttributeField')
    && specBlock.includes('function rshFilterAttributeOptions')
    && specBlock.includes('data-rsh-attribute-id')
    && specBlock.includes('SHOPEE_BRIDGE}/global_attributes?')
    && specBlock.includes('id="rsh-brand-search"'),
  'Shopee modal must load searchable Global Product specification attributes and brand search controls',
);

assert(
  groupPayloadBlock.includes("registration_kind: 'option_group'")
    && !groupPayloadBlock.includes('sku: parentSku,'),
  'option-group registration payload must not send a parent Global item SKU',
);

assert(
  registerCbscBlock.includes('const isOptionGroupRegistration')
    && registerCbscBlock.includes('if (!body.sku && !isOptionGroupRegistration)')
    && !registerCbscBlock.includes('stage_logs.push(\'add_global_item retry ok (fallback mandatory attrs)\')'),
  'register_cbsc must not require parent SKU for option groups or auto-retry missing specs with guessed values',
);

assert(
  shopeeAdapter.includes('function shopeeImageSourceRefs')
    && shopeeAdapter.includes('master.extra_images')
    && shopeeAdapter.includes('uploadShopeeImageRefsForRegions')
    && shopeeAdapter.includes('SHOPEE_MAX_PRODUCT_IMAGES')
    && shopeeAdapter.includes('function shopeeUploadReadyCloudinaryUrl')
    && shopeeAdapter.includes('SHOPEE_PRODUCT_IMAGE_MAX_SIDE')
    && shopeeAdapter.includes('f_jpg,q_${SHOPEE_PRODUCT_IMAGE_QUALITY}')
    && shopeeAdapter.includes('const needsDetailImageUpload = imageRefs.length > bestExistingImageCount')
    && !shopeeAdapter.includes('!cachedMasterImageIds.length && master.main_image')
    && shopeeAdapter.includes('registration_kind: (ctx as any).registration_kind || (variationBundle ? \'option_group\' : \'single\')')
    && shopeeAdapter.includes('sku: bridgeParentSku'),
  'platform-publish Shopee adapter must upload master detail images into Product Images and send a stable parent SKU for option-group fallback flows',
);

console.log('v2 Shopee strict registration fix checks passed');
