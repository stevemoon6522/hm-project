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
]) {
  assert(crawler.includes(token), `StarOneMall crawler missing robust detail image token: ${token}`);
}

for (const token of [
  'detailImageSources',
  'rshSplitDetailImageRef',
  'rshBuildDetailUploadRefs',
  'REGISTER_MAX_IMAGE_IDS - 1',
  'image_id_list: globalImageIds',
]) {
  assert(html.includes(token), `Shopee register flow missing detail-image token: ${token}`);
}

console.log('v2 StarOneMall detail image checks passed');
