import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const migration = readFileSync(
  join(root, 'supabase', 'migrations', '202606150001_custom_master_payload_stage.sql'),
  'utf8',
);
const productKindMigration = readFileSync(
  join(root, 'supabase', 'migrations', '202606150002_product_kind_custom_categories.sql'),
  'utf8',
);

function sliceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `missing start token: ${start}`);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(endIndex > startIndex, `missing end token after ${start}`);
  return source.slice(startIndex, endIndex);
}

const registerView = sliceBetween(html, '<div id="view-register"', '</div><!-- /view-register -->');
const masterRegister = sliceBetween(
  html,
  '// MASTER REGISTER (view-register, 2-stage bulk URL+weight)',
  '// FEE / EXCHANGE-RATE SETTINGS',
);

assert.match(registerView, /data-register-workbench-target="custom"/, 'register method list must expose Custom Master');
assert.match(registerView, /data-register-workbench-panel="custom"/, 'register workbench must include the custom panel');
assert.match(registerView, /id="custom-master-cover-file"/, 'custom panel must require a representative image file');
assert.match(registerView, /id="custom-master-detail-files"[^>]*multiple/, 'custom panel must accept multiple detail images');
assert.match(registerView, /옵션 이미지 파일은 선택 사항입니다/, 'custom UI must say option images are optional');
assert.match(registerView, /id="custom-master-product-kind"/, 'custom panel must expose the product type selector');
assert.match(registerView, /<option value="album" selected>Album<\/option>/, 'custom product type selector must default to Album');
assert.match(registerView, /<option value="goods">Goods \/ Idol Collectibles<\/option>/, 'custom product type selector must expose Goods / Idol Collectibles');

assert.match(html, /data-master-register-open="custom"/, 'product list action bar must open custom registration');
assert.match(html, /target === 'custom' \? '커스텀 마스터 등록'/, 'master register panel title must handle custom');
assert.match(html, /window\.sdRegisterWorkbenchActivate\(\['url', 'custom', 'wms', 'retry'\]\.includes\(target\) \? target : 'global'\)/, 'panel opener must route custom target');

assert.match(masterRegister, /async function mrStageCustomMaster\(\)/, 'custom stage handler must exist');
assert.match(masterRegister, /dataset: \{ customOptionFile: '1' \}/, 'custom option rows must support option image files');
assert.match(masterRegister, /db\.rpc\('stage_custom_master_payload', \{ p_payload: payload \}\)/, 'custom stage must call the staging RPC');
assert.match(masterRegister, /normalizeProductKind\(\$\('custom-master-product-kind'\)\?\.value \|\| PRODUCT_KIND_ALBUM\)/, 'custom stage must read the custom-only product kind selector');
assert.match(masterRegister, /product_kind: productKind/, 'custom staged payload and preview rows must carry product_kind');
assert.match(masterRegister, /_product_kind: productKind/, 'custom preview rows must carry the selected product kind');
assert.match(masterRegister, /source: 'custom_master'/, 'custom preview rows must be marked as custom source');
assert.match(masterRegister, /_staronemall_url: ''/, 'custom preview rows must not carry a StarOneMall URL');
assert.match(masterRegister, /_custom_option_image_url/, 'custom option images must be tracked separately');
assert.match(masterRegister, /row\._custom_option_image_url \|\| null/, 'custom option image URL must persist when present and clear when absent');
assert.match(masterRegister, /비우면 대표 이미지 사용/, 'custom option image fallback must use the representative image');
assert.match(masterRegister, /function mrIsCustomGroup\(group\)/, 'custom groups must be distinguishable');
assert.match(masterRegister, /if \(mrIsCustomGroup\(group\)\) return '';/, 'custom groups must not trigger StarOneMall image recrawl');
assert.match(html, /const PRODUCT_KIND_ALBUM = 'album'/, 'Album product kind constant must exist');
assert.match(html, /const PRODUCT_KIND_GOODS = 'goods'/, 'Goods product kind constant must exist');
assert.match(html, /album:\s*Object\.freeze\(\{\s*shopee_category_id:\s*100740,[\s\S]*joom_category_id:\s*'music_albums'[\s\S]*qoo10_category_id:\s*'300002851'[\s\S]*ebay_category_id:\s*PLATFORM_EBAY_DEFAULT_CATEGORY_ID/, 'Album defaults must keep existing platform category mappings');
assert.match(html, /const PLATFORM_JOOM_GOODS_CATEGORY_ID = '1733235756332554566-61-2-11859-1440023039'/, 'Goods Joom category constant must match the selected Memorabilia category');
assert.match(html, /const PLATFORM_QOO10_GOODS_CATEGORY_ID = '300002855'/, 'Goods Qoo10 category constant must match KPOP goods');
assert.match(html, /const PLATFORM_EBAY_GOODS_CATEGORY_ID = '108857'/, 'Goods eBay category constant must match K-Pop Memorabilia');
assert.match(html, /goods:\s*Object\.freeze\(\{\s*shopee_category_id:\s*101390,[\s\S]*joom_category_id:\s*PLATFORM_JOOM_GOODS_CATEGORY_ID[\s\S]*qoo10_category_id:\s*PLATFORM_QOO10_GOODS_CATEGORY_ID[\s\S]*ebay_category_id:\s*PLATFORM_EBAY_GOODS_CATEGORY_ID/, 'Goods defaults must apply the selected non-Shopee category mappings');
assert.match(masterRegister, /product_kind: PRODUCT_KIND_ALBUM/, 'URL and WMS registration paths must force Album product_kind');
assert.doesNotMatch(html, /const is101390Blocked/, 'Shopee Goods category 101390 must not be blocked by the old Phase B guard');
assert.doesNotMatch(html, /catBlocked \|\| staronemallMissing/, 'Shopee Goods category 101390 must not disable the registration submit button');
assert.match(html, /const opt = catSel\.querySelector\(`option\[value="\$\{masterCatId\}"\]`\)/, 'Shopee modal must preserve the master category instead of forcing 101390 back to Album');

assert.match(migration, /create or replace function public\.stage_custom_master_payload/, 'migration must create custom staging RPC');
assert.match(migration, /'manual'/, 'custom source_records must use the existing manual source type');
assert.match(migration, /custom:\/\/master\//, 'custom source_records must use a synthetic non-StarOneMall URL');
assert.doesNotMatch(migration, /source_records_source_type_check/, 'migration must not rewrite the source_type constraint');
assert.doesNotMatch(migration, /check\s*\(\s*source_type\s+in[\s\S]*custom_master/i, 'migration must not require a new source_type constraint value');
assert.match(migration, /grant execute on function public\.stage_custom_master_payload\(jsonb\) to authenticated/, 'authenticated operators need execute grant');
assert.match(productKindMigration, /add column if not exists product_kind text not null default 'album'/, 'products must store product_kind with Album as the legacy-safe default');
assert.match(productKindMigration, /check \(product_kind in \('album', 'goods'\)\)/, 'product_kind must be constrained to supported values');
assert.match(productKindMigration, /v_product_kind := lower\(nullif\(btrim\(coalesce\(v_payload ->> 'product_kind', 'album'\)\), ''\)\)/, 'custom staging RPC must normalize product_kind from payload');
assert.match(productKindMigration, /'product_kind', v_product_kind/, 'custom staging RPC must write product_kind into observed values');

console.log('v2 custom master register checks passed');
