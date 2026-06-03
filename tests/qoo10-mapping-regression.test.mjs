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

test('Qoo10 V2 modal defaults match album preorder listing policy', () => {
  assert.match(html, /first\.qoo10_category_id \|\| '300002851'/, 'Qoo10 category should default to KPOP CD');
  assert.match(html, /const isPreOrder = true;/, 'Qoo10 modal should default to release-date preorder shipping');
  assert.match(html, /Overseas \/ South Korea \(KR\)/, 'Qoo10 modal should display the fixed origin policy');
  assert.match(html, /mrQoo10BuildDescription\(descriptionTemplateHtml\)/, 'Qoo10 description should combine template HTML with detail images');
  assert.match(html, /sdv2:qoo10:description_template_html/, 'Qoo10 description template should be persisted for reuse');
  assert.match(html, /mrQoo10LoadExistingItemCode/, 'Qoo10 modal should detect existing item codes before deciding create vs repair');
  assert.match(html, /mrQoo10RepairExistingListing/, 'Qoo10 modal should repair existing items instead of duplicate-registering them');
  assert.match(html, /\/update-goods/, 'Qoo10 existing repair should update BrandNo, origin, and release-date fields');
  assert.match(html, /\/edit-contents/, 'Qoo10 existing repair should update detail contents');
  assert.match(html, /\/edit-inventory/, 'Qoo10 existing repair should create/update option seller codes');
});
