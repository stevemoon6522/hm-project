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
const adapter = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'shopee.ts'), 'utf8');
const bridge = readFileSync(join(root, 'supabase', 'functions', 'shopee-bridge', 'index.ts'), 'utf8');

const rshDescriptionBlock = sliceBetween(html, 'const READY_STOCK_DESC_TEMPLATE', '// Pick the correct block-level template');
const rshSafetyBlock = sliceBetween(html, 'function rshShopeeSafeDescription', '// Specification attributes per category');
const adapterDescriptionBlock = sliceBetween(adapter, 'function shopeeSellerCenterDescription', 'const SUPABASE_URL');
const bridgeSanitizerBlock = sliceBetween(bridge, 'function sanitizeShopeePlainTextDescription', 'function imageBlockFrom');

const fourByteEmoji = /[\u{1F000}-\u{1FAFF}]/u;
const knownUnsupported = ['🟣', '💿', '📊', '📦', '📌', '💳'];

for (const token of knownUnsupported) {
  assert(!rshDescriptionBlock.includes(token), `V2 Shopee description template must not contain unsupported emoji ${token}`);
  assert(!adapterDescriptionBlock.includes(token), `Shopee adapter description template must not contain unsupported emoji ${token}`);
}

assert(!fourByteEmoji.test(rshDescriptionBlock), 'V2 Shopee description template must be free of 4-byte emoji');
assert(!fourByteEmoji.test(adapterDescriptionBlock), 'Shopee adapter description template must be free of 4-byte emoji');

for (const token of [
  'function rshShopeeSafeDescription',
  "replace(/🟣/gu, '[Product]')",
  "replace(/💿/gu, '[Official Album]')",
  "replace(/📊/gu, '[Chart Certified]')",
  "replace(/📦/gu, '[Shipping]')",
  "replace(/📌/gu, '[Contents]')",
  "replace(/💳/gu, '[COD Policy]')",
  "replace(/[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]/g, '')",
]) {
  assert(rshSafetyBlock.includes(token), `V2 Shopee description sanitizer missing token: ${token}`);
}

for (const token of [
  "replace(/🟣/gu, '[Product]')",
  "replace(/💿/gu, '[Official Album]')",
  "replace(/📊/gu, '[Chart Certified]')",
  "replace(/📦/gu, '[Shipping]')",
  "replace(/📌/gu, '[Contents]')",
  "replace(/💳/gu, '[COD Policy]')",
  "replace(/[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]/g, '')",
]) {
  assert(bridgeSanitizerBlock.includes(token), `Shopee bridge sanitizer missing token: ${token}`);
}

for (const token of [
  '[Product]',
  '[Official & Authentic K-POP Album]',
  '[Chart Certified]',
  '[Fast & Secure Shipping]',
  '[Contents]',
  '[Important Notice]',
  '[COD Policy]',
]) {
  assert(rshDescriptionBlock.includes(token), `V2 Shopee safe template missing section: ${token}`);
  assert(adapterDescriptionBlock.includes(token), `Shopee adapter safe template missing section: ${token}`);
}

console.log('v2 Shopee emoji-safe description checks passed');
