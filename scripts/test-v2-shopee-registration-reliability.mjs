import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const bridge = readFileSync(join(root, 'supabase', 'functions', 'shopee-bridge', 'index.ts'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert(start >= 0, `missing function ${name}`);
  const paramsEnd = source.indexOf(')', start);
  const open = source.indexOf('{', paramsEnd);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

const persistMappings = extractFunction(html, 'persistMappings');
const applyPublishState = extractFunction(html, 'rshApplyShopeePublishState');
const publishStateFromRows = extractFunction(html, 'rshPublishStateFromMappingRows');
const buildGroupPayload = extractFunction(html, 'rshBuildGroupRegisterPayload');
const normalizeRegionalGlobalModelPrices = extractFunction(html, 'rshNormalizeRegionalGlobalModelPrices');
const normalizeRegionalTargetModelPrices = extractFunction(html, 'rshNormalizeRegionalTargetModelPrices');
const brandForPublish = extractFunction(html, 'rshBrandForShopeePublish');
const mrUploadRegionImages = extractFunction(html, 'mrUploadRegionImages');
const regionBatchOrder = extractFunction(html, 'shopeeRegionBatchOrder');
const batchRegister = extractFunction(html, 'shopeeRegisterCbscWithRegionBatches');
const updateDifferentWeightShipping = extractFunction(html, 'rshUpdateDifferentWeightShipping');
const renderModal = html.slice(html.indexOf('<section class="rsh-seller-section grid" id="rsh-info-section"'), html.indexOf('<!-- Description -->'));
const variantSection = html.slice(html.indexOf('<!-- Sales Information -->'), html.indexOf('<!-- Shipping + region pre-order/DTS -->'));
const shippingSection = html.slice(html.indexOf('<!-- Shipping + region pre-order/DTS -->'), html.indexOf('<!-- Others -->'));
const masterPromoteBlock = html.slice(html.indexOf('// 6. Insert product_shopee_listings'), html.indexOf('// 9. ok:true'));
const masterPromoteRegisterBlock = html.slice(html.indexOf('const doRegisterCbsc = async'), html.indexOf('// Decode all relevant fields upfront'));
const publishToRegionBlock = bridge.slice(bridge.indexOf("if (action === 'publish_to_region' && req.method === 'POST')"), bridge.indexOf("if (action === 'oauth_exchange')"));
const registerCbscBlock = bridge.slice(bridge.indexOf("if (action === 'register_cbsc' && req.method === 'POST')"), bridge.indexOf("if (action === 'item_info')"));
const reconcilePublishedList = extractFunction(bridge, 'reconcilePublishResultsWithPublishedList');
const getPublishLogistics = extractFunction(bridge, 'getPublishLogistics');
const repairPublishedItemLogistics = extractFunction(bridge, 'repairPublishedItemLogisticsForGlobalItem');
const buildPublishItemPayload = extractFunction(bridge, 'buildPublishItemPayload');
const retryMinimalPublish = extractFunction(bridge, 'retryMinimalPublish');
const shopLevelFallback = extractFunction(bridge, 'createShopLevelFallbackItem');
const initShopTierVariationBlock = bridge.slice(
  bridge.indexOf("if (action === 'init_shop_tier_variation')"),
  bridge.indexOf("if (action === 'update_shop_tier_variation')"),
);

assert.match(
  persistMappings,
  /const requestedRegions = Array\.from\(new Set\(\[[\s\S]*payload\.targets/,
  'persistMappings must derive every requested region, not only bridge results',
);
assert.match(
  persistMappings,
  /missingResultRows[\s\S]*no result from bridge/,
  'persistMappings must create failed rows for regions omitted by the bridge',
);
assert.doesNotMatch(
  persistMappings,
  /mapping:\s*'skipped'/,
  'persistMappings must persist failed/no-item regions instead of skipping them',
);
assert.match(
  persistMappings,
  /status:\s*listingStatus[\s\S]*last_error:\s*lastError/,
  'persistMappings must save failed region status and last_error',
);

assert.match(
  publishStateFromRows,
  /every\(\(row\) => row\.ok\)/,
  'publish state must be calculated from per-region mapping success',
);
assert.match(
  `${publishStateFromRows}\n${applyPublishState}`,
  /partial_published/,
  'partial region success must become partial_published',
);
assert.doesNotMatch(
  html,
  /\.update\(\{\s*shopee_item_id:\s*json\.global_item_id,\s*shopee_publish_state:\s*'published'\s*\}\)/,
  'direct Shopee group registration must not mark all products published just because a global_item_id exists',
);

assert.doesNotMatch(
  masterPromoteBlock,
  /shopee_item_id:\s*globalItemId/,
  'master promote listing upsert must not use the non-existent product_shopee_listings.shopee_item_id column',
);
assert.doesNotMatch(
  masterPromoteBlock,
  /publish_status:/,
  'master promote listing upsert must not use the non-existent product_shopee_listings.publish_status column',
);
assert.match(
  masterPromoteBlock,
  /global_item_id:\s*globalItemId/,
  'master promote listing upsert must persist global_item_id',
);
assert.match(
  masterPromoteBlock,
  /const mapped = !!\(res\.ok && res\.item_id\)[\s\S]*status:\s*mapped \? 'mapped' : 'failed'/,
  'master promote listing upsert must persist mapped/failed status only when item_id exists',
);

assert.doesNotMatch(
  renderModal,
  /id="rsh-sourcing-price-krw"/,
  'Shopee Basic Information must not render top-level sourcing price',
);
assert.doesNotMatch(
  renderModal,
  /id="rsh-cost-krw"/,
  'Shopee Basic Information must not render top-level settlement price',
);
assert.match(
  shippingSection,
  /id="rsh-shipping-package-fields"/,
  'Shipping package fields must be hideable when option weights are present',
);
assert.match(
  shippingSection,
  /id="rsh-different-weight"/,
  'Shipping section must expose an explicit Different weight state',
);
assert.match(
  html,
  /function rshUpdateDifferentWeightShipping/,
  'Shopee modal must update Different weight/shipping fields from option weights',
);
assert.match(
  updateDifferentWeightShipping,
  /packageFields\.style\.display = optionWeights \? 'none' : 'contents'[\s\S]*differentWeight\.textContent = optionWeights \? 'ON' : 'OFF'/,
  'Shipping section must hide item-level package fields and enable Different weight when every option has a weight',
);
assert.match(
  variantSection,
  /style="display:none;"[\s\S]*id="rsh-var-bulk-sourcing"[\s\S]*style="display:none;"[\s\S]*id="rsh-var-bulk-price"/,
  'Shopee register modal must hide wholesale/settlement KRW bulk inputs from the operator-facing registration UI',
);
assert.match(
  html,
  /<td style="display:none;"><input id="\$\{rshVariantInputId\('sourcing', index\)\}[\s\S]*<td style="display:none;"><input id="\$\{rshVariantInputId\('price', index\)\}/,
  'Shopee register modal must keep option wholesale/settlement inputs hidden while preserving calculation values',
);
assert.match(
  buildGroupPayload,
  /rshGroupHasOptionWeights\(products\)/,
  'group payload must derive shipping behavior from option weights',
);
assert.match(
  brandForPublish,
  /regions\.has\('BR'\)[\s\S]*brand_id:\s*0[\s\S]*No Brand/,
  'Shopee group registration must normalize branded category 100740 payloads to NoBrand when BR is targeted',
);
assert.match(
  buildGroupPayload,
  /rshBrandForShopeePublish\(rshReadBrandObject\(\),\s*activeRegions\)/,
  'group payload must apply BR-safe brand normalization',
);
assert.match(
  html,
  /RSH_REGION_MODEL_PRICE_RATIO_LIMITS[\s\S]*SG:\s*5[\s\S]*TW:\s*5[\s\S]*TH:\s*5[\s\S]*MY:\s*5[\s\S]*PH:\s*5[\s\S]*BR:\s*4/,
  'group payload must encode observed Shopee region model price ratio limits',
);
assert.match(
  html,
  /function rshBuildModelPriceRatioExclusionPlan[\s\S]*maxAllowedPrice[\s\S]*excluded[\s\S]*function rshBuildVariantPriceRatioExclusionPlan/,
  'V2 Shopee registration must build a region-aware option exclusion plan before API calls',
);
assert.match(
  html,
  /function rshConfirmModelPriceRatioExclusions[\s\S]*window\.confirm[\s\S]*이 옵션들을 제외하고 등록할까요/,
  'V2 Shopee registration must warn operators before excluding price-ratio options',
);
assert.match(
  buildGroupPayload,
  /allowedSkus[\s\S]*allVariantInputs\.filter[\s\S]*price_ratio_excluded_options/,
  'group payload must exclude price-ratio violating option SKUs and keep the evidence in payload',
);
assert.match(
  normalizeRegionalGlobalModelPrices,
  /rshStrictestModelPriceRatioLimit\(activeRegions\)[\s\S]*global_original_price:\s*safeMinimum/,
  'group payload must normalize Global Product model prices using the strictest targeted region price ratio',
);
assert.match(
  buildGroupPayload,
  /const model = rshNormalizeRegionalGlobalModelPrices\(modelRaw,\s*activeRegions\)/,
  'group payload must apply region-aware global model price normalization before register_cbsc',
);
assert.match(
  normalizeRegionalTargetModelPrices,
  /rshModelPriceRatioLimitForRegion\(region\)[\s\S]*original_price:\s*safeMinimum[\s\S]*regional_original_price_adjusted_from/,
  'group payload must normalize each target-region option price when the local price ratio would be rejected',
);
assert.match(
  buildGroupPayload,
  /return rshNormalizeRegionalTargetModelPrices\(targetModels,\s*region\)/,
  'group payload must apply region-aware target model price normalization for each region variation',
);
assert.match(
  batchRegister,
  /SHOPEE_REGISTER_REGION_BATCH_SIZE[\s\S]*register_cbsc[\s\S]*publish_to_region[\s\S]*global_item_id/,
  'V2 group registration must split large region publishes into register_cbsc + publish_to_region batches',
);
assert.match(
  regionBatchOrder,
  /BR:\s*0[\s\S]*SG:\s*1/,
  'V2 batch ordering must prioritize BR so its longer polling window overlaps other regions',
);
assert.match(
  masterPromoteRegisterBlock,
  /shopeeRegisterCbscWithRegionBatches/,
  'master promote registration must use the same timeout-safe Shopee batch helper',
);
assert.match(
  html,
  /rshBuildModelPriceRatioExclusionPlan[\s\S]*rshConfirmModelPriceRatioExclusions[\s\S]*shopeeVariationOptions[\s\S]*const skusInGroup\s*=\s*shopeeVariationOptions\.map/,
  'master promote registration must exclude price-ratio violating options before Shopee publish and DB state updates',
);

assert.match(
  mrUploadRegionImages,
  /mrMapWithConcurrency\(regions,\s*3/,
  'master registration image upload must upload target regions concurrently with a limit',
);
assert.doesNotMatch(
  mrUploadRegionImages,
  /for \(const r of regions\)/,
  'master registration image upload must not serialize all target regions',
);

assert.match(
  bridge,
  /function isVariationInvalidPublishFailure[\s\S]*function isCrossuploadPermissionPublishFailure[\s\S]*function shouldRetryMinimalPublish[\s\S]*async function retryMinimalPublish/,
  'Shopee bridge must detect retryable variation/permission publish failures and expose a minimal publish retry',
);
assert.match(
  bridge,
  /SHOPEE_REGION_MODEL_PRICE_RATIO_LIMITS[\s\S]*SG:\s*5[\s\S]*TW:\s*5[\s\S]*TH:\s*5[\s\S]*MY:\s*5[\s\S]*PH:\s*5[\s\S]*BR:\s*4[\s\S]*function normalizeRegionalGlobalModelPriceRatio/,
  'Shopee bridge must defensively normalize Global Product option price ratios with observed region limits',
);
assert.match(
  bridge,
  /function normalizeRegionalTargetModelPriceRatio[\s\S]*row\.model\.original_price = safeMinimum/,
  'Shopee bridge must defensively normalize target-region option price ratios',
);
assert.match(
  registerCbscBlock,
  /normalizeRegionalGlobalModelPriceRatio\(body,\s*targetInputs\)[\s\S]*regional_global_model_price_ratio_normalized/,
  'register_cbsc must apply and log regional global model price ratio normalization',
);
assert.match(
  registerCbscBlock,
  /normalizeRegionalTargetModelPriceRatio\(targetInputs\)[\s\S]*regional_target_model_price_ratio_normalized/,
  'register_cbsc must apply and log regional target model price ratio normalization',
);
assert.match(
  publishToRegionBlock,
  /normalizeRegionalTargetModelPriceRatio\(targetInputs\)[\s\S]*regional_target_price_adjustments/,
  'publish_to_region must also normalize target-region option prices for missing-region retries',
);
assert.match(
  bridge,
  /const retries = region === 'BR' \? 4/,
  'BR published_list verification must stay bounded so single-region retries finish inside the Edge timeout',
);
assert.match(
  bridge,
  /const SHOPEE_BR_MAX_PUBLISH_POLLS = 36[\s\S]*const maxPoll = \(targetRegion === 'BR'\) \? SHOPEE_BR_MAX_PUBLISH_POLLS : 30/,
  'BR publish polling must use a bounded constant instead of an unbounded or oversized inline window',
);
assert.match(
  bridge,
  /SHOPEE_BR_PUBLISHED_LIST_EARLY_CHECK_AFTER_POLLS[\s\S]*verifyPublishedListOutcomeOnce/,
  'BR publish polling must check published_list during long ambiguous publish_task polling',
);
assert.match(
  registerCbscBlock,
  /earlyPublishedOutcome[\s\S]*verified_via_br_early_published_list_[\s\S]*earlyPublishedOutcome \|\| parsePublishOutcome/,
  'register_cbsc must short-circuit BR polling once published_list confirms the item',
);
assert.match(
  registerCbscBlock,
  /regional_global_price_adjustments: regionalGlobalPriceAdjustments[\s\S]*br_global_price_adjustments: brGlobalPriceAdjustments/,
  'register_cbsc must return regional and BR Global Product price-ratio adjustments for diagnosis',
);
assert.match(
  registerCbscBlock,
  /regional_target_price_adjustments: regionalTargetPriceAdjustments[\s\S]*br_target_price_adjustments: brTargetPriceAdjustments/,
  'register_cbsc must return regional and BR target-region price-ratio adjustments for diagnosis',
);
assert.match(
  reconcilePublishedList,
  /verified_via_final_published_list_reconcile[\s\S]*previous_result/,
  'Shopee bridge must reconcile failed or missing region results against final published_list before returning',
);
assert.match(
  getPublishLogistics,
  /deliveryOnly[\s\S]*isPickupOrLockerLogisticsName/,
  'Shopee bridge publish logistics must exclude pickup/locker/collection-point channels when delivery channels are available',
);
assert.match(
  bridge,
  /function isPickupOrLockerLogisticsName[\s\S]*collection\\s\*points\?/,
  'Shopee bridge logistics filter must also catch Collection Points channels, not only self-collection labels',
);
assert.match(
  getPublishLogistics,
  /ch\?\.logistics_channel_id \?\? ch\?\.logistic_id/,
  'Shopee bridge publish logistics must prefer docs-backed logistics_channel_id over legacy logistic_id',
);
assert.match(
  repairPublishedItemLogistics,
  /get_published_list[\s\S]*get_item_base_info[\s\S]*update_item[\s\S]*logistic_info/,
  'Shopee bridge must repair existing published local item logistics before adding more regions',
);
assert.match(
  publishToRegionBlock,
  /repairPublishedItemLogisticsForGlobalItem[\s\S]*logistics_repairs/,
  'publish_to_region must run and report existing published-item logistics repair',
);
assert.match(
  publishToRegionBlock,
  /shouldRepairPublishedLogistics[\s\S]*br_only_publish_no_existing_logistics_repair/,
  'publish_to_region must skip unrelated existing-region logistics repair for BR-only publishes to reduce registration time',
);
assert.match(
  bridge,
  /action === 'lookup-sku' && req\.method === 'POST'[\s\S]*action === 'lookup-sku' && req\.method === 'GET'/,
  'Shopee bridge GET lookup-sku must use the DB-first handler instead of the legacy remote scan handler',
);
assert.match(
  `${publishToRegionBlock}\n${registerCbscBlock}`,
  /reconcilePublishResultsWithPublishedList/,
  'publish_to_region and register_cbsc must apply final published_list reconciliation',
);
assert.match(
  publishToRegionBlock,
  /shouldRetryMinimalPublish[\s\S]*retryMinimalPublish/,
  'publish_to_region must retry variation-invalid and crossupload-permission failures with minimal publish',
);
assert.match(
  publishToRegionBlock,
  /parsePublishOutcome[\s\S]*shouldRetryMinimalPublish[\s\S]*retryMinimalPublish[\s\S]*Fallback verification/,
  'publish_to_region must run minimal retry before slower fallback verification loops',
);
assert.match(
  bridge,
  /isVariationDuplicateNamePublishFailure[\s\S]*规格选项名称重复[\s\S]*shouldRetryMinimalPublish[\s\S]*isVariationDuplicateNamePublishFailure/,
  'Shopee bridge must treat duplicate variation option-name publish failures as minimal-retryable',
);
assert.match(
  shopLevelFallback,
  /product\/add_item[\s\S]*product\/init_tier_variation[\s\S]*product\/delete_item[\s\S]*shop_level_fallback[\s\S]*global_item_id:\s*null/,
  'Shopee bridge must provide a BR shop-level fallback that creates option listings with init_tier_variation and cleans up failed local items',
);
assert.doesNotMatch(
  shopLevelFallback,
  /payload\.tier_variation|payload\.model\s*=/,
  'Shopee bridge shop-level fallback must not send variation fields directly to product/add_item',
);
assert.match(
  shopLevelFallback,
  /standardise_tier_variation[\s\S]*model[\s\S]*weight[\s\S]*sent_init_tier_variation/,
  'Shopee bridge shop-level fallback must preserve option model prices, stock, SKU, and per-model weight in init_tier_variation payload',
);
assert.match(
  initShopTierVariationBlock,
  /standardise_tier_variation[\s\S]*model_sku[\s\S]*weight[\s\S]*product\/init_tier_variation/,
  'Shopee bridge must expose a docs-backed shop init_tier_variation mutation for BR no-option publish then option-injection fallback',
);
assert.match(
  `${publishToRegionBlock}\n${registerCbscBlock}`,
  /createShopLevelFallbackItem[\s\S]*br_crossupload_permission_global_publish_failed/,
  'publish_to_region and register_cbsc must call shop-level fallback for BR crossupload permission failures',
);
assert.match(
  bridge,
  /BR_OPTION_CROSSUPLOAD_PERMISSION_BLOCKED[\s\S]*product\.cnsc_shop_block/,
  'Shopee bridge must surface the proven BR CBSC option crossupload permission blocker instead of reporting a generic publish failure',
);
assert.match(
  `${publishToRegionBlock}\n${registerCbscBlock}`,
  /br_option_crossupload_blocked[\s\S]*createShopLevelFallbackItem/,
  'Shopee bridge must suppress invalid shop-level fallback after BR option crossupload is classified as a permanent Shopee permission block',
);
assert.match(
  `${publishToRegionBlock}\n${registerCbscBlock}`,
  /responseResults\.every\(\(row: any\) => row\.ok === true\)/,
  'Shopee bridge top-level ok must reflect per-region failures after final reconciliation',
);
assert.match(
  html,
  /rowGlobalItemId[\s\S]*Object\.prototype\.hasOwnProperty\.call\(info,\s*'global_item_id'\)[\s\S]*global_item_id:\s*rowGlobalItemId \|\| null/,
  'V2 mapping persistence must respect row-level null global_item_id for shop-level fallback mappings',
);
assert.match(
  registerCbscBlock,
  /parsePublishOutcome[\s\S]*shouldRetryMinimalPublish[\s\S]*retryMinimalPublish[\s\S]*BR gets 3 retries/,
  'register_cbsc must run minimal retry before slower fallback verification loops',
);
assert.match(
  `${buildPublishItemPayload}\n${retryMinimalPublish}`,
  /logistic:\s*logistics,\s*[\r\n\s]*logistic_info:\s*logistics/,
  'Shopee global publish payloads must send both logistic and logistic_info to avoid falling back to unavailable default channels',
);
assert.match(
  registerCbscBlock,
  /shouldRetryMinimalPublish[\s\S]*retryMinimalPublish/,
  'register_cbsc must retry variation-invalid and crossupload-permission failures with minimal publish',
);
assert.match(
  `${publishToRegionBlock}\n${registerCbscBlock}`,
  /isCrossuploadPermissionPublishFailure\(taskRes\)\) break/,
  'publish polling must stop early on crossupload permission failures to avoid long waits before minimal retry',
);
assert.match(
  bridge,
  /async function mapWithConcurrency/,
  'Shopee bridge must have a bounded concurrency helper for region publish work',
);
assert.match(
  publishToRegionBlock,
  /mapWithConcurrency\(targetInputs,\s*2/,
  'publish_to_region must limit concurrent region publish tasks to avoid Edge worker resource limits',
);
assert.match(
  registerCbscBlock,
  /mapWithConcurrency\(targetInputs,\s*2/,
  'register_cbsc must limit concurrent region publish tasks to avoid Edge worker resource limits',
);
assert.doesNotMatch(
  `${publishToRegionBlock}\n${registerCbscBlock}`,
  /Promise\.all\(targetInputs\.map/,
  'Shopee bridge must not publish all target regions with unbounded Promise.all',
);
assert.match(
  `${publishToRegionBlock}\n${registerCbscBlock}`,
  /targetRegion === 'BR' && !\(outcome as any\)\.minimal_item_retry/,
  'BR fallback retry must not run after minimal retry already failed',
);

console.log('V2 Shopee registration reliability checks passed');
