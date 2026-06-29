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
const edgeBridge = readFileSync(join(root, 'edge-functions', 'joom-bridge', 'index.ts'), 'utf8');
const joomAdapter = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'joom.ts'), 'utf8');
const decorativeEmojiMarkers = ['\u{1F4BF}', '\u{1F4CA}', '\u{1F4E6}', '\u{1F4CC}', '\u{26A0}\u{FE0F}'];

const masterRegister = sliceBetween(
  html,
  '// MASTER REGISTER (view-register, 2-stage bulk URL+weight)',
  '// FEE / EXCHANGE-RATE SETTINGS',
);
const promoteJoom = sliceBetween(
  masterRegister,
  'async function mrPromoteJoom(group)',
  'eBay registration modal + publish flow',
);
const buildPayload = sliceBetween(
  bridge,
  'async function buildPayload(opts: any): Promise<any>',
  'function jsonResp(body: any, status = 200): Response',
);

assert(masterRegister.includes('async function mrJoomLoadDetailImages(group)'), 'V2 Joom flow must load StarOneMall detail images');
assert(masterRegister.includes('write_to_source_records: false'), 'Joom detail crawl fallback must not create duplicate source_records');
assert(html.includes('id="platform-joom-root"'), 'Joom platform tab must render a dedicated workbench root');
assert(html.includes('data-platform-quick="register" data-platform-key="${text(key)}"'), 'Platform tabs must expose a quick register action for grouped and single products');
assert(html.includes('data-platform-preview="register"'), 'Joom platform tab must support register preview before execution');
assert(html.includes('function platformCanUseDispatcher(platform, action, group)')
  && html.includes('return false;')
  && html.includes('platform-specific dry-run and validation controls'),
  'Platform tabs must not bypass tested platform modal/dry-run paths through the generic dispatcher');
assert(html.includes("if (platform === 'joom') return openRegisterJoomGroupModal(targetId);"), 'Joom platform tab quick action must route to the existing Joom publish modal');
assert(html.includes('await platformOpenExistingModal(platform, group);'), 'Joom platform tab execution must be able to fall back to the existing modal route');
assert(html.includes('const variantRows = allRows.filter(plIsGroupedVariant);') && html.includes('const sortedRows = variantRows.length ? variantRows : allRows;'), 'Joom publish adapter must support both grouped variants and single master rows');
assert(html.includes('window.mrOpenJoomModal(plBuildJoomPublishGroupFromProducts(rows))'), 'Joom platform registration must open the Joom publish confirmation flow through the exported master-register bridge');
assert(html.includes('window.mrDeriveFromTitle = mrDeriveFromTitle') && html.includes('window.mrOpenJoomModal = mrOpenJoomModal'), 'Master-register Joom helpers must be exported for product-list Joom buttons');
assert(html.includes("typeof window.mrDeriveFromTitle === 'function'"), 'Product-list Joom adapter must not reference private master-register helpers directly');
assert(html.includes('function plBuildJoomPublishGroupFromProducts(rows)'), 'Product list Joom publish must adapt products rows into the tested mrPromoteJoom payload shape');
assert(html.includes("_joomCategory: normalizeJoomCategoryId(row.joom_category_id || productKindDefaults(productKindOfRow(row)).joom_category_id || '')"), 'Product list Joom publish must normalize saved/default Joom categories, including the Goods Memorabilia category');
assert(html.includes('main_image_urls: row.main_image ? [row.main_image] : []') && html.includes('detail_image_urls: Array.isArray(row.extra_images) ? row.extra_images : []'), 'Product-list Joom adapter must expose saved master representative/detail images to the Joom modal');
assert(html.includes('_main_image: row.shopee_option_image_url || row.main_image || \'\''), 'Product-list Joom/eBay adapter must pass saved master option images with a representative fallback');
assert(html.includes('id="mr-joom-modal-dryrun"'), 'Joom publish modal must expose a non-destructive dry-run button');
assert(masterRegister.includes('const MR_JOOM_DEFAULT_STOCK = 5'), 'Joom draft must default option stock to the video-confirmed minimum stock value');
assert(masterRegister.includes('const MR_JOOM_MAX_EXTRA_IMAGES = 20'), 'Joom extra images must honor the API max of 20 images');
assert(masterRegister.includes("const MR_JOOM_DEFAULT_CATEGORY_LABEL = 'Music Albums'"), 'Joom default category label should be Music Albums');
assert(masterRegister.includes("const MR_JOOM_DEFAULT_CATEGORY_ID = 'music_albums'"), 'Joom default category should use the Music Albums mapping by default');
assert(html.includes('const JOOM_CATEGORY_OPTIONS = Object.freeze'), 'Joom category options should be shared across master and registration modals');
assert(masterRegister.includes('data-joom-category-select="1"'), 'Joom publish modal must allow category selection for Goods products');
assert(masterRegister.includes('row.joom_category_id = value || null'), 'Joom category selector must sync the publish draft rows');
assert(masterRegister.includes('function mrLoadJoomBrandOptions'), 'Joom flow must load saved local brand candidates for selection');
assert(masterRegister.includes('function mrPopulateJoomBrandSelect'), 'Joom flow must render a brand select, not only a free-text input');
assert(masterRegister.includes('MR_JOOM_BRAND_CUSTOM_VALUE'), 'Joom brand select must keep a custom-entry fallback');
assert(masterRegister.includes('let _mrJoomAccountBrandOptionsCache = null'), 'Joom flow must keep account-derived brand candidates separate from local saved brand names');
assert(masterRegister.includes('function mrJoomAccountBrandMatch'), 'Joom flow must match product brand candidates against observed Joom account brands');
assert(masterRegister.includes('function mrApplyPreferredJoomBrand'), 'Joom flow must auto-select a safer account-observed brand before rendering the draft');
assert(masterRegister.includes("mrJoomBridgeUrl() + '/brand-options?limit=500'"), 'Joom flow must load brand candidates from the Joom account via the bridge');
assert(masterRegister.includes('id="mr-joom-brand"') && masterRegister.includes('id="mr-joom-brand-custom"'), 'Joom publish modal must allow brand selection before dry-run/live registration');
assert(
  masterRegister.includes('await mrLoadJoomBrandOptions(group);') || (
    masterRegister.includes('const brandOptionsPromise = mrLoadJoomBrandOptions(group);')
    && masterRegister.includes('await Promise.all([')
    && masterRegister.indexOf('mrApplyPreferredJoomBrand(group);') > masterRegister.indexOf('await Promise.all([')
  ),
  'Joom modal must load account brand options before rendering the draft',
);
assert(masterRegister.includes('mrApplyPreferredJoomBrand(group);'), 'Joom modal must apply the best account-derived brand candidate before draft/dry-run');
assert(masterRegister.includes('brand: draft.brand'), 'Joom dry-run signature must include the selected brand');
assert(masterRegister.includes("if (!brand) errors.push('Joom brand is required.')"), 'Joom draft must block empty brand values');

const brandPreferenceBlock = sliceBetween(
  masterRegister,
  'const MR_JOOM_BRAND_CACHE_KEY',
  'function mrReadStoredJoomBrandOptions',
);
const brandPreferenceResult = new Function(`${brandPreferenceBlock}
  _mrJoomAccountBrandOptionsCache = [
    { name: 'BTS', count: 46, states: ['active'] },
    { name: 'Hybe Labels', count: 1, states: ['warning'] },
  ];
  const group = { rows: [{
    _joomBrand: 'Hybe Labels',
    shopee_brand_name: 'Hybe Labels',
    qoo10_brand_name: '',
    artist: 'BTS',
  }] };
  return {
    preferred: mrJoomPreferredBrandForGroup(group),
    applied: mrApplyPreferredJoomBrand(group),
    rowBrand: group.rows[0]._joomBrand,
  };
`)();
assert(brandPreferenceResult.preferred === 'BTS' && brandPreferenceResult.applied === 'BTS' && brandPreferenceResult.rowBrand === 'BTS', 'Joom brand preference should choose the active account-observed artist brand over a warning marketplace brand');

assert(masterRegister.includes('function mrRowLifecycle(row)'), 'Master/Joom title helpers must resolve lifecycle from each master product row');
assert(masterRegister.includes('normalizeMasterProductNameForLifecycle(title, mrRowLifecycle(row), derived'), 'Master product names must use row.lifecycle_state instead of the master-register radio default');
assert(masterRegister.includes('function mrJoomNamePrefix(row)'), 'Joom title prefix must be derived from the master product lifecycle');
assert(masterRegister.includes('namePrefix: mrJoomNamePrefix(firstRow)'), 'Joom payload must send the lifecycle-specific namePrefix to the bridge');
assert(!masterRegister.includes('const MR_JOOM_DEFAULT_NAME_PREFIX = \'[PRE ORDER]\''), 'Joom title prefix must not be hard-coded to PRE ORDER');
assert(masterRegister.includes('function mrJoomCanonicalTitle(row)'), 'Joom title builder should keep the full master product name');
assert(masterRegister.includes('const masterName = mrJoomCanonicalTitle(row);') && masterRegister.includes('if (masterName) return mrJoomTitleCase(masterName).slice(0, 200);'), 'Joom build title should prefer the title-cased master product name before artist/album shorthand');
assert(masterRegister.includes('function mrJoomDescriptionTitle(row)'), 'Joom fixed description template title must have an explicit master-name helper');
assert(masterRegister.includes('const title = mrJoomDescriptionTitle(row) ||'), 'Joom fixed description template title must use the master product name before listing-title fallback');
assert(masterRegister.includes('function mrMasterRepresentativeImage(group)'), 'Joom draft must derive the main image from the master representative image');
assert(masterRegister.includes('const mainImageUrl = mrMasterRepresentativeImage(group)'), 'Joom draft must use the master representative image as the payload main image');
assert(masterRegister.includes('function mrJoomDetailImageCandidates(group, mainImageUrl = \'\')'), 'Joom modal and payload draft must share the same detail image candidate list');
assert(masterRegister.includes('extraImages = mrJoomDetailImageCandidates(group, mainImageUrl)'), 'Joom draft must expose detail image candidates for modal preview');
assert(masterRegister.includes('...(firstRow._extra_images || [])') && masterRegister.includes('...(firstRow.extra_images || [])'), 'Joom representative image must fall back to saved detail images when main_image is missing');
assert(masterRegister.includes('async function mrEnsureJoomSourceImages(group)'), 'Joom draft must be able to fill missing saved images from the source URL');
assert(masterRegister.includes('await mrEnsureJoomSourceImages(group);'), 'Joom payload/draft opening must refresh source images before validating');
assert(masterRegister.includes('const optionImageRequired = options.length > 1'), 'Single-option Joom products must not require a variant/option image');
assert(masterRegister.includes('if (optionImageRequired)') && masterRegister.includes('if (!o.imageUrl) errors.push'), 'Joom option image validation must only block multi-option products');
assert(masterRegister.includes('function mrJoomImageThumbHtml(url, label, meta = \'\')'), 'Joom modal must render real image thumbnails, not URL-only image fields');
assert(masterRegister.includes('<img src="${text(imageUrl)}"'), 'Joom modal image preview must render actual img tags');
assert(masterRegister.includes('function mrJoomRenderImagePreview(draft)'), 'Joom modal must have a dedicated main/detail image preview layout');
assert(masterRegister.includes('id="mr-joom-image-role-layout"'), 'Joom modal image preview must use a Shopee-like role layout container');
assert(masterRegister.includes('Joom mainImage') && masterRegister.includes('Joom extraImages[0..19]'), 'Joom modal image preview must label mainImage and extraImages roles');
assert(masterRegister.includes('mrJoomOptionImageCellHtml(o.imageUrl'), 'Joom option table must show option images as thumbnails');
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
assert(promoteJoom.includes('extraImages: [],') && promoteJoom.includes('detailImages,'), 'Joom payload should send source detail images once and let the bridge build extraImages');
assert(masterRegister.includes('image: o.imageUrl'), 'Joom variants must include master option image URLs from the draft');
assert(promoteJoom.includes('weight: weightG'), 'Joom variants must include per-option weight');
assert(masterRegister.includes('if (allSkus.length === 1) return allSkus[0]'), 'Single-option Joom parent SKU must equal option SKU');
assert(promoteJoom.includes('let parentSku = mrJoomParentSku(group, activeRows)'), 'Joom publish must use the explicit parent SKU helper');

assert(buildPayload.includes('hasExplicitVariants'), 'Joom bridge must distinguish explicit variants from fallback DEFAULT');
assert(bridge.includes('Cash on Delivery (COD) Policy'), 'Joom bridge description must include the fixed video-derived COD policy section');
assert(buildPayload.includes('single variant product sku must equal option sku'), 'Joom bridge must enforce single-option parent SKU parity');
assert(buildPayload.includes('cfg.sku || (!hasExplicitVariants'), 'Joom bridge must not invent SKUs for explicit variants');
assert(bridge.includes('function uniqueExtraImageUrls') && buildPayload.includes('const rawExtras = uniqueExtraImageUrls(scrapedAssets);'), 'Joom bridge must de-duplicate detail/extra image sources before square conversion');
assert(bridge.includes('import { AUTH_CORS, requireAuthenticatedUser } from "../_shared/auth.ts"'), 'Joom bridge must import the shared browser-session auth guard');
assert(bridge.includes('async function requireBridgeTokenOrAuthenticatedUser'), 'Joom bridge must allow either server bridge token or signed-in browser session');
assert(!bridge.includes('if ((action === "publish" || action === "dryrun") && req.method === "POST") {\n      const internalDenied = requireInternalBridge(req);'), 'Browser-originated Joom publish/dryrun must not require only the server internal bridge token');
assert(!bridge.includes('if (action === "lookup-sku" && req.method === "GET") {\n      const internalDenied = requireInternalBridge(req);'), 'Browser-originated Joom lookup-sku must not require only the server internal bridge token');
assert(bridge.includes('function readImageDimensions'), 'Joom detail splitter must read remote image dimensions without full decode');
assert(bridge.includes('async function buildCloudinaryFetchTiles'), 'Joom detail splitter must support Cloudinary fetch transformations');
assert(bridge.includes('/image/fetch/'), 'Joom detail splitter must produce Cloudinary fetch URLs');
assert(bridge.includes('const JOOM_EXTRA_IMAGE_TILE_SIZE = 1500') && bridge.includes('c_pad,b_white,w_${targetSize},h_${targetSize}'), 'Joom detail splitter must square-pad and downscale boundary images instead of sending the raw rectangular URL');
assert(bridge.includes('function joomPlainText') && bridge.includes('replace(/<[^>]+>/g, " ")') && bridge.includes('replace(/[^\\x09\\x0A\\x0D\\x20-\\x7E]/g, "")'), 'Joom bridge descriptions must be plain ASCII text without HTML tags');
const stripKoreanBlock = sliceBetween(bridge, 'function stripKorean(s: string): string', 'function joomPlainText(value: string): string');
const joomPlainTextBlock = sliceBetween(bridge, 'function joomPlainText(value: string): string', 'function hasLifecyclePrefix(value: string): boolean');
assert(!stripKoreanBlock.includes('replace(/\\s+/g, " ")'), 'Joom plain-text sanitizer must not collapse line breaks before description formatting');
assert(joomPlainTextBlock.includes('replace(/\\\\r\\\\n|\\\\n|\\\\r/g, "\\n")'), 'Joom plain-text sanitizer must restore escaped newline sequences from saved component text');
assert(joomPlainTextBlock.includes('replace(/\\r\\n?/g, "\\n")'), 'Joom plain-text sanitizer must normalize CRLF while preserving product component lines');
assert(decorativeEmojiMarkers.every((marker) => !bridge.includes(`"${marker}`)), 'Joom bridge description template must not send decorative emoji/non-ASCII markers');
assert(bridge.includes('async function createOrUpdateJoomProduct') && bridge.includes('/products/update?sku=') && bridge.includes('recovered_existing_product_id'), 'Joom bridge publish must update an existing rejected SKU instead of blindly creating duplicates');
assert(bridge.includes('async function uploadTileToProductStorage'), 'Joom detail splitter must fall back to Supabase Storage tile hosting');
assert(bridge.includes('product-images'), 'Joom storage tile fallback must use the public product-images bucket');
assert(bridge.includes('const JOOM_MAX_EXTRA_IMAGES = 20'), 'Joom bridge must cap extraImages at the API max of 20');
assert(buildPayload.includes('if (!brandName) throw new Error("brand required")'), 'Joom bridge must reject publish payloads without a selected brand');
assert(bridge.includes('action === "brand-options"') && bridge.includes('/products/multi?limit=${safeLimit}') && bridge.includes('Product.brand'), 'Joom bridge must expose account-derived brand candidates from official /products/multi data');
assert(!bridge.includes('return [imageUrl];'), 'Joom detail processing must not fall back to sending unsquared source URLs');
assert(bridge.includes('const fallback = joomPlainText(opts.fallbackName || "");') && bridge.indexOf('if (fallback) return titleWithPrefix(prefix, fallback).slice(0, 200);') < bridge.indexOf('if (artist && album)'), 'Joom bridge title should prefer sanitized fallback master name before artist/album shorthand');
assert(bridge.includes('Math.min(Math.ceil(img.height / tileSize), 9)'), 'Joom detail splitter must use up to 9 square tiles');
assert(bridge.includes('tile.crop(0, y, img.width, h)'), 'Joom detail splitter must crop tiles explicitly');
assert(bridge.includes('Math.min(Math.ceil(img.width / tileSize), 9)') && bridge.includes('tile.crop(x, 0, w, img.height)'), 'Joom detail splitter must also tile wide rectangular images');
assert(bridge.includes('square.composite(img, x, y)'), 'Joom detail splitter must pad near-square rectangles without cropping away content');
assert(bridge.includes('square.encodeJPEG(90)'), 'Joom detail splitter must encode tiles as JPEGs before Cloudinary upload');
assert(buildPayload.includes('if (cfg.image) v.mainImage = cfg.image'), 'Joom bridge must send option images to each variant');
assert(edgeBridge.includes('const JOOM_MAX_EXTRA_IMAGES = 20') && edgeBridge.includes('function uniqueExtraImageUrls') && !edgeBridge.includes('return [imageUrl];'), 'edge-functions Joom bridge mirror should square-convert and de-duplicate extra images');
assert(edgeBridge.includes('if (!brandName) throw new Error("brand required")'), 'edge-functions Joom bridge mirror should enforce selected brand parity');
assert(edgeBridge.includes('function joomPlainText') && edgeBridge.includes('async function createOrUpdateJoomProduct'), 'edge-functions Joom bridge mirror should sanitize descriptions and recover existing rejected SKUs');
assert(joomAdapter.includes('function isGoodsMaster'), 'platform-publish Joom adapter must distinguish Goods from Album masters');
assert(joomAdapter.includes("const JOOM_GOODS_CATEGORY_ID = '1733235756332554566-61-2-11859-1440023039'"), 'platform-publish Joom adapter must carry the selected Goods Memorabilia category ID');
assert(joomAdapter.includes("(goods ? JOOM_GOODS_CATEGORY_ID : 'music_albums')"), 'platform-publish Joom adapter should default Goods to Memorabilia and Album to Music Albums');
assert(joomAdapter.includes('function brandFrom') && joomAdapter.includes('master.shopee_brand_name') && joomAdapter.includes('master.qoo10_brand_name'), 'platform-publish Joom adapter must reuse registered marketplace brand columns');
assert(joomAdapter.includes('categoryId and brand'), 'platform-publish Joom adapter validation must block brandless Joom creates before hitting the bridge');

console.log('v2 Joom register image/SKU checks passed');
