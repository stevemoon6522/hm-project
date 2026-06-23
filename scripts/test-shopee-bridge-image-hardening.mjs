import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const edge = readFileSync(join(root, 'edge-functions/shopee-bridge/index.ts'), 'utf8');
const supabase = readFileSync(join(root, 'supabase/functions/shopee-bridge/index.ts'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sliceBetween(source, start, end) {
  const s = source.indexOf(start);
  assert(s >= 0, `missing start token: ${start}`);
  const e = source.indexOf(end, s);
  assert(e > s, `missing end token after ${start}: ${end}`);
  return source.slice(s, e);
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

assert(sha256(edge) === sha256(supabase), 'edge-functions and supabase/functions shopee-bridge copies must match');

for (const token of [
  'const SOURCE_VERSION = 70',
  'const OPERATING_REGION_SET = new Set(OPERATING_REGIONS)',
  'const PROXY_IMAGE_MAX_BYTES = 15 * 1024 * 1024',
  'const UPLOAD_IMAGE_MAX_BYTES = 2 * 1024 * 1024',
  'const GENERATED_UPLOAD_CACHE_TTL_MS = 30 * 60 * 1000',
  'staronemall2.wisacdn.com',
  'mgqlwgnmwegzsjelbrih.supabase.co',
  'res.cloudinary.com',
  '.wisacdn.com',
  '.shopeesz.com',
]) {
  assert(edge.includes(token), `missing bridge hardening token: ${token}`);
}

for (const token of [
  'import { requireAuthenticatedUser }',
  'async function requireBridgeTokenOrAuthenticatedUser(req: Request): Promise<Response | null>',
  'x-platform-bridge-token',
  'bridge_token_or_authenticated_user_failed',
  "'internal_bridge' : 'authenticated_user'",
]) {
  assert(edge.includes(token), `missing internal bridge operator auth guard: ${token}`);
}

const proxyBlock = sliceBetween(edge, "if (action === 'proxy_image')", '// POST /upload_image');
for (const token of [
  'assertPublicProxyTarget(upstream)',
  'redirect: \'manual\'',
  'isSupportedImageContentType(ct)',
  'PROXY_IMAGE_MAX_BYTES',
  'isSvgLike(ct, bytes)',
  'IMAGE_PROXY_HEADERS',
]) {
  assert(proxyBlock.includes(token), `proxy_image missing guard: ${token}`);
}
assert(!proxyBlock.includes('image/svg+xml,image/*'), 'proxy_image must not request SVG from upstream');
assert(!proxyBlock.includes('...CORS }'), 'proxy_image response must not use broad JSON CORS headers');

for (const fn of [
  'function isPrivateIpv4',
  'function isPrivateIpv6',
  'function isPrivateOrLocalHost',
  'async function assertPublicProxyTarget',
]) {
  assert(edge.includes(fn), `missing private-network guard: ${fn}`);
}
assert(edge.includes("Deno.resolveDns(hostname, 'A')"), 'proxy_image must resolve A records for private-range blocking');
assert(edge.includes("Deno.resolveDns(hostname, 'AAAA')"), 'proxy_image must resolve AAAA records for private-range blocking');

const uploadBlock = sliceBetween(edge, "if (action === 'upload_image' && req.method === 'POST')", '// POST /add_item');
for (const token of [
  'normalizeRegion(body.region)',
  'decodeBase64Image(body.image_base64 || \'\')',
  'inspectUploadImage(decoded.bytes, decoded.mimeHint)',
  'findRecentGeneratedUpload(idempotencyKeyHash, r, accountKey)',
  'source_url',
  'main_image_url',
  'layer_version',
  'output_hash',
  'extractPerImageErrors(uploadJson)',
  'insertUploadLog',
  'cached: true',
]) {
  assert(uploadBlock.includes(token), `upload_image missing guard/cache behavior: ${token}`);
}

const updatePriceBlock = sliceBetween(edge, "if (action === 'update_price' && req.method === 'POST')", "if (action === 'update_item_sku' && req.method === 'POST')");
for (const token of [
  "result?.response?.failure_list",
  "failureList.length === 0",
  "failure_list: failureList",
]) {
  assert(updatePriceBlock.includes(token), `update_price missing failure_list handling: ${token}`);
}

for (const token of [
  'function parsePngDimensions',
  'function parseJpegDimensions',
  'function inspectUploadImage',
  'function extractPerImageErrors',
  'async function uploadShopeeMediaImage',
  'async function fetchBrandListPages',
  'function pickOptionForExistingValue',
  'async function buildCategoryAttributeListForRegions',
  'function isTransientPublishTaskLookup',
  'function isAmbiguousPublishFailure',
  'function shouldContinuePublishPolling',
  'response.has_next_page',
  'response.next_offset',
  '/api/v2/global_product/get_brand_list',
  "targetInputs.map((target: any) => target.region)",
  "normalized.includes('south korea')",
  'task not found',
  'partner does not have permission to operate shop',
  'verified_via_already_published_create_error',
  'brands: deduped',
  "'partner_public'",
  "'shop_access_token_fallback'",
  '`${app.partner_id}${path}${ts}`',
  '`${app.partner_id}${path}${shopTs}${t.access_token}${t.shop_id}`',
]) {
  assert(edge.includes(token), `missing upload helper/signing compatibility token: ${token}`);
}

const finalCatchStart = edge.lastIndexOf('} catch (e: any) {');
assert(finalCatchStart >= 0, 'missing final catch block');
const finalCatch = edge.slice(finalCatchStart);
assert(finalCatch.includes("error: 'internal_error'"), 'client response must use sanitized internal_error');
assert(!/return\s+jsonResp\([\s\S]*stack/.test(finalCatch), 'client response must not include stack traces');

console.log('shopee-bridge image hardening static checks passed');
