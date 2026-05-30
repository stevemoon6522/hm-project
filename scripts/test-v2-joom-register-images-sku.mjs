import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const bridge = readFileSync(join(root, 'supabase', 'functions', 'joom-bridge', 'index.ts'), 'utf8');

const masterRegister = sliceBetween(
  html,
  '// MASTER REGISTER (view-register, 2-stage bulk URL+weight)',
  '// FEE / EXCHANGE-RATE SETTINGS',
);
const promoteJoom = sliceBetween(
  masterRegister,
  'async function mrPromoteJoom(group)',
  'async function mrPromoteEbay(group)',
);
const buildPayload = sliceBetween(
  bridge,
  'async function buildPayload(opts: any): Promise<any>',
  'function jsonResp(body: any, status = 200): Response',
);

assert(masterRegister.includes('async function mrJoomLoadDetailImages(group)'), 'V2 Joom flow must load StarOneMall detail images');
assert(masterRegister.includes('write_to_source_records: false'), 'Joom detail crawl fallback must not create duplicate source_records');
assert(html.includes('data-open-joom-group="${text(first.product_group_id || \'\')}"'), 'Product list grouped Joom cell must expose a Joom register button');
assert(html.includes('openRegisterJoomGroupModal(btn.dataset.openJoomGroup)'), 'Product list Joom register button must open the Joom publish confirmation flow');
assert(html.includes('function plBuildJoomPublishGroupFromProducts(rows)'), 'Product list Joom publish must adapt products rows into the tested mrPromoteJoom payload shape');
assert(html.includes("_joomCategory: 'music_albums'"), 'Product list Joom publish must reuse the tested default Joom category');
assert(promoteJoom.includes('detailImages = await mrJoomLoadDetailImages(group)'), 'Joom payload must include detail images');
assert(!promoteJoom.includes('detailImages: []'), 'Joom detailImages must not be hard-coded empty');
assert(promoteJoom.includes('image: r._main_image ||'), 'Joom variants must include master option image URLs');
assert(promoteJoom.includes('weight: weightG'), 'Joom variants must include per-option weight');
assert(masterRegister.includes('if (allSkus.length === 1) return allSkus[0]'), 'Single-option Joom parent SKU must equal option SKU');
assert(promoteJoom.includes('let parentSku = mrJoomParentSku(group, activeRows)'), 'Joom publish must use the explicit parent SKU helper');

assert(buildPayload.includes('hasExplicitVariants'), 'Joom bridge must distinguish explicit variants from fallback DEFAULT');
assert(buildPayload.includes('single variant product sku must equal option sku'), 'Joom bridge must enforce single-option parent SKU parity');
assert(buildPayload.includes('cfg.sku || (!hasExplicitVariants'), 'Joom bridge must not invent SKUs for explicit variants');
assert(buildPayload.indexOf('...(scrapedAssets.detailImages || [])') < buildPayload.indexOf('...(scrapedAssets.extraImages || [])'), 'Joom extraImages must place detail images immediately after the main image');
assert(bridge.includes('function readImageDimensions'), 'Joom detail splitter must read remote image dimensions without full decode');
assert(bridge.includes('async function buildCloudinaryFetchTiles'), 'Joom detail splitter must support Cloudinary fetch transformations');
assert(bridge.includes('/image/fetch/'), 'Joom detail splitter must produce Cloudinary fetch URLs');
assert(bridge.includes('async function uploadTileToProductStorage'), 'Joom detail splitter must fall back to Supabase Storage tile hosting');
assert(bridge.includes('product-images'), 'Joom storage tile fallback must use the public product-images bucket');
assert(bridge.includes('Math.min(Math.ceil(img.height / tileSize), 9)'), 'Joom detail splitter must use up to 9 square tiles');
assert(bridge.includes('tile.crop(0, y, img.width, h)'), 'Joom detail splitter must crop tiles explicitly');
assert(bridge.includes('square.encodeJPEG(90)'), 'Joom detail splitter must encode tiles as JPEGs before Cloudinary upload');
assert(buildPayload.includes('if (cfg.image) v.mainImage = cfg.image'), 'Joom bridge must send option images to each variant');

console.log('v2 Joom register image/SKU checks passed');
