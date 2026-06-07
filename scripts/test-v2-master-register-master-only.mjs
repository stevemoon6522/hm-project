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
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '202605280002_v2_product_image_storage.sql'),
  'utf8',
);
const masterRegister = sliceBetween(
  html,
  '// MASTER REGISTER (view-register, 2-stage bulk URL+weight)',
  '// FEE / EXCHANGE-RATE SETTINGS',
);

assert(masterRegister.includes('const MR_MASTER_ONLY_MODE = true'), 'master register must run in master-only mode');
assert(masterRegister.includes('function mrComputeSku(row)'), 'master register must define automatic SKU assembly');
assert(masterRegister.includes('mrSlug(row.artist, 8)'), 'SKU must include Artist');
assert(masterRegister.includes('mrSlug(row.album, 12)'), 'SKU must include Album');
assert(masterRegister.includes('mrSlug(row.version, 12)'), 'SKU must include full Version text such as PHOTOBOOK');
assert(masterRegister.includes('mrSlug(member, 12)'), 'SKU must include member/option name');
assert(masterRegister.includes('function mrMasterProductName(row)'), 'master register must build sanitized master product names');
assert(masterRegister.includes('normalizeMasterProductNameForLifecycle(title, mrLifecycle(), derived'), 'master product names must be sanitized and lifecycle-prefixed before saving');
assert(
  masterRegister.includes('if (!(Number(row._cost_krw) > 0)) row._cost_krw')
    && masterRegister.includes('initialDefaultCost'),
  'first option cost must fall back to the default purchase cost',
);
assert(masterRegister.includes('SKU (자동 생성)'), 'SKU input must be labeled as auto-generated');
assert(masterRegister.includes("readonly: 'readonly'"), 'SKU input must be read-only');
assert(!masterRegister.includes('SKU (수동 입력)'), 'manual SKU wording must be removed from master register');

assert(masterRegister.includes('mrUploadMasterImageFile'), 'master register must upload attached image files');
assert(masterRegister.includes('return sdUploadProductImageFile('), 'master register image upload must use the shared product image upload helper');
assert(masterRegister.includes("type: 'file'"), 'image input must be a file attachment');
assert(masterRegister.includes("accept: 'image/*'"), 'image input must accept images only');
assert(masterRegister.includes('메인/옵션 이미지 첨부 (1장)'), 'UI must communicate single option image attachment');
assert(masterRegister.includes('마스터 옵션 이미지 첨부 (로컬 1장)'), 'master register must own local-folder option image attachment wording');
assert(!masterRegister.includes('Joom 로컬 옵션 이미지'), 'master image attachment UI must not be labeled as Joom-specific');
assert(masterRegister.includes('function mrMasterRepresentativeImage(group)'), 'master register must derive a visible representative image');
assert(!masterRegister.includes('+ 추가 이미지'), 'master register must not render multiple extra image slots');
assert(!masterRegister.includes('while (row._extra_images.length < 2)'), 'master register must not require two extra images');
assert(masterRegister.includes('상품 구성품'), 'master register must expose a product components field');
assert(masterRegister.includes('이미지에서 추출'), 'master register must expose image-to-text components extraction');
assert(masterRegister.includes('mrExtractComponentsForGroup'), 'master register must call the Vision extraction helper');
assert(masterRegister.includes('STARONEMALL_VISION_URL'), 'components extraction must reuse the staronemall-vision function');
assert(masterRegister.includes('headers: AUTH_HEADERS'), 'components extraction must include Authorization bearer headers');
assert(html.includes('headers: AUTH_HEADERS'), 'wizard components extraction must include Authorization bearer headers');
assert(masterRegister.includes('대표 이미지'), 'master register must show a separate crawled representative image area');
assert(masterRegister.includes('옵션 이미지'), 'master register must show a separate crawled option image area');
assert(masterRegister.includes('mrRenderCrawledImagePreview'), 'master register must render crawled image previews before manual attachment');
assert(masterRegister.includes('observed.detail_image_urls'), 'option image preview must use Product introduction/detail images');
assert(!masterRegister.includes('const optionImages = normalizedMainImages.slice(1, 7)'), 'option image preview must not reuse representative/main images');
assert(masterRegister.includes('mrFilterStaronemallDetailImageUrls'), 'option image preview must exclude StarOneMall process/banner detail images');
assert(masterRegister.includes('옵션 이미지 관리'), 'operator must be able to open an option image management modal');
assert(masterRegister.includes('mrOpenOptionImageModal'), 'option image management modal must be wired');
assert(masterRegister.includes('구성품 추출용'), 'modal must allow selecting the image used for component extraction');
assert(masterRegister.includes('image_url: componentImageUrl'), 'components extraction must send the operator-selected detail image URL');
assert(masterRegister.includes('_detail_image_urls'), 'manual option image removals must be stored on the preview rows');
assert(masterRegister.includes('_components_image_url'), 'selected component image URL must be stored on the preview rows');
assert(masterRegister.includes('components_extracted_en'), 'components must be persisted into products');
assert(masterRegister.includes('components_approved: components ? 1 : 0'), 'operator-entered components must be saved as approved');
assert(masterRegister.includes('function mrConvertGroupToSingleProduct'), 'last option-row removal must convert the card to single-product mode');
assert(masterRegister.includes('_singleProductMode'), 'single-product mode must be stored on the remaining preview row');
assert(masterRegister.includes('const isLastOptionRow = group.rows.length <= 1'), 'row delete must detect the last option row separately');
assert(masterRegister.includes('mrConvertGroupToSingleProduct(group, row)'), 'last option-row delete must not remove the whole product card');
assert(masterRegister.includes("p_option_name:       row._singleProductMode ? null : (vOpt.option_names[0] || null)"), 'single-product DB save must use null option_name');
assert(masterRegister.includes('if (!row._singleProductMode && !row._opt0)'), 'option name validation must be skipped for single-product mode');
assert(masterRegister.includes('단품 상품'), 'single-product mode must be visible to the operator');

assert(masterRegister.includes('if (!MR_MASTER_ONLY_MODE) {'), 'platform-only UI/validation must be gated off');
assert(masterRegister.includes('if (MR_MASTER_ONLY_MODE)'), 'multi-option promotion must short-circuit after master creation');
assert(masterRegister.includes('continue;'), 'master-only promotion must skip platform publish logic');

assert(migration.includes("'product-images'"), 'storage migration must create product-images bucket');
assert(migration.includes('storage.buckets'), 'storage migration must configure storage bucket');
assert(migration.includes('product images authenticated insert'), 'storage migration must allow authenticated image upload');

console.log('v2 master register master-only checks passed');
