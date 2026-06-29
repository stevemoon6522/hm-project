import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const supabaseBridgePath = join(root, 'supabase', 'functions', 'joom-bridge', 'index.ts');
const edgeBridgePath = join(root, 'edge-functions', 'joom-bridge', 'index.ts');
const adapterPath = join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'joom.ts');
const htmlPath = join(root, 'v2', 'index.html');

for (const path of [supabaseBridgePath, edgeBridgePath, adapterPath, htmlPath]) {
  assert.equal(existsSync(path), true, `${path} must exist`);
}

const bridge = readFileSync(supabaseBridgePath, 'utf8');
const edge = readFileSync(edgeBridgePath, 'utf8');
const adapter = readFileSync(adapterPath, 'utf8');
const html = readFileSync(htmlPath, 'utf8');
const hash = (value) => createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');

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

assert.equal(hash(bridge), hash(edge), 'supabase and edge-functions joom-bridge copies must match');

const persistHelper = extractFunction(bridge, 'persistJoomRegistrationMappings');
const variantMapper = extractFunction(bridge, 'joomPublishResponseVariants');

for (const token of [
  'async function hydrateJoomProductForMapping',
  'async function persistJoomRegistrationMappings',
  'products',
  'joom_product_id: joomProductId',
  'joom_variant_id: joomVariantId',
  'joom_currency: currency',
  'joom_mapping_status: mappingStatus',
  'absorb_platform_sku_lookup',
  'p_platform: "joom"',
  'p_country: "GLOBAL"',
  'p_external_variant_id: joomVariantId',
  'mapping_results',
  'function hasCompleteJoomPublishMapping',
  'async function persistJoomRegistrationMappingsFast',
  'mapping_persist_mode',
  'mapping_hydration_skipped',
]) {
  assert(bridge.includes(token), `joom-bridge missing registration mapping token: ${token}`);
}

const fastPersistHelper = extractFunction(bridge, 'persistJoomRegistrationMappingsFast');
const completeMappingHelper = extractFunction(bridge, 'hasCompleteJoomPublishMapping');
assert.match(
  completeMappingHelper,
  /expectedSkus\.every\(\(sku\) => present\.has/,
  'Fast Joom publish must only skip hydrate when every expected SKU is present in the publish response',
);
assert.match(
  fastPersistHelper,
  /Promise\.all\(\[/,
  'Fast Joom persist should perform product and platform mapping writes in parallel',
);
assert.match(
  bridge,
  /const shouldHydrate = verifyPublish \|\| !completePublishMapping/,
  'Verified mode must force post-publish hydrate while fast complete responses may skip it',
);
assert.match(
  html,
  /fast:\s*true,[\s\S]*verify:\s*false/,
  'V2 Joom publish UI should request fast mode by default and leave remote verification as a follow-up action',
);
assert.match(
  html,
  /joomRemoteVerification[\s\S]*not_checked/,
  'V2 Joom publish UI should mark remote verification as not checked instead of blocking publish on lookup-sku',
);

assert.match(
  variantMapper,
  /id:\s*v\.id\s*\?\s*String\(v\.id\)\s*:\s*null/,
  'Joom publish response variants must expose the Joom-assigned variant id',
);
assert.match(
  variantMapper,
  /productId:\s*v\.productId\s*\?\s*String\(v\.productId\)/,
  'Joom publish response variants must expose parent productId',
);
assert.match(
  variantMapper,
  /currency:\s*v\.currency/,
  'Joom publish response variants must expose the API currency',
);
assert.match(
  persistHelper,
  /variantBySku\.get\(sku\)[\s\S]*joomVariantId/,
  'Joom mapping helper must match returned variants by merchant SKU before persisting variant id',
);
assert.match(
  persistHelper,
  /mapping_failed/,
  'Joom mapping helper must record mapping_failed when a requested SKU is missing from the publish response',
);

for (const token of [
  'product_id: master.id || null',
  'source_product_id',
  'variant?.id',
  'variant?.currency',
  'mapping_results',
]) {
  assert(adapter.includes(token), `Joom platform adapter missing mapping token: ${token}`);
}

assert(!html.includes('joom_variant_id: matched.sku'), 'V2 Joom publish UI must not store SKU as joom_variant_id');
assert(html.includes('joom_variant_id: matched.id'), 'V2 Joom publish UI must store the Joom-assigned variant id');
assert(html.includes("joom_currency: matched.currency || 'USD'"), 'V2 Joom publish UI must preserve returned Joom currency');
assert(html.includes('product_id: r.id || r.product_id || r.source_product_id'), 'V2 Joom publish UI must pass product_id so fast persist can avoid fallback for real product rows');

console.log('v2 Joom registration platform mapping checks passed');
