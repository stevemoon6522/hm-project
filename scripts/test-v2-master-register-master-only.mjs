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
assert(masterRegister.includes('cleanProductName(title'), 'master product names must exclude Korean/CJK text before saving');
assert(
  masterRegister.includes('if (!(Number(row._cost_krw) > 0)) row._cost_krw')
    && masterRegister.includes('initialDefaultCost'),
  'first option cost must fall back to the default purchase cost',
);
assert(masterRegister.includes('SKU (자동 생성)'), 'SKU input must be labeled as auto-generated');
assert(masterRegister.includes("readonly: 'readonly'"), 'SKU input must be read-only');
assert(!masterRegister.includes('SKU (수동 입력)'), 'manual SKU wording must be removed from master register');

assert(masterRegister.includes('mrUploadMasterImageFile'), 'master register must upload attached image files');
assert(masterRegister.includes("type: 'file'"), 'image input must be a file attachment');
assert(masterRegister.includes("accept: 'image/*'"), 'image input must accept images only');
assert(masterRegister.includes('메인/옵션 이미지 첨부 (1장)'), 'UI must communicate single option image attachment');
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
assert(masterRegister.includes('components_extracted_en'), 'components must be persisted into products');
assert(masterRegister.includes('components_approved: components ? 1 : 0'), 'operator-entered components must be saved as approved');

assert(masterRegister.includes('if (!MR_MASTER_ONLY_MODE) {'), 'platform-only UI/validation must be gated off');
assert(masterRegister.includes('if (MR_MASTER_ONLY_MODE)'), 'multi-option promotion must short-circuit after master creation');
assert(masterRegister.includes('continue;'), 'master-only promotion must skip platform publish logic');

assert(migration.includes("'product-images'"), 'storage migration must create product-images bucket');
assert(migration.includes('storage.buckets'), 'storage migration must configure storage bucket');
assert(migration.includes('product images authenticated insert'), 'storage migration must allow authenticated image upload');

console.log('v2 master register master-only checks passed');
