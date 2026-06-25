import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridge = fs.readFileSync(new URL('../supabase/functions/joom-bridge/index.ts', import.meta.url), 'utf8');
const edgeBridge = fs.readFileSync(new URL('../edge-functions/joom-bridge/index.ts', import.meta.url), 'utf8');

for (const [label, source] of [['supabase', bridge], ['edge mirror', edgeBridge]]) {
  assert.match(source, /const JOOM_MAX_EXTRA_IMAGES = 20/, `${label} must retain the official Joom extraImages cap`);
  assert.match(source, /const JOOM_IMAGE_DIMENSION_PROBE_BYTES = 1024 \* 1024/, `${label} must probe enough bytes to find late JPEG SOF markers before falling back`);
  assert.match(source, /const JOOM_CLOUDINARY_TILE_CONTENT_CHECK_LIMIT = 3/, `${label} must bound Cloudinary tile content checks`);
  assert.match(source, /function isTrustedStoredProductImageUrl/, `${label} must recognize already-stored product image URLs`);
  assert.match(source, /skipContentCheck/, `${label} must skip expensive tile decode checks for trusted stored product images`);
  assert.match(source, /async function processDetailImage\(imageUrl: string, maxTiles = JOOM_MAX_EXTRA_IMAGES\)/, `${label} processDetailImage must accept remaining tile budget`);
  assert.match(source, /const remainingTiles = Math\.max\(0, Math\.min\(JOOM_MAX_EXTRA_IMAGES, Math\.floor\(Number\(maxTiles\)/, `${label} must clamp remaining tile budget`);
  assert.match(source, /buildCloudinaryFetchTiles\(imageUrl, dims\)\)\.slice\(0, remainingTiles\)/, `${label} must not generate more Cloudinary tile URLs than the remaining Joom slots`);
  assert.match(source, /buildCloudinaryUnknownSquare\(imageUrl\)\)\.slice\(0, remainingTiles\)/, `${label} unknown-dimension fallback must also respect remaining slots`);
  assert.match(source, /`bytes=0-\$\{JOOM_IMAGE_DIMENSION_PROBE_BYTES - 1\}`/, `${label} dimension reader must use the shared large probe limit`);
  assert.match(source, /c_pad,b_white,w_1500,h_1500\/f_jpg,q_90/, `${label} unknown-dimension fallback must emit a valid Cloudinary fetch transformation chain`);
  assert.doesNotMatch(source, /c_pad,b_white,w_1500,h_1500,f_jpg,q_90/, `${label} unknown-dimension fallback must not merge resize and format transforms into one invalid component`);
  assert.match(source, /if \(!resp\.ok\) \{\s*console\.warn\("\[joom-bridge\] Cloudinary tile fetch failed:"/, `${label} must treat Cloudinary HTTP failures as invalid tiles`);
  assert.match(source, /return false;\s*\}\s*const bytes = new Uint8Array\(await resp\.arrayBuffer\(\)\);/, `${label} must reject non-OK Cloudinary tiles before decode`);
  assert.doesNotMatch(source, /all Cloudinary tiles were mostly blank; skipping source image:[\s\S]{0,160}return \[\];/, `${label} must fall back to local square-tile generation when Cloudinary fetch URLs fail`);
  assert.doesNotMatch(source, /Cloudinary unknown-square tile was mostly blank; skipping source image:[\s\S]{0,160}return \[\];/, `${label} unknown-dimension fallback must still try local square-tile generation`);
  assert.match(source, /Math\.min\(Math\.ceil\(img\.height \/ tileSize\), 9, remainingTiles\)/, `${label} local tall-image fallback must respect remaining slots`);
  assert.match(source, /Math\.min\(Math\.ceil\(img\.width \/ tileSize\), 9, remainingTiles\)/, `${label} local wide-image fallback must respect remaining slots`);

  const calls = [...source.matchAll(/processDetailImage\(imageUrl(?:, JOOM_MAX_EXTRA_IMAGES - processedExtras\.length)?\)/g)]
    .map((match) => match[0]);
  assert.equal(
    calls.filter((call) => call.includes('JOOM_MAX_EXTRA_IMAGES - processedExtras.length')).length,
    2,
    `${label} recovery/update loops must pass the remaining extraImages budget`,
  );
  assert.match(source, /processDetailImage\(url, JOOM_MAX_EXTRA_IMAGES - processedExtras\.length\)/, `${label} publish/dryrun loop must pass the remaining extraImages budget`);
}

console.log('Joom detail image resource-limit regression checks passed');
