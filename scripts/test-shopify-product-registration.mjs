import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const apiRefRoot = 'C:\\dev\\api-refs\\marketplaces\\shopify';

function readApiRef(file) {
  const path = join(apiRefRoot, file);
  assert.equal(existsSync(path), true, `Shopify local API ref missing: ${path}`);
  return readFileSync(path, 'utf8');
}

const docsReadme = readApiRef('README.md');
const productCreateRef = readApiRef('product-create.graphql.md');
const productCreateInputRef = readApiRef('product-create-input.graphql.md');
const productUpdateRef = readApiRef('product-update.graphql.md');
const productDeleteMediaRef = readApiRef('product-delete-media.graphql.md');
const variantsBulkRef = readApiRef('product-variants-bulk-create.graphql.md');
const variantsBulkUpdateRef = readApiRef('product-variants-bulk-update.graphql.md');
const inventoryItemUpdateRef = readApiRef('inventory-item-update.graphql.md');
const inventoryRef = readApiRef('inventory-set-quantities.graphql.md');
const publishRef = readApiRef('publishable-publish.graphql.md');
const collectionRef = readApiRef('collection.graphql.md');
const tagsAddRef = readApiRef('tags-add.graphql.md');
const fixturePath = join(root, 'scripts', 'shopify-option-image-live-fixture.mjs');
const fixtureScript = existsSync(fixturePath) ? readFileSync(fixturePath, 'utf8') : '';
const bulkRepairPath = join(root, 'scripts', 'shopify-repair-existing-products.mjs');
const bulkRepairScript = existsSync(bulkRepairPath) ? readFileSync(bulkRepairPath, 'utf8') : '';
const mediaCleanupPath = join(root, 'scripts', 'shopify-clean-product-media.mjs');
const mediaCleanupScript = existsSync(mediaCleanupPath) ? readFileSync(mediaCleanupPath, 'utf8') : '';

assert.match(docsReadme, /product-create\.graphql\.md/, 'Shopify README must index productCreate local docs');
assert.match(docsReadme, /product-update\.graphql\.md/, 'Shopify README must index productUpdate local docs');
assert.match(docsReadme, /product-delete-media\.graphql\.md/, 'Shopify README must index productDeleteMedia local docs');
assert.match(docsReadme, /product-variants-bulk-create\.graphql\.md/, 'Shopify README must index variant bulk create local docs');
assert.match(docsReadme, /product-variants-bulk-update\.graphql\.md/, 'Shopify README must index variant bulk update local docs');
assert.match(docsReadme, /inventory-item-update\.graphql\.md/, 'Shopify README must index inventory item SKU update local docs');
assert.match(productCreateRef, /write_products/, 'productCreate doc must record write_products scope');
assert.match(productCreateRef, /status:\s*ACTIVE/, 'productCreate doc must record the current active-first Shopify policy');
assert.match(productCreateRef, /USD/, 'productCreate doc must record Shopify USD pricing policy');
assert.match(productCreateInputRef, /tags/, 'ProductCreateInput doc must cover initial product tags');
assert.match(productCreateInputRef, /collectionsToJoin/, 'ProductCreateInput doc must record optional collection joins');
assert.match(productUpdateRef, /productUpdate/, 'productUpdate doc must record the existing-product content mutation');
assert.match(productUpdateRef, /descriptionHtml/, 'productUpdate doc must record descriptionHtml repair usage');
assert.match(productUpdateRef, /write_products/, 'productUpdate doc must record write_products scope');
assert.match(productDeleteMediaRef, /productDeleteMedia/, 'productDeleteMedia doc must record the product gallery cleanup mutation');
assert.match(productDeleteMediaRef, /mediaIds\s*\(\[ID!\]!\)/, 'productDeleteMedia doc must record required mediaIds input');
assert.match(productDeleteMediaRef, /irreversible/i, 'productDeleteMedia doc must record irreversible deletion risk');
assert.match(variantsBulkRef, /REMOVE_STANDALONE_VARIANT/, 'variant doc must record standalone variant removal strategy');
assert.match(variantsBulkRef, /mediaSrc\s*\(\[String!\]\)/, 'variant bulk create doc must record mediaSrc option image support');
assert.match(variantsBulkRef, /mediaId\s*\(ID\)/, 'variant bulk create doc must record existing media attachment support');
assert.match(variantsBulkRef, /productCreateMedia/i, 'variant bulk create doc must record product media creation before variant mediaId attachment');
assert.match(variantsBulkRef, /mediaSrc-only[\s\S]*empty variant media/i, 'variant bulk create doc must record the live mediaSrc-only failure');
assert.match(variantsBulkRef, /option image/i, 'variant bulk create doc must record V2 option image mapping policy');
assert.match(variantsBulkUpdateRef, /write_products/, 'variant bulk update doc must record write_products scope');
assert.match(variantsBulkUpdateRef, /ProductVariantsBulkInput\.inventoryItem/, 'variant bulk update doc must record inventory item update fallback');
assert.match(variantsBulkUpdateRef, /inventoryItem:\s*\{\s*sku\s*\}/, 'variant bulk update doc must record SKU repair fallback payload');
assert.match(variantsBulkUpdateRef, /Variant media repair/, 'variant bulk update doc must record variant media repair usage');
assert.match(variantsBulkUpdateRef, /mediaSrc\s*\(\[String!\]\)/, 'variant bulk update doc must record mediaSrc repair support');
assert.match(variantsBulkUpdateRef, /productCreateMedia/i, 'variant bulk update doc must record URL-only repair media creation');
assert.match(variantsBulkUpdateRef, /mediaId/i, 'variant bulk update doc must record mediaId-based repair');
assert.match(inventoryItemUpdateRef, /inventoryItemUpdate/, 'inventoryItemUpdate doc must record the SKU repair mutation');
assert.match(inventoryItemUpdateRef, /write_inventory/, 'inventoryItemUpdate doc must record write_inventory scope');
assert.match(inventoryItemUpdateRef, /sku\s*\(String\)/, 'InventoryItemInput doc notes must record the SKU field');
assert.match(inventoryRef, /write_inventory/, 'inventory doc must record write_inventory scope');
assert.match(publishRef, /write_publications/, 'publish doc must record write_publications scope');
assert.match(collectionRef, /smart collection/i, 'Collection doc must record current smart collection behavior');
assert.match(tagsAddRef, /additive/i, 'tagsAdd doc must record additive tag behavior for existing products');
assert.equal(existsSync(fixturePath), true, 'Shopify option image live fixture script must exist');
assert.match(fixtureScript, /postBridge\(\{\s*supabaseUrl,\s*token,\s*action:\s*'create-product',\s*body:\s*payload\s*\}\)/, 'Shopify option image fixture must call create-product through postBridge');
assert.match(fixtureScript, /function assertLiveCreate[\s\S]*const productId = norm\(result\.product_id\);/, 'Shopify option image fixture live success must require result.product_id');
assert.doesNotMatch(fixtureScript, /function assertLiveCreate[\s\S]*result\.product_id\s*\|\|\s*result\.platform_item_id[\s\S]*function run/, 'Shopify option image fixture live success must not accept platform_item_id fallback');
assert.match(fixtureScript, /\}\s*finally\s*\{[\s\S]*if \(!args\.dryRun && productId\) \{[\s\S]*if \(args\.keep\) \{[\s\S]*action:\s*'archive-product'/, 'Shopify option image fixture cleanup must run from finally, skip dry-run, honor --keep, and archive otherwise');
assert.match(fixtureScript, /variants\.map\(\(variant\) => variantMediaNodes\(variant\)\.length\)/, 'Shopify option image fixture must assert variant media.nodes counts via variantMediaNodes');
assert.match(fixtureScript, /Array\.isArray\(result\.variant_media_counts\)[\s\S]*variantMediaNodes/, 'Shopify option image fixture must prefer bridge variant_media_counts and fall back to variant media.nodes');
assert.equal(existsSync(bulkRepairPath), true, 'Shopify existing product bulk repair script must exist');
assert.match(bulkRepairScript, /repair-existing-products/, 'Shopify existing product bulk repair script must call the bridge repair-existing-products endpoint');
assert.match(bulkRepairScript, /--apply/, 'Shopify existing product bulk repair script must require an explicit --apply flag for live mutations');
assert.match(bulkRepairScript, /--limit/, 'Shopify existing product bulk repair script must support a --limit safety flag');
assert.equal(existsSync(mediaCleanupPath), true, 'Shopify product media cleanup script must exist');
assert.match(mediaCleanupScript, /cleanup-product-media/, 'Shopify product media cleanup script must call the bridge cleanup-product-media endpoint');
assert.match(mediaCleanupScript, /--apply/, 'Shopify product media cleanup script must require an explicit --apply flag for live deletions');
assert.match(mediaCleanupScript, /--limit/, 'Shopify product media cleanup script must support a --limit safety flag');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert(start >= 0, `missing function ${name}`);
  const braceStart = source.indexOf('{', start);
  assert(braceStart > start, `missing body for function ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function stripTinyTs(block) {
  return block
    .replace(/export\s+/g, '')
    .replace(/\)\s*:\s*Record<[^>]+>\[\]\s*\{/g, ') {')
    .replace(/\)\s*:\s*[A-Za-z0-9_<>\[\]\s|]+\s*\{/g, ') {')
    .replace(/([,(]\s*[A-Za-z_$][\w$]*)\s*:\s*Record<[^>]+>\[\]/g, '$1')
    .replace(/([,(]\s*[A-Za-z_$][\w$]*)\s*:\s*Record<[^>]+>/g, '$1')
    .replace(/([,(]\s*[A-Za-z_$][\w$]*)\s*:\s*unknown/g, '$1')
    .replace(/([,(]\s*[A-Za-z_$][\w$]*)\s*:\s*string\[\]\[\]/g, '$1')
    .replace(/([,(]\s*[A-Za-z_$][\w$]*)\s*:\s*string\[\]/g, '$1')
    .replace(/([,(]\s*[A-Za-z_$][\w$]*)\s*:\s*string/g, '$1')
    .replace(/([,(]\s*[A-Za-z_$][\w$]*)\s*:\s*any/g, '$1')
    .replace(/\s+as\s+any/g, '')
    .replace(/const ([A-Za-z_$][\w$]*)\s*:\s*Record<[^>]+>\s*=/g, 'const $1 =')
    .replace(/const ([A-Za-z_$][\w$]*)\s*:\s*string\[\]\s*=/g, 'const $1 =')
    .replace(/new Set<string>\(\)/g, 'new Set()');
}

const dispatcher = read('supabase', 'functions', 'platform-publish', 'index.ts');
const shopifyAdapter = read('supabase', 'functions', 'platform-publish', 'adapters', 'shopify.ts');
const shopifyBridge = read('supabase', 'functions', 'shopify-bridge', 'index.ts');
const edgeShopifyBridge = read('edge-functions', 'shopify-bridge', 'index.ts');
const shopifyOAuthCallback = read('api', 'shopify-oauth-callback.js');
const html = read('v2', 'index.html');
const supabaseConfig = read('supabase', 'config.toml');
const migration = read('supabase', 'migrations', '202606270001_shopify_product_registration.sql');

for (const token of [
  "import { shopifyAdapter } from './adapters/shopify.ts'",
  'shopify: shopifyAdapter',
  "new Set(['shopee', 'joom', 'qoo10', 'ebay', 'alibaba', 'shopify'])",
  "const AUTH_VERIFIED_GATED = new Set(['qoo10', 'alibaba', 'shopify'])",
  "['joom', 'qoo10', 'ebay', 'shopify'].includes(platform)",
  'shopify: (body as any).shopify || {}',
]) {
  assert.match(dispatcher, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `platform-publish must wire Shopify token: ${token}`);
}
const productSelect = dispatcher.match(/const PRODUCT_SELECT = '([^']+)'/)?.[1] || '';
assert(!productSelect.split(',').map((value) => value.trim()).includes('components_extracted_en'), 'platform-publish shared PRODUCT_SELECT must not request schema-guarded components_extracted_en');
assert.match(dispatcher, /const SHOPIFY_COMPONENT_SELECT = 'id, components_extracted_en'/, 'platform-publish must define a Shopify component projection');
assert.match(dispatcher, /select\(SHOPIFY_COMPONENT_SELECT\)/, 'platform-publish must query Shopify component fields before adapter dispatch');
assert.match(dispatcher, /platform === 'shopify'[\s\S]*hydrateShopifyComponentFields\(svc, product, groupProducts\)/, 'platform-publish must hydrate Shopify component fields before buildShopifyPayload runs');

assert.match(shopifyAdapter, /supports: new Set\(\['create_listing', 'sync'\]\)/, 'Shopify adapter must expose MVP create_listing and sync only');
assert.match(shopifyAdapter, /bridgePost\('create-product'/, 'Shopify adapter must route creates through shopify-bridge create-product');
assert.match(shopifyAdapter, /bridgeGet\('lookup-sku'/, 'Shopify adapter must sync by SKU through shopify-bridge');
assert.match(shopifyAdapter, /async function preflightShopifyDuplicateSkus/, 'Shopify adapter must preflight duplicate SKUs before live creates');
assert.match(shopifyAdapter, /duplicate_sku_preflight:\s*true/, 'Shopify dry-run payload must declare duplicate SKU preflight coverage');
assert.match(shopifyAdapter, /preflightShopifyDuplicateSkus\(payload, userToken\)/, 'Shopify live create must run duplicate SKU preflight before mutation');
assert.match(shopifyAdapter, /SHOPIFY_DUPLICATE_SKU/, 'Shopify duplicate SKU preflight must return a clear machine-readable marker');
assert.match(shopifyAdapter, /status === 409[\s\S]*duplicate_sku[\s\S]*PLATFORM_VALIDATION_ERROR/, 'Shopify sync must report duplicate SKU lookup as a validation error');
assert.match(shopifyAdapter, /publishableGroupRows\(ctx\.masterProduct/, 'Shopify adapter must support grouped master variants');
assert.match(shopifyAdapter, /productVariantsBulkCreate/, 'Shopify adapter dry-run payload must expose variant bulk intent');
assert.match(shopifyAdapter, /function shopifyVariantImageUrlFrom/, 'Shopify adapter must isolate option image URL selection');
assert.match(shopifyAdapter, /mediaSrc:\s*\[optionImageUrl\]/, 'Shopify adapter must send option image URLs as variant mediaSrc');
assert.match(shopifyAdapter, /option_products/, 'Shopify adapter must return option mapping hints for grouped creates');
assert.match(shopifyAdapter, /SHOPIFY_DEFAULT_PRICE_POLICY[\s\S]*currency:\s*'USD'[\s\S]*krwPerUsd:\s*1460[\s\S]*targetMarginPct:\s*30[\s\S]*paymentFeePct:\s*1[\s\S]*transactionFeePct:\s*10[\s\S]*includeShippingInPrice:\s*false[\s\S]*defaultStatus:\s*'ACTIVE'[\s\S]*setInventory:\s*false/, 'Shopify adapter must keep the approved USD active-first price policy as the fallback');
assert.match(shopifyAdapter, /async function loadShopifyPricePolicy[\s\S]*\.from\('shopify_price_policy'\)/, 'Shopify adapter must load the approved price policy from DB before creation');
assert.match(shopifyAdapter, /function shopifyPriceFromCostKrw[\s\S]*feePct = policy\.targetMarginPct \+ policy\.paymentFeePct \+ policy\.transactionFeePct \+ policy\.fixedOperationFeePct[\s\S]*denominator = 1 - feePct \/ 100[\s\S]*costKrw \/ policy\.krwPerUsd \/ denominator/, 'Shopify adapter must calculate USD price by backing out margin and percentage fees');
assert.match(shopifyAdapter, /status:\s*shopifyProductStatus\(shopify, policy\)/, 'Shopify adapter must create products with the DB-backed default status');
assert.match(shopifyAdapter, /set_inventory:\s*shopify\.set_inventory === true && policy\.setInventory === true/, 'Shopify adapter must keep Shopify inventory push disabled unless the DB policy enables it');
assert.doesNotMatch(shopifyAdapter, /shopeeSellerCenterDescription/, 'Shopify adapter must not use the Shopee description template');
assert.match(shopifyAdapter, /function shopifyDefaultDescriptionHtmlFrom/, 'Shopify adapter must build the default text-first Shopify description');
assert.doesNotMatch(shopifyAdapter, /function shopify(?:EbayDescriptionHtmlFrom|DescriptionCard|DescriptionList|DescriptionTable)/, 'Shopify adapter must not keep dead eBay/table/list description helpers');
assert.match(shopifyAdapter, /deriveKpopFromTitle/, 'Shopify adapter must reuse the shared K-pop parser for artist/album tags');
assert.match(shopifyAdapter, /function shopifyArtistAlbumTagsFrom/, 'Shopify adapter must isolate artist/album tag derivation');
assert.doesNotMatch(shopifyAdapter, /collectionsToJoin|collectionAddProducts|collectionUpdate/, 'Shopify adapter must not manage collection membership for smart collections');

const shopifyDescriptionHelpers = [
  'cleanText',
  'stripLifecycleTags',
  'lifecycleOf',
  'shopifyHtmlEscape',
  'shopifyTextEscape',
  'shopifyPublicImageUrl',
  'shopifyImageCandidatesFrom',
  'shopifySplitTopLevelComponents',
  'shopifyComponentLines',
  'shopifyDetailImageUrlsFrom',
  'shopifyDetailImagesHtmlFrom',
  'shopifyTextDescriptionFrom',
  'shopifyLooksLikeHtml',
  'shopifyDefaultDescriptionHtmlFrom',
  'descriptionHtmlFrom',
].map((name) => stripTinyTs(extractFunction(shopifyAdapter, name))).join('\n');
const descriptionHtmlFrom = new Function(
  `function s(value, fallback = '') { return value == null ? fallback : String(value); }\n`
  + `${shopifyDescriptionHelpers}\nreturn descriptionHtmlFrom;`,
)();
const shopifyDescription = descriptionHtmlFrom({
  product_name: '[READY STOCK] CORTIS - [ GREENGREEN ] 2ND EP (WEVERSE Ver.)',
  sku: 'RS-CORTIS-GREENGREEN',
  lifecycle_state: 'ready_stock',
  components_extracted_en: ['Outbox', 'Photocard'],
  _detail_image_urls: ['notaurl', 'https://', 'https://bad host/detail.jpg', 'https://cdn.example.com/has space.jpg', 'https://cdn.example.com/detail-1.jpg'],
}, {});
assert(shopifyDescription.includes('Product Details'), 'Shopify description must include Product Details');
assert(shopifyDescription.includes('- Outbox'), 'Shopify description must include Outbox component as a text bullet');
assert(shopifyDescription.includes('- Photocard'), 'Shopify description must include Photocard component as a text bullet');
assert(shopifyDescription.includes('Detail Images'), 'Shopify description must include Detail Images below the text content');
assert(
  shopifyDescription.indexOf('Detail Images') > shopifyDescription.indexOf('Product Details'),
  'Shopify detail images must appear after Product Details text',
);
assert(shopifyDescription.includes('<img src="https://cdn.example.com/detail-1.jpg"'), 'Shopify description must render valid public detail image URLs');
assert(!shopifyDescription.includes('notaurl'), 'Shopify description must exclude invalid detail image URLs');
assert(!shopifyDescription.includes('<img src="https://"'), 'Shopify description must exclude incomplete https URLs');
assert(!shopifyDescription.includes('bad host'), 'Shopify description must exclude malformed https URLs');
assert(!shopifyDescription.includes('has space.jpg'), 'Shopify description must exclude unencoded whitespace URLs');
assert(!shopifyDescription.includes('<table'), 'Shopify default description must not use tables');
assert(!shopifyDescription.includes('<ul'), 'Shopify default description must not use unordered lists');
assert(!shopifyDescription.includes('<li'), 'Shopify default description must not use list items');
assert(!shopifyDescription.includes('100% Official & Authentic K-POP item'), 'Shopify description must remove the official/authentic album bullet');
assert(!shopifyDescription.includes('Eligible albums may support Hanteo'), 'Shopify description must remove the chart-count album bullet');
assert.equal(
  descriptionHtmlFrom({}, { description: 'Line <one>\nLine & two' }),
  'Line &lt;one&gt;<br>Line &amp; two',
  'Shopify plain-text description override must be escaped and preserve newlines with br tags',
);
assert.equal(
  descriptionHtmlFrom({}, { description_html: '<p><strong>Custom</strong> HTML</p>' }),
  '<p><strong>Custom</strong> HTML</p>',
  'Shopify HTML description override must remain unchanged',
);
assert.equal(
  descriptionHtmlFrom({}, { description_html: '  <p><strong>Custom</strong> HTML</p>\n' }),
  '  <p><strong>Custom</strong> HTML</p>\n',
  'Shopify HTML description override must preserve leading and trailing whitespace exactly',
);
assert.equal(
  descriptionHtmlFrom({}, { description_html: '  <figure><img src="https://cdn.example.com/custom.jpg"></figure>\n' }),
  '  <figure><img src="https://cdn.example.com/custom.jpg"></figure>\n',
  'Shopify HTML description override must preserve non-whitelisted HTML tags exactly',
);
assert.equal(
  descriptionHtmlFrom({}, { description_html: '  <figure>Custom caption</figure>\n' }),
  '  <figure>Custom caption</figure>\n',
  'Shopify HTML description override must detect tag pairs outside the legacy whitelist',
);
assert.equal(
  descriptionHtmlFrom({}, { description: 'Line <one>' }),
  'Line &lt;one&gt;',
  'Shopify plain-text angle bracket prose must still be escaped as text',
);

for (const [field, source] of [
  ['_detail_image_urls', { _detail_image_urls: ['https://cdn.example.com/from-private-detail.jpg'] }],
  ['detail_image_urls', { detail_image_urls: ['https://cdn.example.com/from-detail.jpg'] }],
  ['observed.detail_image_urls', { observed: { detail_image_urls: ['https://cdn.example.com/from-observed.jpg'] } }],
  ['extra_images', { extra_images: ['https://cdn.example.com/from-extra.jpg'] }],
]) {
  const html = descriptionHtmlFrom({
    product_name: 'Image source fixture',
    sku: 'IMAGE-SOURCE',
    lifecycle_state: 'ready_stock',
    components_extracted_en: 'Outbox',
    ...source,
  }, {});
  assert.match(html, /<img src="https:\/\/cdn\.example\.com\/from-[^"]+\.jpg"/, `Shopify detail images must use ${field}`);
}

const longDescription = descriptionHtmlFrom({
  product_name: `Long description fixture ${'text '.repeat(1200)}`,
  sku: 'LONG-DESC',
  lifecycle_state: 'ready_stock',
  components_extracted_en: Array.from({ length: 200 }, (_, index) => `Component ${index + 1}`).join(', '),
  _detail_image_urls: [
    'https://cdn.example.com/detail-long-1.jpg',
    'https://cdn.example.com/detail-long-2.jpg',
  ],
}, {});
assert(longDescription.includes('<h3>Detail Images</h3>'), 'Shopify long default description must keep the Detail Images heading');
assert(longDescription.includes('<img src="https://cdn.example.com/detail-long-1.jpg"'), 'Shopify long default description must preserve the first complete detail image tag');
assert(longDescription.includes('<img src="https://cdn.example.com/detail-long-2.jpg"'), 'Shopify long default description must preserve the second complete detail image tag');
assert(longDescription.length <= 4000, 'Shopify long default description must cap text before appending detail images');
assert(!/<img[^>]*$/.test(longDescription), 'Shopify long default description must not cut an img tag');

const shopifyTagHelpers = [
  'cleanText',
  'lifecycleOf',
  'lifecycleTag',
  'isGoodsMaster',
  'isMeaningfulShopifyTagSource',
  'shopifyArtistAlbumTagsFrom',
  'tagsFrom',
].map((name) => stripTinyTs(extractFunction(shopifyAdapter, name))).join('\n');
const tagsFrom = new Function(
  `function s(value, fallback = '') { return value == null ? fallback : String(value); }\n`
  + `function deriveKpopFromTitle() { return { artist: 'CORTIS', album: 'GREENGREEN', version: 'WEVERSE' }; }\n`
  + `${shopifyTagHelpers}\nreturn tagsFrom;`,
)();
const cortisTags = tagsFrom({
  product_name: '[READY STOCK] CORTIS - [ GREENGREEN ] 2ND EP (WEVERSE Ver.)',
  product_kind: 'album',
  lifecycle_state: 'ready_stock',
  brand: 'HYBE',
}, {});
assert(cortisTags.includes('CORTIS'), 'Shopify tags must include derived artist tag');
assert(cortisTags.includes('GREENGREEN'), 'Shopify tags must include derived album tag');
assert(!cortisTags.includes('WEVERSE'), 'Shopify tags must not include derived version tag');
assert(!cortisTags.includes('HYBE'), 'Shopify tags must prefer parsed artist over label-like brand fallback');
assert(cortisTags.includes('Album'), 'Shopify tags must keep the smart-collection product-kind tag');

const shopifyImageHelpers = [
  'cleanText',
  'shopifyPublicImageUrl',
  'shopifyImageCandidatesFrom',
  'shopifyVariantImageUrlFrom',
  'imagesFrom',
].map((name) => stripTinyTs(extractFunction(shopifyAdapter, name))).join('\n');
const shopifyImageFns = new Function(
  `function s(value, fallback = '') { return value == null ? fallback : String(value); }\n`
  + `${shopifyImageHelpers}\nreturn { shopifyVariantImageUrlFrom, imagesFrom };`,
)();
assert.equal(
  shopifyImageFns.shopifyVariantImageUrlFrom({
    shopee_option_image_url: 'https://cdn.example.com/vol1.jpg',
    main_image: 'https://cdn.example.com/fallback.jpg',
  }),
  'https://cdn.example.com/vol1.jpg',
  'Shopify option image mapping must prefer shopee_option_image_url',
);
assert.equal(
  shopifyImageFns.shopifyVariantImageUrlFrom({
    extra_images: ['https://cdn.example.com/extra-option.jpg'],
    main_image: 'https://cdn.example.com/main.jpg',
  }),
  'https://cdn.example.com/main.jpg',
  'Shopify option image mapping must prefer main_image before extra_images',
);
assert.equal(
  shopifyImageFns.shopifyVariantImageUrlFrom({
    extra_images: ['notaurl', 'https://cdn.example.com/extra-option.jpg'],
  }),
  'https://cdn.example.com/extra-option.jpg',
  'Shopify option image mapping must skip invalid extra_images entries before using the first public URL',
);
assert.equal(
  shopifyImageFns.shopifyVariantImageUrlFrom({
    observed: { detail_image_urls: ['https://cdn.example.com/detail-option.jpg'] },
  }),
  'https://cdn.example.com/detail-option.jpg',
  'Shopify option image mapping must use observed detail_image_urls when earlier sources are missing',
);
assert.deepEqual(
  shopifyImageFns.imagesFrom(
    { product_name: 'PUREFLOW', main_image: 'https://cdn.example.com/main.jpg' },
    [
      { shopee_option_image_url: 'https://cdn.example.com/vol1.jpg' },
      { _custom_option_image_url: 'https://cdn.example.com/vol2.jpg' },
    ],
  ).map((row) => row.originalSource),
  ['https://cdn.example.com/main.jpg', 'https://cdn.example.com/vol1.jpg', 'https://cdn.example.com/vol2.jpg'],
  'Shopify product media list must include option images so variant mediaSrc URLs are present in the gallery',
);

const shopifyBridgeVariantHelpers = [
  'norm',
  'mediaSourceKey',
  'variantMediaSrcs',
  'firstMappedMediaId',
  'variantsFrom',
].map((name) => stripTinyTs(extractFunction(shopifyBridge, name))).join('\n');
const bridgeVariantsFrom = new Function(`${shopifyBridgeVariantHelpers}\nreturn variantsFrom;`)();
const bridgedVariants = bridgeVariantsFrom({
  variants: [{
    sku: 'PUREFLOW-VOL1',
    price: '12.34',
    mediaSrc: ['https://cdn.example.com/vol1.jpg', 'http://not-public.example.com/bad.jpg'],
  }],
});
assert.deepEqual(bridgedVariants[0].mediaSrc, ['https://cdn.example.com/vol1.jpg'], 'Shopify bridge must forward only public HTTPS mediaSrc URLs');
const bridgedVariantsWithMediaIds = bridgeVariantsFrom(
  {
    variants: [{
      sku: 'PUREFLOW-VOL1',
      price: '12.34',
      mediaSrc: ['https://cdn.example.com/vol1.jpg'],
    }],
  },
  { 'https://cdn.example.com/vol1.jpg': 'gid://shopify/MediaImage/123' },
);
assert.equal(bridgedVariantsWithMediaIds[0].mediaId, 'gid://shopify/MediaImage/123', 'Shopify bridge variantsFrom must convert mapped mediaSrc to mediaId');
assert.equal('mediaSrc' in bridgedVariantsWithMediaIds[0], false, 'Shopify bridge variantsFrom must avoid mediaSrc when mediaId is resolved');

const shopifyBridgeRepairHelpers = [
  'norm',
  'shopifyGid',
  'shopifyVariantGid',
  'normalizeVariantMediaRows',
  'resolveRepairVariantTargets',
].map((name) => stripTinyTs(extractFunction(shopifyBridge, name))).join('\n');
const bridgeRepairFns = new Function(`${shopifyBridgeRepairHelpers}\nreturn { normalizeVariantMediaRows, resolveRepairVariantTargets };`)();
const normalizedMediaRows = bridgeRepairFns.normalizeVariantMediaRows([{
  sku: 'PUREFLOW-VOL1',
  mediaSrc: ['https://cdn.example.com/vol1.jpg', 'http://cdn.example.com/bad.jpg', 'https://cdn.example.com/vol1b.jpg'],
}]);
assert.deepEqual(
  normalizedMediaRows.valid[0].mediaSrc,
  ['https://cdn.example.com/vol1.jpg', 'https://cdn.example.com/vol1b.jpg'],
  'Shopify option image repair normalization must preserve HTTPS mediaSrc arrays',
);
const normalizedMediaIdRows = bridgeRepairFns.normalizeVariantMediaRows([{
  sku: 'PUREFLOW-VOL1',
  mediaId: 'gid://shopify/MediaImage/123',
}]);
assert.equal(normalizedMediaIdRows.valid[0].mediaId, 'gid://shopify/MediaImage/123', 'Shopify option image repair normalization must accept mediaId without mediaSrc');
assert.deepEqual(
  bridgeRepairFns.normalizeVariantMediaRows([
    { sku: 'PUREFLOW-VOL1', mediaSrc: 'https://cdn.example.com/vol1.jpg' },
    { sku: '', mediaSrc: 'http://cdn.example.com/bad.jpg' },
  ]).invalid,
  [{ index: 1, sku: null, variant_id: null, errors: ['sku_or_variant_id_required', 'media_id_or_media_src_required'] }],
  'Shopify option image repair normalization must require mediaSrc or mediaId',
);
const resolvedSkuFallback = bridgeRepairFns.resolveRepairVariantTargets(
  [{ id: 'gid://shopify/ProductVariant/100', sku: 'PUREFLOW-VOL1', inventoryItem: { sku: '' } }],
  [{ index: 0, sku: 'PUREFLOW-VOL1', variantId: 'gid://shopify/ProductVariant/999', mediaSrc: ['https://cdn.example.com/vol1.jpg'] }],
);
assert.deepEqual(
  resolvedSkuFallback.repairVariants,
  [{ id: 'gid://shopify/ProductVariant/100', mediaSrc: ['https://cdn.example.com/vol1.jpg'] }],
  'Shopify option image repair must fall back from unmatched variant_id to one exact SKU match',
);
const resolvedMediaIdRepair = bridgeRepairFns.resolveRepairVariantTargets(
  [{ id: 'gid://shopify/ProductVariant/100', sku: 'PUREFLOW-VOL1', inventoryItem: { sku: '' } }],
  [{ index: 0, sku: 'PUREFLOW-VOL1', variantId: '', mediaId: 'gid://shopify/MediaImage/123', mediaSrc: [] }],
);
assert.deepEqual(
  resolvedMediaIdRepair.repairVariants,
  [{ id: 'gid://shopify/ProductVariant/100', mediaId: 'gid://shopify/MediaImage/123' }],
  'Shopify option image repair must send mediaId when available',
);
const resolvedDuplicateSku = bridgeRepairFns.resolveRepairVariantTargets(
  [
    { id: 'gid://shopify/ProductVariant/100', sku: 'PUREFLOW-VOL1', product: { id: 'gid://shopify/Product/1' }, inventoryItem: { sku: '' } },
    { id: 'gid://shopify/ProductVariant/101', sku: '', product: { id: 'gid://shopify/Product/1' }, inventoryItem: { sku: 'PUREFLOW-VOL1' } },
  ],
  [{ index: 0, sku: 'PUREFLOW-VOL1', variantId: '', mediaSrc: ['https://cdn.example.com/vol1.jpg'] }],
);
assert.deepEqual(resolvedDuplicateSku.repairVariants, [], 'Shopify option image repair must not choose the first duplicate SKU variant');
assert.deepEqual(
  resolvedDuplicateSku.duplicates,
  [{
    index: 0,
    sku: 'PUREFLOW-VOL1',
    product_ids: ['gid://shopify/Product/1'],
    variant_ids: ['gid://shopify/ProductVariant/100', 'gid://shopify/ProductVariant/101'],
  }],
  'Shopify option image repair must report duplicate exact SKU diagnostics',
);

const resolveRepairVariantTargetsBlock = extractFunction(shopifyBridge, 'resolveRepairVariantTargets');
assert.match(
  resolveRepairVariantTargetsBlock,
  /let target = row\.variantId[\s\S]*\? shopifyVariants\.find\(\(variant: any\) => norm\(variant\?\.id\) === row\.variantId\)[\s\S]*: null;[\s\S]*if \(!target && row\.sku\) \{[\s\S]*const exactSkuMatches = shopifyVariants\.filter\(\(variant: any\) => norm\(variant\?\.sku\) === row\.sku \|\| norm\(variant\?\.inventoryItem\?\.sku\) === row\.sku\);[\s\S]*exactSkuMatches\.length > 1[\s\S]*duplicates\.push/,
  'Shopify option image repair must fall back from unmatched variant_id to exact SKU matching without choosing duplicate SKUs',
);

const shopifyMediaCleanupHelpers = [
  'norm',
  'shopifyPublicImageUrl',
  'shopifyMediaImageUrlFrom',
  'shopifyMediaImageUrlKey',
  'shopifyProductMediaDuplicateKey',
  'variantAttachedMediaIdsFrom',
  'mediaNodeCleanupSummary',
  'planDuplicateProductMediaCleanup',
].map((name) => stripTinyTs(extractFunction(shopifyBridge, name))).join('\n');
const mediaCleanupFns = new Function(`${shopifyMediaCleanupHelpers}\nreturn { planDuplicateProductMediaCleanup, shopifyMediaImageUrlKey };`)();
assert.equal(
  mediaCleanupFns.shopifyMediaImageUrlKey('https://cdn.shopify.com/s/files/1/abc/products/Vol1.jpg?v=123'),
  'cdn.shopify.com/s/files/1/abc/products/vol1.jpg',
  'Shopify media cleanup must normalize URL query strings before duplicate grouping',
);
const mediaCleanupPlan = mediaCleanupFns.planDuplicateProductMediaCleanup({
  media: {
    nodes: [
      { id: 'gid://shopify/MediaImage/1', alt: 'VOL1', mediaContentType: 'IMAGE', image: { url: 'https://cdn.shopify.com/s/files/1/abc/products/Vol1.jpg?v=111' } },
      { id: 'gid://shopify/MediaImage/2', alt: 'VOL1', mediaContentType: 'IMAGE', image: { url: 'https://cdn.shopify.com/s/files/1/abc/products/Vol1.jpg?v=222' } },
      { id: 'gid://shopify/MediaImage/3', alt: 'VOL2', mediaContentType: 'IMAGE', image: { url: 'https://cdn.shopify.com/s/files/1/abc/products/Vol2.jpg?v=111' } },
      { id: 'gid://shopify/Video/9', alt: 'VOL1 video', mediaContentType: 'VIDEO' },
    ],
  },
  variants: {
    nodes: [
      { id: 'gid://shopify/ProductVariant/1', media: { nodes: [{ id: 'gid://shopify/MediaImage/2' }] } },
    ],
  },
});
assert.deepEqual(
  mediaCleanupPlan.delete_media_ids,
  ['gid://shopify/MediaImage/1'],
  'Shopify media cleanup must keep the variant-attached duplicate and delete only detached duplicates',
);
assert.equal(mediaCleanupPlan.duplicate_group_count, 1, 'Shopify media cleanup must report duplicate image groups');
assert.equal(mediaCleanupPlan.variant_attached_media_count, 1, 'Shopify media cleanup must report variant-attached protected media');
const staleOptionMediaCleanupPlan = mediaCleanupFns.planDuplicateProductMediaCleanup({
  media: {
    nodes: [
      { id: 'gid://shopify/MediaImage/10', alt: 'PUREFLOW 1', mediaContentType: 'IMAGE', image: { url: 'https://cdn.shopify.com/s/files/1/abc/products/main.jpg?v=111' } },
      { id: 'gid://shopify/MediaImage/11', alt: 'PUREFLOW 2', mediaContentType: 'IMAGE', image: { url: 'https://cdn.shopify.com/s/files/1/abc/products/vol1-original.jpg?v=111' } },
      { id: 'gid://shopify/MediaImage/12', alt: 'VOL1', mediaContentType: 'IMAGE', image: { url: 'https://cdn.shopify.com/s/files/1/abc/products/vol1-attached.jpg?v=111' } },
    ],
  },
  variants: {
    nodes: [
      { id: 'gid://shopify/ProductVariant/10', media: { nodes: [{ id: 'gid://shopify/MediaImage/12' }] } },
    ],
  },
}, [{ alt: 'PUREFLOW 2', originalSource: 'https://source.example.com/vol1.jpg' }]);
assert.deepEqual(
  staleOptionMediaCleanupPlan.delete_media_ids,
  ['gid://shopify/MediaImage/11'],
  'Shopify media cleanup must delete detached stale option-gallery media generated before variant media repair',
);
assert.equal(staleOptionMediaCleanupPlan.stale_option_media_count, 1, 'Shopify media cleanup must report stale option-gallery media separately');

const shopifyMediaCleanupTargetHelpers = [
  'norm',
  'shopifyPublicImageUrl',
  'shopifyImageCandidatesFrom',
  'shopifyExistingVariantImageUrlFrom',
  'existingRepairOptionRowsForTarget',
  'shopifyExistingGalleryMediaRowsForTarget',
  'staleOptionGalleryMediaForTarget',
].map((name) => stripTinyTs(extractFunction(shopifyBridge, name))).join('\n');
const mediaCleanupTargetFns = new Function(`${shopifyMediaCleanupTargetHelpers}\nreturn { staleOptionGalleryMediaForTarget };`)();
assert.deepEqual(
  mediaCleanupTargetFns.staleOptionGalleryMediaForTarget({
    master_product: {
      product_name: 'PUREFLOW',
      main_image: 'https://source.example.com/main.jpg',
      extra_images: ['https://source.example.com/extra.jpg'],
    },
    listings: [
      { external_sku: 'PUREFLOW-VOL1', master_product_id: 'vol1' },
      { external_sku: 'PUREFLOW-VOL2', master_product_id: 'vol2' },
    ],
    group_products: [
      { id: 'vol1', product_name: 'VOL1', shopee_option_image_url: 'https://source.example.com/vol1.jpg' },
      { id: 'vol2', product_name: 'VOL2', shopee_option_image_url: 'https://source.example.com/vol2.jpg' },
    ],
  }),
  [
    { originalSource: 'https://source.example.com/vol1.jpg', alt: 'PUREFLOW 3' },
    { originalSource: 'https://source.example.com/vol2.jpg', alt: 'PUREFLOW 4' },
  ],
  'Shopify media cleanup must derive stale option-gallery alts from the original V2 gallery media order',
);

for (const [label, source] of [['Supabase', shopifyBridge], ['edge mirror', edgeShopifyBridge]]) {
  assert.match(source, /SHOPIFY_API_VERSION/, `${label} Shopify bridge must pin an Admin API version`);
  assert.match(source, /authorization-code grant/, `${label} Shopify bridge must document OAuth source`);
  assert.match(source, /function requireBridgeTokenOrAuthenticatedUser/, `${label} Shopify bridge must allow internal platform-publish and signed-in browser calls`);
  assert.match(source, /action === 'oauth-url'/, `${label} Shopify bridge must expose OAuth URL bootstrap`);
  assert.match(source, /action === 'oauth-callback'/, `${label} Shopify bridge must expose OAuth callback exchange`);
  assert.match(source, /action === 'create-product'/, `${label} Shopify bridge must expose product creation`);
  assert.match(source, /action === 'lookup-sku'/, `${label} Shopify bridge must expose SKU lookup`);
  assert.match(source, /function shopifySearchString/, `${label} Shopify lookup must escape search query values`);
  assert.match(source, /const queryText = `sku:"\$\{escapedSku\}"`/, `${label} Shopify lookup must quote SKU searches so hyphenated SKUs are exact`);
  const lookupSkuBlock = source.slice(source.indexOf('async function handleLookupSku'), source.indexOf('async function handleRequest'));
  const lookupSource = lookupSkuBlock || source;
  assert.match(lookupSource, /const exactMatches = nodes\.filter/, `${label} Shopify lookup must filter exact SKU matches after Shopify search`);
  assert.match(lookupSource, /norm\(node\?\.sku\) === sku \|\| norm\(node\?\.inventoryItem\?\.sku\) === sku/, `${label} Shopify lookup must verify the variant or inventory item SKU exactly`);
  assert.match(lookupSource, /exactMatches\.length > 1[\s\S]*duplicate_sku/, `${label} Shopify lookup must reject duplicate exact SKU hits`);
  assert.match(lookupSource, /exact_match_count/, `${label} Shopify lookup responses must expose exact match diagnostics`);
  assert.doesNotMatch(lookupSkuBlock, /nodes\.find[\s\S]*\|\| nodes\[0\]/, `${label} Shopify lookup must not fall back to the first fuzzy SKU result`);
  assert.match(source, /productCreate/, `${label} Shopify bridge must call productCreate`);
  assert.match(source, /function shopifyProductStatus/, `${label} Shopify bridge must sanitize requested Shopify product status`);
  assert.match(source, /status:\s*shopifyProductStatus\(product\.status\)/, `${label} Shopify productCreate must honor the adapter status`);
  const createProductBlock = source.slice(source.indexOf('async function createProduct'), source.indexOf('async function createVariants'));
  assert.doesNotMatch(createProductBlock, /userErrors\s*\{\s*field\s+message\s+code\s*\}/, `${label} Shopify productCreate must not request unsupported UserError.code`);
  assert.match(source, /async function createProductMedia/, `${label} Shopify bridge must include a productCreateMedia helper`);
  assert.match(source, /productCreateMedia\(media: \$media, productId: \$productId\)/, `${label} Shopify bridge must create product media separately`);
  assert(
    source.indexOf('await createProductMedia') > source.indexOf('await createProduct')
    && source.indexOf('await createProductMedia') < source.indexOf('await createVariants'),
    `${label} Shopify create path must call productCreateMedia before createVariants`,
  );
  assert.match(source, /productVariantsBulkCreate/, `${label} Shopify bridge must call productVariantsBulkCreate`);
  assert.match(source, /if \(Array\.isArray\(variant\.mediaSrc\)/, `${label} Shopify bridge must preserve variant mediaSrc`);
  assert.match(source, /out\.mediaId = mediaId/, `${label} Shopify bridge must prefer ProductVariantsBulkInput.mediaId for option images`);
  assert.match(source, /out\.mediaSrc = mediaSrc/, `${label} Shopify bridge must keep mediaSrc fallback when no mediaId is resolved`);
  assert.match(source, /async function archiveProduct/, `${label} Shopify bridge must include a product archive cleanup helper`);
  assert.match(source, /productUpdate/, `${label} Shopify bridge must archive failed creates with productUpdate`);
  assert.match(source, /status:\s*'ARCHIVED'/, `${label} Shopify cleanup must set product status to ARCHIVED`);
  assert.match(source, /cleanup_on_variant_failure !== false/, `${label} Shopify bridge must archive created products after variant failure by default`);
  assert.match(source, /cleanup_action:\s*'archive_product'/, `${label} Shopify variant failure response must report archive cleanup`);
  assert.match(source, /action === 'archive-product'/, `${label} Shopify bridge must expose archive-product for manual cleanup`);
  assert.match(source, /action === 'set-sku'/, `${label} Shopify bridge must expose an internal SKU repair endpoint`);
  assert.match(source, /action === 'repair-option-images'/, `${label} Shopify bridge must expose an option image repair endpoint`);
  assert.match(source, /async function handleSetSku/, `${label} Shopify bridge must implement a SKU repair handler`);
  assert.match(source, /async function handleRepairOptionImages/, `${label} Shopify bridge must implement an option image repair handler`);
  assert.match(source, /inventoryItemUpdate\(id: \$id, input: \$input\)/, `${label} Shopify SKU repair must write SKU through inventoryItemUpdate`);
  assert.match(source, /input:\s*\{\s*sku\s*\}/, `${label} Shopify SKU repair must set InventoryItemInput.sku`);
  assert.match(source, /productVariantsBulkUpdate\(productId: \$productId, variants: \$variants\)/, `${label} Shopify SKU repair must support write_products fallback`);
  assert.match(source, /mediaId:\s*row\.mediaId/, `${label} Shopify option image repair must set ProductVariantsBulkInput.mediaId`);
  assert(
    source.indexOf('await createProductMedia(shop, product.id') > source.indexOf('resolveRepairVariantTargets')
    && source.indexOf('await createProductMedia(shop, product.id') < source.indexOf('await bulkRepairVariantMedia'),
    `${label} Shopify repair path must create product media for URL-only rows before bulkRepairVariantMedia`,
  );
  assert.match(source, /async function updateProductDescriptionHtml/, `${label} Shopify bridge must expose a product description update helper`);
  assert.match(source, /descriptionHtml/, `${label} Shopify existing repair must update Shopify Product.descriptionHtml`);
  assert.match(source, /async function fetchExistingShopifyRepairTargets/, `${label} Shopify bridge must collect existing V2 Shopify platform_listings through service-role context`);
  assert.match(source, /\.from\('platform_listings'\)[\s\S]*platform[\s\S]*shopify/, `${label} Shopify repair target fetch must read platform_listings where platform is shopify`);
  assert.match(source, /function shopifyExistingVariantImageUrlFrom/, `${label} Shopify existing repair must derive option image URLs from V2 product rows`);
  assert.match(source, /function shopifyExistingDescriptionHtmlFrom/, `${label} Shopify existing repair must generate the text-first description for already-created products`);
  assert.match(source, /async function handleRepairExistingProducts/, `${label} Shopify bridge must expose a bulk repair handler for existing products`);
  assert.match(source, /requireInternalBridge\(req\)/, `${label} Shopify existing bulk repair must require the internal bridge token`);
  assert.match(source, /repairOptionImagesForProduct/, `${label} Shopify existing repair must reuse the mediaId option image repair flow`);
  assert.match(source, /action === 'repair-existing-products'/, `${label} Shopify bridge must route repair-existing-products`);
  assert.match(source, /async function deleteProductMedia/, `${label} Shopify bridge must expose a productDeleteMedia helper`);
  assert.match(source, /productDeleteMedia\(mediaIds: \$mediaIds, productId: \$productId\)/, `${label} Shopify bridge must delete duplicate product media by ID`);
  assert.match(source, /function planDuplicateProductMediaCleanup/, `${label} Shopify bridge must plan duplicate gallery media cleanup before deleting`);
  assert.match(source, /function staleOptionGalleryMediaForTarget/, `${label} Shopify bridge must derive stale option gallery media from V2 target rows`);
  assert.match(source, /planDuplicateProductMediaCleanup\(read\.product,\s*staleOptionMedia\)/, `${label} Shopify bridge cleanup must pass target-aware stale option media to the planner`);
  assert.match(source, /async function handleCleanupProductMedia/, `${label} Shopify bridge must expose product media cleanup handler`);
  assert.match(source, /action === 'cleanup-product-media'/, `${label} Shopify bridge must route cleanup-product-media`);
  assert.match(source, /inventoryItem:\s*\{\s*sku\s*\}/, `${label} Shopify SKU fallback must set ProductVariantsBulkInput.inventoryItem.sku`);
  assert.match(source, /variant_count[\s\S]*ambiguous_variant/, `${label} Shopify SKU repair must refuse ambiguous multi-variant products`);
  assert.match(source, /inventorySetQuantities/, `${label} Shopify bridge must include gated inventory support`);
  assert.match(source, /publishablePublish/, `${label} Shopify bridge must include gated publish support`);
  assert.match(source, /listing_status:\s*mapShopifyListingStatus\(product\)/, `${label} Shopify bridge must report ACTIVE products as listed even without inventory push`);
  assert.match(source, /scopeSet\.has\('write_products'\)/, `${label} Shopify bridge must verify product write scope before enabling create_listing`);
  assert.match(source, /missing_scopes/, `${label} Shopify bridge must report missing Shopify product scopes`);
  assert.doesNotMatch(source, /stack: e\?\.stack/, `${label} Shopify bridge must not expose stack traces`);
}

assert.match(supabaseConfig, /\[functions\.shopify-bridge\]\s+verify_jwt = false/s, 'Shopify OAuth callback must be allowed through Supabase gateway');
assert.match(shopifyOAuthCallback, /SHOPIFY_BRIDGE_CALLBACK/, 'Vercel OAuth callback relay must target shopify-bridge');
assert.match(shopifyOAuthCallback, /target\.search = incoming\.search/, 'Vercel OAuth callback relay must preserve Shopify query parameters');
assert.match(shopifyOAuthCallback, /shopee-dashboard-kohl\.vercel\.app/, 'Vercel OAuth callback relay must keep the app host aligned with Shopify Application URL');

for (const token of [
  "('shopify')",
  "('shopify', 'create_listing', true, false",
  "('shopify', 'sync', true, false",
  'create table if not exists public.shopify_shops',
  'default_location_gid',
  'default_publication_gid',
  "cross join (values ('joom'), ('qoo10'), ('ebay'), ('shopify'))",
  "v_platform not in ('joom', 'qoo10', 'ebay', 'shopify')",
  "platform in ('shopee','joom','qoo10','ebay','alibaba','shopify')",
]) {
  assert.match(migration, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Shopify migration must include ${token}`);
}

for (const token of [
  "showView('view-platform-shopify')",
  'id="view-platform-shopify"',
  'id="platform-shopify-root"',
  "const PLATFORM_TABS = Object.freeze(['shopee', 'joom', 'qoo10', 'ebay', 'alibaba', 'shopify'])",
  'shopify: {',
  'Shopify Active',
  'function platformConfirmShopifyActiveRegistration',
  'Shopify ACTIVE registration will create a live product',
  'platformConfirmShopifyActiveRegistration(groups)',
  "body.shopify = { status: 'ACTIVE' }",
  "platform === 'shopify' ? 'create_listing' :",
  "coverageBridgeUrl('shopify')",
  "coverageLookupViaPlatformPublish('shopify', sku, productId)",
]) {
  assert.match(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `V2 UI must include ${token}`);
}

console.log('Shopify product registration checks passed');
