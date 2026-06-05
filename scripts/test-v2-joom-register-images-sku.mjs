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
  '// ── eBay registration modal + publish flow',
);
const buildPayload = sliceBetween(
  bridge,
  'async function buildPayload(opts: any): Promise<any>',
  'function jsonResp(body: any, status = 200): Response',
);

assert(masterRegister.includes('async function mrJoomLoadDetailImages(group)'), 'V2 Joom flow must load StarOneMall detail images');
assert(masterRegister.includes('write_to_source_records: false'), 'Joom detail crawl fallback must not create duplicate source_records');
assert(html.includes('data-open-joom-group="${text(first.product_group_id || \'\')}"'), 'Product list grouped Joom cell must expose a Joom register button');
assert(html.includes('data-open-joom-single="${text(p.id)}"'), 'Product list single-row Joom cell must expose a Joom register button');
assert(html.includes('openRegisterJoomGroupModal(btn.dataset.openJoomSingle)'), 'Single-row Joom register button must reuse the Joom publish confirmation flow');
assert(html.includes('const variantRows = allRows.filter(plIsGroupedVariant);') && html.includes('const sortedRows = variantRows.length ? variantRows : allRows;'), 'Joom publish adapter must support both grouped variants and single master rows');
assert(html.includes('window.mrOpenJoomModal(plBuildJoomPublishGroupFromProducts(rows))'), 'Product list Joom register button must open the Joom publish confirmation flow through the exported master-register bridge');
assert(html.includes('window.mrDeriveFromTitle = mrDeriveFromTitle') && html.includes('window.mrOpenJoomModal = mrOpenJoomModal'), 'Master-register Joom helpers must be exported for product-list Joom buttons');
assert(html.includes("typeof window.mrDeriveFromTitle === 'function'"), 'Product-list Joom adapter must not reference private master-register helpers directly');
assert(html.includes('function plBuildJoomPublishGroupFromProducts(rows)'), 'Product list Joom publish must adapt products rows into the tested mrPromoteJoom payload shape');
assert(html.includes("_joomCategory: 'music_albums'"), 'Product list Joom publish must reuse the tested default Joom category');
assert(html.includes('main_image_urls: row.main_image ? [row.main_image] : []') && html.includes('detail_image_urls: Array.isArray(row.extra_images) ? row.extra_images : []'), 'Product-list Joom adapter must expose saved master representative/detail images to the Joom modal');
assert(html.includes('_main_image: row.shopee_option_image_url || row.main_image || \'\''), 'Product-list Joom/eBay adapter must pass saved master option images with a representative fallback');
assert(html.includes('id="mr-joom-modal-dryrun"'), 'Joom publish modal must expose a non-destructive dry-run button');
assert(masterRegister.includes('const MR_JOOM_DEFAULT_STOCK = 5'), 'Joom draft must default option stock to the video-confirmed minimum stock value');
assert(masterRegister.includes('const MR_JOOM_MAX_EXTRA_IMAGES = 20'), 'Joom extra images must honor the API max of 20 images');
assert(masterRegister.includes('function mrLoadJoomBrandOptions'), 'Joom flow must load saved local brand candidates for selection');
assert(masterRegister.includes('function mrPopulateJoomBrandSelect'), 'Joom flow must render a brand select, not only a free-text input');
assert(masterRegister.includes('MR_JOOM_BRAND_CUSTOM_VALUE'), 'Joom brand select must keep a custom-entry fallback');
assert(masterRegister.includes('brand: draft.brand'), 'Joom dry-run signature must include the selected brand');
assert(masterRegister.includes("if (!brand) errors.push('Joom brand is required.')"), 'Joom draft must block empty brand values');
assert(masterRegister.includes('function mrMasterRepresentativeImage(group)'), 'Joom draft must derive the main image from the master representative image');
assert(masterRegister.includes('const mainImageUrl = mrMasterRepresentativeImage(group)'), 'Joom draft must use the master representative image as the payload main image');
assert(!masterRegister.includes('data-joom-main-image-preview="1"'), 'Joom modal must not own the main-image confirmation UI');
assert(!masterRegister.includes('data-joom-option-image-input'), 'Joom modal must not own local-folder option image attachment');
assert(!masterRegister.includes('async function mrUploadJoomOptionImage'), 'Joom option image uploads must live in master-product UI, not Joom registration');
assert(masterRegister.includes('function mrJoomAssertOptionSkuLocked'), 'Joom draft must have an explicit immutable SKU lock guard');
assert(masterRegister.includes('optionSku !== masterSku'), 'Joom option SKU must be compared against the master product SKU before publishing');
assert(masterRegister.includes("mrJoomBridgeUrl() + '/dryrun'"), 'Joom modal must call the browser-auth dryrun route before live publish');
assert(masterRegister.includes('_mrPendingJoomDryRunOk'), 'Joom live publish must be gated by a successful dry-run');
assert(masterRegister.includes('group._joomDryRunSignature = _mrPendingJoomDraftSignature'), 'Joom confirm must bind the live publish to the exact dry-run draft signature');
assert(masterRegister.includes('return mrPromoteJoomLocked(group);'), 'Joom live publish must route through the locked draft/payload flow');
assert(masterRegister.includes('Cash on Delivery (COD) Policy'), 'Joom modal draft must preview the fixed video-derived COD policy section');
assert(promoteJoom.includes('detailImages = await mrJoomLoadDetailImages(group)'), 'Joom payload must include detail images');
assert(!promoteJoom.includes('detailImages: []'), 'Joom detailImages must not be hard-coded empty');
assert(masterRegister.includes('image: o.imageUrl'), 'Joom variants must include master option image URLs from the draft');
assert(promoteJoom.includes('weight: weightG'), 'Joom variants must include per-option weight');
assert(masterRegister.includes('if (allSkus.length === 1) return allSkus[0]'), 'Single-option Joom parent SKU must equal option SKU');
assert(promoteJoom.includes('let parentSku = mrJoomParentSku(group, activeRows)'), 'Joom publish must use the explicit parent SKU helper');

assert(buildPayload.includes('hasExplicitVariants'), 'Joom bridge must distinguish explicit variants from fallback DEFAULT');
assert(bridge.includes('Cash on Delivery (COD) Policy'), 'Joom bridge description must include the fixed video-derived COD policy section');
assert(buildPayload.includes('single variant product sku must equal option sku'), 'Joom bridge must enforce single-option parent SKU parity');
assert(buildPayload.includes('cfg.sku || (!hasExplicitVariants'), 'Joom bridge must not invent SKUs for explicit variants');
assert(buildPayload.indexOf('...(scrapedAssets.detailImages || [])') < buildPayload.indexOf('...(scrapedAssets.extraImages || [])'), 'Joom extraImages must place detail images immediately after the main image');
assert(bridge.includes('import { AUTH_CORS, requireAuthenticatedUser } from "../_shared/auth.ts"'), 'Joom bridge must import the shared browser-session auth guard');
assert(bridge.includes('async function requireBridgeTokenOrAuthenticatedUser'), 'Joom bridge must allow either server bridge token or signed-in browser session');
assert(!bridge.includes('if ((action === "publish" || action === "dryrun") && req.method === "POST") {\n      const internalDenied = requireInternalBridge(req);'), 'Browser-originated Joom publish/dryrun must not require only the server internal bridge token');
assert(!bridge.includes('if (action === "lookup-sku" && req.method === "GET") {\n      const internalDenied = requireInternalBridge(req);'), 'Browser-originated Joom lookup-sku must not require only the server internal bridge token');
assert(bridge.includes('function readImageDimensions'), 'Joom detail splitter must read remote image dimensions without full decode');
assert(bridge.includes('async function buildCloudinaryFetchTiles'), 'Joom detail splitter must support Cloudinary fetch transformations');
assert(bridge.includes('/image/fetch/'), 'Joom detail splitter must produce Cloudinary fetch URLs');
assert(bridge.includes('async function uploadTileToProductStorage'), 'Joom detail splitter must fall back to Supabase Storage tile hosting');
assert(bridge.includes('product-images'), 'Joom storage tile fallback must use the public product-images bucket');
assert(bridge.includes('const JOOM_MAX_EXTRA_IMAGES = 20'), 'Joom bridge must cap extraImages at the API max of 20');
assert(buildPayload.includes('if (!brandName) throw new Error("brand required")'), 'Joom bridge must reject publish payloads without a selected brand');
assert(!bridge.includes('return [imageUrl];'), 'Joom detail processing must not fall back to sending unsquared source URLs');
assert(bridge.includes('Math.min(Math.ceil(img.height / tileSize), 9)'), 'Joom detail splitter must use up to 9 square tiles');
assert(bridge.includes('tile.crop(0, y, img.width, h)'), 'Joom detail splitter must crop tiles explicitly');
assert(bridge.includes('square.encodeJPEG(90)'), 'Joom detail splitter must encode tiles as JPEGs before Cloudinary upload');
assert(buildPayload.includes('if (cfg.image) v.mainImage = cfg.image'), 'Joom bridge must send option images to each variant');

console.log('v2 Joom register image/SKU checks passed');
