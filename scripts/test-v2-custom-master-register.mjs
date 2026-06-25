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
const customPanel = sliceBetween(registerView, 'data-register-workbench-panel="custom"', 'data-register-workbench-panel="url"');
const masterRegister = sliceBetween(
  html,
  '// MASTER REGISTER (view-register, 2-stage bulk URL+weight)',
  '// FEE / EXCHANGE-RATE SETTINGS',
);
const customHandler = sliceBetween(masterRegister, 'async function mrStageCustomMaster()', 'function mrStatusLabel');

assert.match(registerView, /data-register-workbench-target="custom"/, 'register method list must expose Custom Master');
assert.match(customPanel, /id="custom-master-cover-file"/, 'custom panel must require a representative image file');
assert.match(customPanel, /id="custom-master-detail-files"[^>]*multiple/, 'custom panel must accept multiple detail images');
assert.match(customPanel, /id="custom-master-components"/, 'custom panel must collect product components');
assert.match(customPanel, /id="custom-master-cost"/, 'custom panel must collect settlement price');
assert.match(customPanel, /id="custom-master-sourcing-price"/, 'custom panel may collect wholesale price');
assert.match(customPanel, /id="custom-master-weight"/, 'custom panel must collect a default weight');
assert.match(customPanel, /id="custom-master-inventory"/, 'custom panel must collect a default inventory quantity');
assert.match(customPanel, /id="custom-master-option-mode"/, 'custom panel must expose single/options mode');
assert.match(customPanel, /<option value="single" selected>단일 상품<\/option>/, 'custom panel must default to single product mode');
assert.match(customPanel, /<option value="options">옵션 있음<\/option>/, 'custom panel must support option products');
assert.match(customPanel, /id="custom-master-axis-wrap"[^>]*display:none/, 'option axis name must be hidden in single mode');
assert.match(customPanel, /id="custom-master-axis-name" value="Option"/, 'option products must default the axis name to Option');
assert.match(customPanel, /id="custom-master-option-section"[^>]*display:none/, 'option rows must be hidden in single mode');
assert.match(customPanel, /옵션 이미지는 선택 사항입니다/, 'custom UI must say option images are optional');
assert.match(customPanel, /type="hidden" id="custom-master-product-kind" value="goods"/, 'custom product kind must default to hidden goods');
assert.match(customPanel, />마스터 상품 생성<\/button>/, 'custom action button must create the master directly');
assert.doesNotMatch(customPanel, /Custom preview 만들기/, 'custom flow must not advertise a preview step');
assert.doesNotMatch(customPanel, /id="custom-master-artist"/, 'custom panel must not require Artist');
assert.doesNotMatch(customPanel, /id="custom-master-album"/, 'custom panel must not require Album');
assert.doesNotMatch(customPanel, /id="custom-master-version"/, 'custom panel must not require Version');
assert.doesNotMatch(customPanel, /id="custom-master-release-date"/, 'custom panel must not ask for Qoo10 release date');

assert.match(html, /data-master-register-open="global"/, 'product list action bar must open the unified master registration panel');
assert.doesNotMatch(html, /data-master-register-open="custom"/, 'custom registration must live inside the unified master registration panel');
assert.match(html, /window\.sdRegisterWorkbenchActivate\(\['url', 'custom', 'wms', 'retry'\]\.includes\(target\) \? target : 'global'\)/, 'panel opener must route custom target');

assert.match(masterRegister, /async function mrStageCustomMaster\(\)/, 'custom create handler must exist');
assert.match(masterRegister, /function mrCustomToggleOptionMode\(\)/, 'custom option mode toggle must exist');
assert.match(masterRegister, /function mrCustomSkuBaseFromTitle\(title\)/, 'custom SKU must be generated from product title');
assert.match(masterRegister, /async function mrPromoteCustomRowsDirect\(group\)/, 'custom create must promote directly without preview');
assert.match(masterRegister, /dataset: \{ customOptionFile: '1' \}/, 'custom option rows must support option image files');
assert.match(masterRegister, /dataset: \{ customOptionSku: '1' \}/, 'custom option rows must support manual SKU overrides');
assert.match(masterRegister, /dataset: \{ customOptionSourcing: '1' \}/, 'custom option rows must support option-level wholesale price');
assert.match(masterRegister, /dataset: \{ customOptionCost: '1' \}/, 'custom option rows must support option-level settlement price');
assert.match(masterRegister, /dataset: \{ customOptionWeight: '1' \}/, 'custom option rows must support option-level weight');
assert.match(masterRegister, /dataset: \{ customOptionInventory: '1' \}/, 'custom option rows must support option-level inventory');
assert.match(customHandler, /const productKind = PRODUCT_KIND_GOODS/, 'custom stage must force Goods product kind');
assert.match(customHandler, /const costKrw = explicitCost > 0 \? explicitCost : sourcingPrice/, 'custom stage must not auto-multiply wholesale into settlement');
assert.match(customHandler, /const weightG = Number\(\$\('custom-master-weight'\)\?\.value \|\| 0\) \|\| 200/, 'custom stage must default hidden advanced weight to 200g');
assert.match(customHandler, /const inventory = Number\(\$\('custom-master-inventory'\)\?\.value \|\| 0\) \|\| 50/, 'custom stage must default inventory to a publishable quantity');
assert.match(customHandler, /if \(!components\)/, 'custom stage must require product components');
assert.match(customHandler, /if \(!hasOptions && !\(costKrw > 0\)\)/, 'custom stage must require top-level cost only for single products');
assert.match(customHandler, /if \(hasOptions && !optionInputs\.length\)/, 'option mode must require at least one option');
assert.match(customHandler, /const optionSourcingPrice = Number\(opt\.sourcingPrice \|\| 0\) > 0 \? Number\(opt\.sourcingPrice \|\| 0\) : sourcingPrice/, 'custom stage must calculate per-option wholesale price');
assert.match(customHandler, /const optionCostKrw = Number\(opt\.costKrw \|\| 0\) > 0 \? Number\(opt\.costKrw \|\| 0\) : optionSourcingPrice/, 'custom stage must calculate per-option settlement price');
assert.match(customHandler, /const optionWeightG = Number\(opt\.weightG \|\| 0\) > 0 \? Number\(opt\.weightG \|\| 0\) : weightG/, 'custom stage must calculate per-option weight');
assert.match(customHandler, /const optionInventory = Number\(opt\.inventory \|\| 0\) > 0 \? Math\.floor\(Number\(opt\.inventory \|\| 0\)\) : inventory/, 'custom stage must calculate per-option inventory');
assert.match(customHandler, /mrPromoteCustomRowsDirect\(group\)/, 'custom stage must call direct promote');
assert.match(customHandler, /mrOpenCreatedMasterEdit\(createdIds\[0\]\)/, 'custom stage must open the created master edit modal');
assert.doesNotMatch(customHandler, /rshSettlementFromSourcing/, 'custom stage must not use StarOneMall wholesale settlement calculation');
assert.doesNotMatch(customHandler, /sdRegisterWorkbenchActivate\('url'\)/, 'custom stage must not switch into URL preview');
assert.doesNotMatch(customHandler, /mrRenderPreviewCards\(\)/, 'custom stage must not render the preview cards');
assert.match(masterRegister, /db\.rpc\('stage_custom_master_payload', \{ p_payload: payload \}\)/, 'custom stage must still call the staging RPC');
assert.match(masterRegister, /db\.rpc\('promote_source_to_product'/, 'custom direct create must support single product promotion');
assert.match(masterRegister, /db\.rpc\('promote_source_group_to_products'/, 'custom direct create must support option group promotion');
assert.match(masterRegister, /_custom_option_image_url: opt\.option_image_url \|\| ''/, 'custom option images must be tracked separately');
assert.match(masterRegister, /row\._sku = opt\.sku \|\| mrCustomSkuForOption/, 'custom option rows must prefer manual SKU over generated SKU');
assert.match(masterRegister, /_inventory_quantity: opt\.inventory/, 'custom option inventory must be stored on the preview row before direct promotion');
assert.match(masterRegister, /shopee_option_image_url: row\._custom_option_image_url \|\| row\._main_image \|\| null/, 'custom option image URL must fall back to the representative image');
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
