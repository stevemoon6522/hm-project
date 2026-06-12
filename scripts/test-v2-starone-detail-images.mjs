import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
const crawler = readFileSync(join(root, 'supabase', 'functions', 'starone-crawl', 'index.ts'), 'utf8');
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');

for (const token of [
  'function isRasterImageUrl',
  'function isLikelyDetailImageUrl',
  'const detailContainers = [',
  '".goods_detail"',
  '".prd-detail"',
  'isLikelyDetailImageUrl(src)',
  'function extractDetailImages(doc, maxN = Number.POSITIVE_INFINITY)',
  'const detail_image_urls = extractDetailImages(doc);',
]) {
  assert(crawler.includes(token), `StarOneMall crawler missing robust detail image token: ${token}`);
}

assert(!crawler.includes('extractDetailImages(doc, 20)'), 'StarOneMall crawler must not cap product detail images at 20');
assert(!crawler.includes('filterStaronemallDetailImageUrls(dedupArr(urls)).slice(0, maxN)'), 'StarOneMall crawler must preserve all detail images by default');

for (const token of [
  'detailImageSources',
  'rshSplitDetailImageRef',
  'rshBuildDetailUploadRefs',
  'REGISTER_MAX_IMAGE_IDS - 1',
  'image_id_list: globalImageIds',
  '_rsh.detailImageSources = detailImages',
]) {
  assert(html.includes(token), `Shopee register flow missing detail-image token: ${token}`);
}

assert(!html.includes('_rsh.detailImageSources = detailImages.slice(0, REGISTER_MAX_IMAGE_IDS - 1)'), 'URL register must keep all crawled detail image sources before platform upload caps');

console.log('v2 StarOneMall detail image checks passed');
