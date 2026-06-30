import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');

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

const sharedLayeredUrlFn = extractFunctionBlock(html, 'mrBuildMarketplaceLayeredMainImageUrl');
assert(
  sharedLayeredUrlFn.includes('platformBuildLayerAwareCoverDataUrl(sourceUrl'),
  'marketplace layered image URL helper must reuse the idempotent shop-layer composition path',
);
assert(
  sharedLayeredUrlFn.includes("sdUploadProductImageFile(file, uploadRow")
    && sharedLayeredUrlFn.includes("kind: 'cover'")
    && sharedLayeredUrlFn.includes("prefix: platformKey === 'qoo10' ? 'q10' : platformKey"),
  'marketplace layered image URL helper must upload a short public cover URL for non-Shopee marketplaces',
);

const qoo10LayerFn = extractFunctionBlock(html, 'mrQoo10BuildLayeredMainImageUrl');
assert(
  qoo10LayerFn.includes("return await mrBuildMarketplaceLayeredMainImageUrl('qoo10', mainImageUrl, first);"),
  'Qoo10 representative image builder must use the shared layered URL helper',
);
assert(
  html.includes("const QOO10_SHOP_LAYER_VERSION = 'qoo10-shop-layer-v1';"),
  'Qoo10 layered StandardImage submissions must use a stable layer version marker',
);

const qoo10SubmitFn = extractFunctionBlock(html, 'mrQoo10Submit');
assert(
  qoo10SubmitFn.includes("mrQoo10Status('Building Qoo10 layered representative image...')")
    && qoo10SubmitFn.includes('payload.publish.main_image = await mrQoo10BuildLayeredMainImageUrl(_mrQoo10.rows || [])')
    && qoo10SubmitFn.indexOf('payload.publish.main_image = await mrQoo10BuildLayeredMainImageUrl(_mrQoo10.rows || [])')
      < qoo10SubmitFn.indexOf('await mrQoo10PersistProductFields(payload)'),
  'Qoo10 submit must replace payload.publish.main_image with the layered URL before persisting and publishing',
);
assert(
  qoo10SubmitFn.includes('payload.publish.main_image_layered = true;')
    && qoo10SubmitFn.includes('payload.publish.layer_version = QOO10_SHOP_LAYER_VERSION;'),
  'Qoo10 submit must send layered-image guard metadata with the publish payload',
);

const ebayImageUrlsFn = extractFunctionBlock(html, 'mrEbayImageUrls');
assert(
  ebayImageUrlsFn.includes("function mrEbayImageUrls(group, sourceRow, layeredMainImageUrl = '')")
    && ebayImageUrlsFn.includes('layeredMainImageUrl')
    && ebayImageUrlsFn.indexOf('layeredMainImageUrl') < ebayImageUrlsFn.indexOf('firstRow._ebayMainImage')
    && !ebayImageUrlsFn.includes('mrEbayActiveRows(group).map'),
  'eBay default image URL list must use the layered representative/detail images without option images',
);

const ebayRepresentativeFn = extractFunctionBlock(html, 'mrEbayRepresentativeImageUrl');
assert(
  ebayRepresentativeFn.includes('firstRow._ebayRepresentativeImageUrl = mainImageUrl')
    && ebayRepresentativeFn.indexOf('mrMasterRepresentativeImage(group)') < ebayRepresentativeFn.indexOf('firstRow._ebayMainImage'),
  'eBay representative image builder must prefer the raw master representative image before option-image fallbacks',
);

const ebayLayeredFn = extractFunctionBlock(html, 'mrEbayBuildLayeredMainImageUrl');
assert(
  ebayLayeredFn.includes("await mrBuildMarketplaceLayeredMainImageUrl('ebay', mainImageUrl, sourceRow || firstRow)")
    && ebayLayeredFn.includes('firstRow._ebayLayeredMainImageSourceUrl = mainImageUrl')
    && ebayLayeredFn.includes('firstRow._ebayLayeredMainImageUrl = layeredUrl'),
  'eBay layered image builder must upload the master representative through the shared marketplace layer helper',
);

const ebayDraftFn = extractFunctionBlock(html, 'mrBuildEbayDraft');
assert(
  ebayDraftFn.includes('const representativeImageUrl = mrEbayRepresentativeImageUrl(group, sourceRow);')
    && ebayDraftFn.includes('const layeredMainImageUrl = await mrEbayBuildLayeredMainImageUrl(group, sourceRow, representativeImageUrl);')
    && ebayDraftFn.includes('imageUrls: mrEbayImageUrls(group, sourceRow, layeredMainImageUrl)'),
  'eBay draft creation must build default photos from the layered representative image',
);

const ebaySyncFn = extractFunctionBlock(html, 'mrEbaySyncModalDraft');
assert(
  ebaySyncFn.includes('draft.imageUrls = mrEbayImageUrls(draft.group, draft.sourceRow, draft.layeredMainImageUrl || draft.representativeImageUrl);'),
  'eBay modal edits must preserve the layered representative image when rebuilding imageUrls',
);

console.log('v2 marketplace layered image checks passed');
