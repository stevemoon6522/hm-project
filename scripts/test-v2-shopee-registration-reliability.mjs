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
const normalizeBrGlobalModelPrices = extractFunction(html, 'rshNormalizeBrGlobalModelPrices');
const normalizeBrTargetModelPrices = extractFunction(html, 'rshNormalizeBrTargetModelPrices');
const brandForPublish = extractFunction(html, 'rshBrandForShopeePublish');
const mrUploadRegionImages = extractFunction(html, 'mrUploadRegionImages');
const renderModal = html.slice(html.indexOf('<section class="rsh-seller-section grid" id="rsh-info-section"'), html.indexOf('<!-- Description -->'));
const shippingSection = html.slice(html.indexOf('<!-- Shipping + region pre-order/DTS -->'), html.indexOf('<!-- Others -->'));
const masterPromoteBlock = html.slice(html.indexOf('// 6. Insert product_shopee_listings'), html.indexOf('// 9. ok:true'));
const publishToRegionBlock = bridge.slice(bridge.indexOf("if (action === 'publish_to_region' && req.method === 'POST')"), bridge.indexOf("if (action === 'oauth_exchange')"));
const registerCbscBlock = bridge.slice(bridge.indexOf("if (action === 'register_cbsc' && req.method === 'POST')"), bridge.indexOf("if (action === 'item_info')"));

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
  normalizeBrGlobalModelPrices,
  /RSH_BR_GLOBAL_MODEL_PRICE_RATIO_LIMIT[\s\S]*global_original_price:\s*safeMinimum/,
  'group payload must normalize Global Product model prices when BR would reject the option price ratio',
);
assert.match(
  buildGroupPayload,
  /const model = rshNormalizeBrGlobalModelPrices\(modelRaw,\s*activeRegions\)/,
  'group payload must apply BR-safe global model price normalization before register_cbsc',
);
assert.match(
  normalizeBrTargetModelPrices,
  /original_price:\s*safeMinimum[\s\S]*br_original_price_adjusted_from/,
  'group payload must normalize BR target-region option prices when the local price ratio would be rejected',
);
assert.match(
  buildGroupPayload,
  /return rshNormalizeBrTargetModelPrices\(targetModels,\s*region\)/,
  'group payload must apply BR-safe target model price normalization for each region variation',
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
  /SHOPEE_BR_GLOBAL_MODEL_PRICE_RATIO_LIMIT = 3\.5[\s\S]*function normalizeBrGlobalModelPriceRatio/,
  'Shopee bridge must defensively normalize BR Global Product option price ratios',
);
assert.match(
  bridge,
  /function normalizeBrTargetModelPriceRatio[\s\S]*row\.model\.original_price = safeMinimum/,
  'Shopee bridge must defensively normalize BR target-region option price ratios',
);
assert.match(
  registerCbscBlock,
  /normalizeBrGlobalModelPriceRatio\(body,\s*targetInputs\)[\s\S]*br_global_model_price_ratio_normalized/,
  'register_cbsc must apply and log BR global model price ratio normalization',
);
assert.match(
  registerCbscBlock,
  /normalizeBrTargetModelPriceRatio\(targetInputs\)[\s\S]*br_target_model_price_ratio_normalized/,
  'register_cbsc must apply and log BR target model price ratio normalization',
);
assert.match(
  bridge,
  /const retries = region === 'BR' \? 8/,
  'BR published_list verification must wait longer because publish_task_result can report false failure',
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
  /br_global_price_adjustments: brGlobalPriceAdjustments/,
  'register_cbsc must return BR Global Product price-ratio adjustments for diagnosis',
);
assert.match(
  registerCbscBlock,
  /br_target_price_adjustments: brTargetPriceAdjustments/,
  'register_cbsc must return BR target-region price-ratio adjustments for diagnosis',
);
assert.match(
  publishToRegionBlock,
  /shouldRetryMinimalPublish[\s\S]*retryMinimalPublish/,
  'publish_to_region must retry variation-invalid and crossupload-permission failures with minimal publish',
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
