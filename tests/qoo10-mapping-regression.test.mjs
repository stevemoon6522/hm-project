import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const bridge = readFileSync(join(process.cwd(), 'supabase/functions/qoo10-bridge/index.ts'), 'utf8');
const adapter = readFileSync(join(process.cwd(), 'supabase/functions/platform-publish/adapters/qoo10.ts'), 'utf8');
const priceEngine = readFileSync(join(process.cwd(), 'v2/price-engine.js'), 'utf8');
const html = readFileSync(join(process.cwd(), 'v2/index.html'), 'utf8');

function extractQoo10ShippingTable(source, label) {
  const match = source.match(/const QOO10_SHIPPING_FEE_TABLE_JPY = Object\.freeze\(\[\s*([\s\S]*?)\s*\]\);/);
  assert.ok(match, `${label} must define QOO10_SHIPPING_FEE_TABLE_JPY`);
  const rows = [...match[1].matchAll(/\{\s*maxWeightG:\s*(\d+),\s*feeJpy:\s*(\d+)\s*\}/g)]
    .map((row) => ({ maxWeightG: Number(row[1]), feeJpy: Number(row[2]) }));
  assert.ok(rows.length > 0, `${label} Qoo10 shipping table must have rows`);
  return rows;
}

function extractFunctionBody(source, functionName, label) {
  const start = source.search(new RegExp(`(?:export\\s+)?function\\s+${functionName}\\s*\\(`));
  assert.ok(start >= 0, `${label} must define ${functionName}`);
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `${label} ${functionName} must have a body`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i).replace(/\s+/g, '');
    }
  }
  assert.fail(`${label} ${functionName} body must close`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertObjectFieldUsesHelper(body, fieldName, helperName, label) {
  if (new RegExp(`${escapeRegExp(fieldName)}:${escapeRegExp(helperName)}\\(`).test(body)) return;
  const helperVar = body.match(new RegExp(`(?:const|let|var)([A-Za-z_$][\\w$]*)=${escapeRegExp(helperName)}\\(`));
  assert.ok(helperVar, `${label} must derive ${fieldName} from ${helperName}`);
  assert.match(
    body,
    new RegExp(`${escapeRegExp(fieldName)}:(?:Number\\()?${escapeRegExp(helperVar[1])}(?:\\))?(?:[,}])`),
    `${label} must wire ${fieldName} to the ${helperName} result`
  );
}

function assertBridgeFunctionNormalizesPositiveWeight(body, label) {
  const guard = body.match(/if\(([A-Za-z_$][\w$]*)>0\)\{?params\.Weight=\1\.toFixed\(1\);/);
  assert.ok(guard, `${label} must only set params.Weight when normalized kg is positive`);
  assert.match(
    body,
    new RegExp(`(?:const|let|var)${escapeRegExp(guard[1])}=normalizeQoo10WeightKg\\(`),
    `${label} must derive params.Weight from normalizeQoo10WeightKg`
  );
}

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

test('Qoo10 adapter create payload derives rounded kg weight from grams', () => {
  const helperBody = extractFunctionBody(adapter, 'qoo10WeightKgFromGrams', 'platform-publish adapter');
  assert.match(helperBody, /Math\.ceil\(/, 'Qoo10 adapter should round weight up');
  assert.match(helperBody, /\/1000/, 'Qoo10 adapter should convert grams to kg');
  assert.match(helperBody, /\*10/, 'Qoo10 adapter should round to one decimal kg');
  assert.match(helperBody, /\/10/, 'Qoo10 adapter should return one decimal kg');

  assertObjectFieldUsesHelper(
    extractFunctionBody(adapter, 'executeCreate', 'platform-publish adapter'),
    'weight_kg',
    'qoo10WeightKgFromGrams',
    'Qoo10 adapter create payload'
  );
  const createBody = extractFunctionBody(adapter, 'executeCreate', 'platform-publish adapter');
  assert.match(createBody, /Object\.prototype\.hasOwnProperty\.call\(qoo10,'weight_kg'\)/, 'Qoo10 adapter must treat weight_kg: 0 as an explicit value');
  assert.doesNotMatch(createBody, /qoo10\.weight_kg\|\|qoo10\.Weight/, 'Qoo10 adapter must not revive Weight fallback when weight_kg is explicitly 0');
});

test('Qoo10 bridge create and update payloads normalize positive Weight only', () => {
  extractFunctionBody(bridge, 'normalizeQoo10WeightKg', 'qoo10-bridge');
  const createBody = extractFunctionBody(bridge, 'handleCreateListing', 'qoo10-bridge');
  const updateBody = extractFunctionBody(bridge, 'updateGoodsBasic', 'qoo10-bridge');
  assertBridgeFunctionNormalizesPositiveWeight(createBody, 'Qoo10 bridge create listing');
  assertBridgeFunctionNormalizesPositiveWeight(updateBody, 'Qoo10 bridge update goods');
  assert.doesNotMatch(createBody, /body\.weight_kg\|\|body\.Weight/, 'Qoo10 bridge create must not revive Weight fallback when weight_kg is explicitly 0');
  assert.doesNotMatch(updateBody, /body\.weight_kg\|\|body\.Weight/, 'Qoo10 bridge update must not revive Weight fallback when weight_kg is explicitly 0');
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
  assert.match(adapter, /brand_no:\s*brandNo/, 'Qoo10 create payload should forward BrandNo when selected');
  assert.doesNotMatch(adapter, /Qoo10 BrandNo is required/, 'Qoo10 BrandNo is optional in SetNewGoods and must not block create');
  assert.match(adapter, /const QOO10_DEFAULT_SHIPPING_NO = '715009'/, 'Qoo10 create payload should fall back to the configured default ShippingNo');
  assert.match(adapter, /production_place:\s*norm\(qoo10\.production_place \|\| 'KR'\)/, 'Qoo10 create payload should default overseas origin to South Korea');
  assert.match(adapter, /force_options:\s*options\.length > 1/, 'Qoo10 grouped create payload should force ItemType option creation');
  assert.match(adapter, /option_products/, 'Qoo10 create result should expose option products for platform_listings fan-out');
  assert.match(adapter, /function\s+validateQoo10LayeredMainImage\s*\(/, 'Qoo10 adapter must validate that StandardImage came from the shop-layer upload path');
  assert.doesNotMatch(adapter, /main_image:\s*qoo10\.main_image \|\| ctx\.masterProduct\?\.main_image/, 'Qoo10 adapter must not silently fall back to the raw master image for StandardImage');
  assert.match(bridge, /function\s+validateQoo10LayeredStandardImage\s*\(/, 'Qoo10 bridge must reject raw StandardImage URLs before SetNewGoods');
  assert.match(bridge, /QOO10_SHOP_LAYER_VERSION = "qoo10-shop-layer-v1"/, 'Qoo10 bridge must require the shop-layer version marker');
  assert.match(bridge, /validateQoo10LayeredStandardImage\(body,\s*standardImage\)/, 'Qoo10 edit-image must also reject raw StandardImage replacements');
  assert.ok(bridge.includes('const normalized = String(value || "").trim().replace(/\\//g, "-");'), 'Qoo10 bridge should send preorder release dates as YYYY-MM-DD for Qoo10 DateTime parsing');
  assert.doesNotMatch(bridge, /replace\(\/-\/g,\s*"\/"\)/, 'Qoo10 bridge must not convert preorder release dates to slash format');
  assert.match(bridge, /const stockProvided = body\.stock != null \|\| body\.ItemQty != null \|\| itemTypeResult\.options\.length > 0;/, 'Qoo10 bridge should treat explicit stock=0 as a provided ItemQty value');
  assert.doesNotMatch(bridge, /if \(!stock && itemTypeResult\.options\.length <= 1\)/, 'Qoo10 bridge must not reject explicit stock=0 because ItemQty supports zero');
  assert.match(bridge, /function\s+normalizeQoo10DashDate\s*\(/, 'Qoo10 bridge should normalize optional dash-date fields explicitly');
  assert.match(bridge, /const expireDate = normalizeQoo10DashDate\(body\.expire_date \|\| body\.ExpireDate\);/, 'Qoo10 create should treat ExpireDate as an optional caller-provided field');
  assert.match(bridge, /if \(expireDate\) params\.ExpireDate = expireDate;/, 'Qoo10 create should omit ExpireDate when not provided so Qoo10 applies its own default');
  assert.doesNotMatch(bridge, /ExpireDate:\s*String\(body\.expire_date \|\| body\.ExpireDate \|\| "2030-12-31"\)/, 'Qoo10 create must not always send a default ExpireDate because Qoo10 can reject date parsing');
});

test('Qoo10 V2 modal defaults match lifecycle-aware listing policy', () => {
  assert.match(html, /const qoo10CategoryDefault = productKindIsGoods\(first\) \? '' : '300002851';/, 'Qoo10 category should default to KPOP CD only for Album products');
  assert.match(html, /first\.qoo10_category_id \|\| qoo10CategoryDefault/, 'Qoo10 modal should leave Goods category empty until selected');
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
  assert.match(html, /function\s+mrQoo10MainImageSource\s*\(/, 'Qoo10 modal should derive the representative image source before registration');
  assert.match(html, /function\s+mrQoo10RepresentativeImageRef\s*\(/, 'Qoo10 modal should centralize one automatic master representative image');
  assert.match(html, /function\s+mrQoo10SelectedMainImageUrl\s*\(/, 'Qoo10 modal should track the operator-selected representative image');
  assert.doesNotMatch(html, /mrQoo10AddImageRef\(refs,\s*seen,\s*row\._main_image/, 'Qoo10 representative candidates must not include per-option source images');
  assert.match(html, /function\s+mrQoo10WeightKgFromRows\s*\(/, 'Qoo10 modal should convert master weight_g to Qoo10 kg');
  assert.match(html, /allRows:\s*\[\]/, 'Qoo10 modal should keep the complete product group for image sourcing');
  assert.match(html, /mainImages:\s*\[\]/, 'Qoo10 modal should keep StarOneMall main images separate from detail images');
  assert.match(html, /function\s+mrQoo10ImageRows\s*\(/, 'Qoo10 image sourcing should preserve master/root rows even when option rows drive inventory');
  assert.match(html, /const \[groupRes, singleRes\] = await Promise\.all\(/, 'Qoo10 open flow should fetch both group rows and the target master row');
  assert.match(html, /\.\.\.\(singleRes\.data \|\| \[\]\),\s*\.\.\.\(groupRes\.data \|\| \[\]\)/, 'Qoo10 open flow should merge the target master row before grouped variants');
  assert.match(html, /_mrQoo10\.allRows = allRows;/, 'Qoo10 open flow should store the full group before rendering image controls');
  assert.match(html, /mrQoo10LoadDetailImages\(allRows\)/, 'Qoo10 image loader should crawl images from the full group source row');
  assert.match(html, /const mainImages = observed\.main_image_urls;/, 'Qoo10 image loader should read StarOneMall representative images');
  assert.match(html, /const detailImages = observed\.detail_image_urls;/, 'Qoo10 image loader should read StarOneMall detail images separately');
  assert.doesNotMatch(html, /mrQoo10AddImageRef\(refs,\s*seen,\s*row\.shopee_option_image_url/, 'Qoo10 representative candidates must not come from option images');
  assert.doesNotMatch(html, /mrQoo10DetailImageRefs\(list\)\.forEach\(\(ref\)[\s\S]*mrQoo10AddImageRef\(refs,\s*seen,\s*ref\.src/, 'Qoo10 representative candidates must not import detail images');
  assert.match(html, /id="mr-qoo10-image-grid"/, 'Qoo10 modal should expose source thumbnails like the Shopee registration UI');
  assert.match(html, /id="mr-qoo10-cover-preview"/, 'Qoo10 modal should preview the selected Qoo10 representative image');
  assert.match(html, /id="mr-qoo10-detail-preview"/, 'Qoo10 modal should preview detail images that will be appended to the description');
  assert.match(html, /id="mr-qoo10-manual-image-url"/, 'Qoo10 modal should offer a manual image URL fallback');
  assert.match(html, /main_image:\s*mrQoo10SelectedMainImageUrl\(mrQoo10ImageRows\(rows\)\)/, 'Qoo10 create payload should use the selected representative image from master image rows');
  assert.match(html, /weight_kg:\s*mrQoo10WeightKgFromRows\s*\(/, 'Qoo10 create and repair payload should include converted master weight_kg');
  assert.match(html, /function\s+mrQoo10BuildLayeredMainImageUrl\s*\(/, 'Qoo10 modal should build a layered representative image URL');
  assert.match(html, /platformBuildLayerAwareCoverDataUrl\(sourceUrl\)/, 'Qoo10 representative image should reuse the platform idempotent shop-layer composition logic');
  assert.match(html, /mrQoo10SelectedMainImageUrl\(sortedRows\)/, 'Qoo10 layered image builder should respect the selected representative image');
  assert.match(html, /mrBuildMarketplaceLayeredMainImageUrl\('qoo10',\s*mainImageUrl,\s*first\)/, 'Qoo10 layered representative image should use the shared marketplace upload helper');
  assert.match(html, /sdUploadProductImageFile\(file,\s*uploadRow,\s*\{[\s\S]*kind:\s*'cover'[\s\S]*prefix:\s*platformKey === 'qoo10' \? 'q10' : platformKey[\s\S]*\}\)/, 'Qoo10 layered representative image should be uploaded as a short public product cover URL');
  assert.match(html, /payload\.publish\.main_image\s*=\s*await mrQoo10BuildLayeredMainImageUrl\(_mrQoo10\.rows \|\| \[\]\)/, 'Qoo10 create request should send the uploaded layered representative image URL');
  assert.match(html, /payload\.publish\.main_image_layered\s*=\s*true;/, 'Qoo10 create request should mark the representative image as shop-layered');
  assert.match(html, /payload\.publish\.layer_version\s*=\s*QOO10_SHOP_LAYER_VERSION;/, 'Qoo10 create request should send the required shop-layer version marker');
  assert.match(html, /if \(!payload\.publish\.main_image\) \{[\s\S]*if \(!_mrQoo10\.existingItemCode\) throw new Error\('Qoo10 representative image is required before registration\.'\);[\s\S]*\} else \{[\s\S]*payload\.publish\.main_image = await mrQoo10BuildLayeredMainImageUrl\(_mrQoo10\.rows \|\| \[\]\);[\s\S]*\}/, 'Qoo10 new registrations should require and layer a representative image');
  assert.match(html, /mrQoo10LoadExistingItemCode/, 'Qoo10 modal should detect existing item codes before deciding create vs repair');
  assert.match(html, /mrQoo10RepairExistingListing/, 'Qoo10 modal should repair existing items instead of duplicate-registering them');
  assert.match(html, /mrQoo10LoadCountrySettings/, 'Qoo10 modal should load the Q10 fee settings row before rendering prices');
  assert.match(html, /calculateQoo10Price\(\{\s*sourcingKrw: Number\(row\.sourcing_price \|\| 0\),\s*costKrw: Number\(row\.cost_krw \|\| 0\),\s*weightG: Number\(row\.weight_g \|\| 0\),\s*countrySettings: settings,\s*\}\)/, 'Qoo10 modal option prices should use sourcing_price and the shared Qoo10 price engine with shipping weight');
  assert.doesNotMatch(html, /Math\.round\(Number\(row\.cost_krw \|\| 0\) \/ 10\)/, 'Qoo10 modal must not fall back to the old cost/10 pricing stub');
  assert.match(html, /\/update-goods/, 'Qoo10 existing repair should update BrandNo, origin, and release-date fields');
  assert.match(html, /\/edit-contents/, 'Qoo10 existing repair should update detail contents');
  assert.match(html, /\/edit-inventory/, 'Qoo10 existing repair should create/update option seller codes');
});

test('Qoo10 registration prices are normalized to 90-ending JPY values', () => {
  assert.match(html, /normalizeQoo10PriceEnding90\(mrQoo10ReadNumber\('mr-qoo10-base-price', 0\)\)/, 'Qoo10 modal base price should normalize manual input to a 90-ending price');
  assert.match(html, /price_jpy:\s*mrQoo10ClampOptionPriceForBase\(mrQoo10ReadNumber\(`mr-qoo10-price-\$\{idx\}`,\s*basePrice\),\s*basePrice\)/, 'Qoo10 modal option prices should normalize and clamp manual input to platform-safe values');
  assert.match(adapter, /function normalizeQoo10PriceEnding90/, 'platform-publish should defensively normalize Qoo10 prices');
  assert.match(bridge, /function normalizeQoo10PriceEnding90/, 'qoo10-bridge should defensively normalize Qoo10 prices');
});

test('Qoo10 duplicated pricing policy stays aligned with the shared price engine', () => {
  assert.match(priceEngine, /QOO10_TARGET_MARGIN_PCT = 10/, 'V2 price engine must target 10% Qoo10 margin on sale price');
  assert.match(adapter, /QOO10_TARGET_MARGIN_PCT = 10/, 'platform-publish must target the same 10% Qoo10 sale-price margin');
  assert.match(adapter, /row\.sourcing_price \|\| row\.cost_krw/, 'platform-publish Qoo10 pricing must prefer sourcing_price before cost_krw');

  assert.deepEqual(
    extractQoo10ShippingTable(adapter, 'platform-publish adapter'),
    extractQoo10ShippingTable(priceEngine, 'V2 price engine'),
    'platform-publish must keep the Qoo10 JPY shipping brackets aligned with v2/price-engine.js'
  );

  const priceEngineRounding = extractFunctionBody(priceEngine, 'normalizeQoo10PriceEnding90', 'V2 price engine');
  assert.equal(
    extractFunctionBody(adapter, 'normalizeQoo10PriceEnding90', 'platform-publish adapter'),
    priceEngineRounding,
    'platform-publish must keep Qoo10 90-ending rounding aligned with v2/price-engine.js'
  );
  assert.equal(
    extractFunctionBody(bridge, 'normalizeQoo10PriceEnding90', 'qoo10-bridge'),
    priceEngineRounding,
    'qoo10-bridge must keep Qoo10 90-ending rounding aligned with v2/price-engine.js'
  );
});
