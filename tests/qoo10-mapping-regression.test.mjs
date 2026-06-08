import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const bridge = readFileSync(join(process.cwd(), 'supabase/functions/qoo10-bridge/index.ts'), 'utf8');
const adapter = readFileSync(join(process.cwd(), 'supabase/functions/platform-publish/adapters/qoo10.ts'), 'utf8');
const html = readFileSync(join(process.cwd(), 'v2/index.html'), 'utf8');

test('Qoo10 option lookup only trusts seller option code fields, not internal OptionCode', () => {
  assert.doesNotMatch(
    bridge,
    /itemTypeCode:\s*firstNonEmpty\([^\n]*(row\?\.OptionCode|row\?\.optionCode)/s,
    'internal Qoo10 OptionCode must not be treated as a seller SKU match source'
  );
  assert.doesNotMatch(
    bridge,
    /sameSku\(row\.optionCode,\s*sku\)/,
    'known item lookup must not map a product by internal optionCode'
  );
});

test('Qoo10 platform-publish adapter rejects bridge hits that do not echo the requested SKU', () => {
  assert.match(
    adapter,
    /function\s+validateQoo10SkuHit\s*\(/,
    'adapter should validate the bridge response before absorb_platform_sku_lookup can run'
  );
  assert.match(
    adapter,
    /PLATFORM_SKU_MISMATCH/,
    'SKU mismatch responses should be blocked with an explicit error code'
  );
  assert.match(
    adapter,
    /json\?\.verified_sku\s*\|\|\s*json\?\.seller_code\s*\|\|\s*json\?\.option_code/,
    'validation should require the bridge to echo the requested seller SKU'
  );
});

test('Qoo10 adapter sends an existing item code as a verification hint when present', () => {
  assert.match(
    adapter,
    /lookupQoo10BySku\(sku,\s*userAuthToken,\s*existingItemCode\)/,
    'existing qoo10 platform_item_id should be verified against inventory before remapping'
  );
  assert.match(
    adapter,
    /item_code=\$\{encodeURIComponent\(itemCode\)\}/,
    'lookup URL should include item_code when available'
  );
});

test('Qoo10 create listing contract includes official registration side fields', () => {
  for (const token of [
    'ItemsBasic.SetNewGoods',
    'ItemsBasic.UpdateGoods',
    'ItemsContents.EditGoodsContents',
    'ItemsLookup.GetSellerDeliveryGroupInfo',
    'CommonInfoLookup.SearchBrand',
    'ItemsContents.EditGoodsHeaderFooter',
    'ItemsOptions.EditGoodsInventory',
    'ShippingNo',
    'BrandNo',
    'AvailableDateType',
    'AvailableDateValue',
    'ItemType',
    'InventoryInfo',
    'ProductionPlaceType: "2"',
    'ProductionPlace: String(body.production_place || "KR")',
  ]) {
    assert.match(bridge, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `qoo10-bridge must include ${token}`);
  }
  assert.match(adapter, /supports:\s*new Set\(\['create_listing', 'sync'\]\)/, 'Qoo10 adapter should support create_listing and sync');
  assert.match(adapter, /header_html/, 'Qoo10 create payload should forward header HTML for EditGoodsHeaderFooter');
  assert.match(adapter, /Qoo10 BrandNo is required/, 'Qoo10 create payload should require an operator-selected BrandNo');
  assert.match(adapter, /production_place:\s*norm\(qoo10\.production_place \|\| 'KR'\)/, 'Qoo10 create payload should default overseas origin to South Korea');
  assert.match(adapter, /force_options:\s*options\.length > 1/, 'Qoo10 grouped create payload should force ItemType option creation');
  assert.match(adapter, /option_products/, 'Qoo10 create result should expose option products for platform_listings fan-out');
});

test('Qoo10 V2 modal defaults match lifecycle-aware listing policy', () => {
  assert.match(html, /first\.qoo10_category_id \|\| '300002851'/, 'Qoo10 category should default to KPOP CD');
  assert.match(html, /const isPreOrder = mrQoo10IsPreOrder\(rows\);/, 'Qoo10 modal should choose preorder only for pre_order lifecycle products');
  assert.match(html, /qoo10_available_date_value:\s*availableType === '2' \? releaseDate : '3'/, 'Qoo10 ready-stock listings should use normal shipping within 3 business days');
  assert.match(html, /Overseas \/ South Korea \(KR\)/, 'Qoo10 modal should display the fixed origin policy');
  assert.match(html, /mrQoo10NormalizeHeaderHtml/, 'Qoo10 header should accept a raw image URL and normalize it to HTML');
  assert.match(html, /QOO10_DEFAULT_HEADER_IMAGE_URL = 'https:\/\/res\.cloudinary\.com\/dybau67eb\/image\/upload\/v1780901679\//, 'Qoo10 header should default to the Cloudinary notice image');
  assert.match(html, /QOO10_DEFAULT_DESCRIPTION_TEMPLATE = `<div>💿\{\{MASTER_PRODUCT_NAME\}\}/, 'Qoo10 description should default to the fixed Japanese template with master product name token');
  assert.match(html, /mrQoo10ApplyDescriptionTemplate/, 'Qoo10 description should support title placeholders in the fixed template');
  assert.match(html, /MASTER_PRODUCT_NAME\|MASTER_TITLE/, 'Qoo10 description template should replace master product name placeholders');
  assert.ok(html.includes("replace(/\\{\\{\\s*(TITLE|PRODUCT_TITLE)\\s*\\}\\}/gi"), 'Qoo10 description template should replace TITLE placeholders');
  assert.match(html, /mrQoo10BuildDescription\(descriptionTemplateHtml,\s*first\)/, 'Qoo10 description should combine template HTML with detail images');
  assert.match(html, /sdv2:qoo10:description_template_html/, 'Qoo10 description template should be persisted for reuse');
  assert.match(html, /mrQoo10LoadExistingItemCode/, 'Qoo10 modal should detect existing item codes before deciding create vs repair');
  assert.match(html, /mrQoo10RepairExistingListing/, 'Qoo10 modal should repair existing items instead of duplicate-registering them');
  assert.match(html, /mrQoo10LoadCountrySettings/, 'Qoo10 modal should load the Q10 fee settings row before rendering prices');
  assert.match(html, /calculateQoo10Price\(\{\s*costKrw: Number\(row\.cost_krw \|\| 0\),\s*weightG: Number\(row\.weight_g \|\| 0\),\s*countrySettings: settings,\s*\}\)/, 'Qoo10 modal option prices should use the shared Qoo10 price engine with shipping weight');
  assert.doesNotMatch(html, /Math\.round\(Number\(row\.cost_krw \|\| 0\) \/ 10\)/, 'Qoo10 modal must not fall back to the old cost/10 pricing stub');
  assert.match(html, /\/update-goods/, 'Qoo10 existing repair should update BrandNo, origin, and release-date fields');
  assert.match(html, /\/edit-contents/, 'Qoo10 existing repair should update detail contents');
  assert.match(html, /\/edit-inventory/, 'Qoo10 existing repair should create/update option seller codes');
});

test('Qoo10 registration prices are normalized to 90-ending JPY values', () => {
  assert.match(html, /normalizeQoo10PriceEnding90\(mrQoo10ReadNumber\('mr-qoo10-base-price', 0\)\)/, 'Qoo10 modal base price should normalize manual input to a 90-ending price');
  assert.match(html, /price_jpy:\s*normalizeQoo10PriceEnding90\(mrQoo10ReadNumber\(`mr-qoo10-price-\$\{idx\}`,\s*basePrice\)\)/, 'Qoo10 modal option prices should normalize manual input to 90-ending prices');
  assert.match(adapter, /function normalizeQoo10PriceEnding90/, 'platform-publish should defensively normalize Qoo10 prices');
  assert.match(bridge, /function normalizeQoo10PriceEnding90/, 'qoo10-bridge should defensively normalize Qoo10 prices');
});
