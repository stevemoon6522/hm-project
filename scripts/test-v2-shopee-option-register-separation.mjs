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
const bridge = readFileSync(join(root, 'supabase', 'functions', 'shopee-bridge', 'index.ts'), 'utf8');

const rshBlock = sliceBetween(html, 'PHASE B', '// P2-1: Legacy modal URL flag');
const groupPayloadBlock = sliceBetween(rshBlock, 'function rshBuildGroupRegisterPayload', 'async function rshRegisterOptionGroupViaCbsc');
const singleAccountBlock = sliceBetween(rshBlock, 'async function rshRegisterSingleForAccount', 'async function rshRegisterGroupForAccount');
const stage2SingleBlock = sliceBetween(rshBlock, '// Call platform-publish dispatcher with activeRegions', 'const resp = await fetch(PLATFORM_PUBLISH_URL');
const publishToRegionBlock = sliceBetween(bridge, "if (action === 'publish_to_region' && req.method === 'POST')", "if (action === 'oauth_exchange')");
const registerCbscBlock = sliceBetween(bridge, "if (action === 'register_cbsc' && req.method === 'POST')", "if (action === 'item_info')");

assert(
  rshBlock.includes('async function rshRegisterOptionGroupViaCbsc')
    && rshBlock.includes('rshRegisterGroupViaCbsc = rshRegisterOptionGroupViaCbsc'),
  'option products must have a clearly named option-group registration path with legacy alias only for compatibility',
);

assert(
  groupPayloadBlock.includes("registration_kind: 'option_group'")
    && groupPayloadBlock.includes('rshDescriptionForRegistration(productName || parentSku, master.lifecycle_state, master.components_extracted_en)'),
  'option-group register payload must be explicitly tagged and must use the sanitized/register-time description builder',
);

assert(
  singleAccountBlock.includes("registration_kind: 'single'")
    && stage2SingleBlock.includes("registration_kind: 'single'"),
  'single-product platform-publish payloads must be explicitly tagged as single registrations',
);

assert(
  bridge.includes('function sanitizeShopeePlainTextDescription')
    && bridge.includes('description: sanitizeShopeePlainTextDescription(body.description)')
    && bridge.includes('sanitizeShopeePlainTextDescription(target.description ?? body.description)'),
  'shopee-bridge must strip HTML-ish descriptions before add_global_item/create_publish_task',
);

assert(
  bridge.includes('async function finalizePublishOutcomeAfterSuccess')
    && publishToRegionBlock.includes('await finalizePublishOutcomeAfterSuccess(outcome, targetRegion, target, body, reqAccountKey)')
    && registerCbscBlock.includes('await finalizePublishOutcomeAfterSuccess(outcome, targetRegion, target, body, accountKey)'),
  'normal publish success paths must run shop price sync after publish, not only TW retry paths',
);

console.log('v2 Shopee option registration separation checks passed');
