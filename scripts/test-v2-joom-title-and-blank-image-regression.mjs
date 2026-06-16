import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert(start >= 0, `missing function ${name}`);
  const open = source.indexOf('{', start);
  assert(open > start, `missing function body for ${name}`);
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

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const bridge = readFileSync(join(root, 'supabase', 'functions', 'joom-bridge', 'index.ts'), 'utf8');
const edgeBridge = readFileSync(join(root, 'edge-functions', 'joom-bridge', 'index.ts'), 'utf8');
const adapter = readFileSync(join(root, 'supabase', 'functions', 'platform-publish', 'adapters', 'joom.ts'), 'utf8');
const sharedImages = readFileSync(join(root, 'supabase', 'functions', '_shared', 'staronemall-images.ts'), 'utf8');

const htmlTitleCaseSrc = extractFunction(html, 'mrJoomTitleCase');
const bridgeTitleCaseSrc = extractFunction(bridge, 'joomTitleCase').replace(/: string/g, '');
const adapterTitleCaseSrc = extractFunction(adapter, 'joomTitleCase').replace(/: string/g, '');

const htmlTitleCase = new Function(`${htmlTitleCaseSrc}; return mrJoomTitleCase;`)();
const bridgeTitleCase = new Function(`${bridgeTitleCaseSrc}; return joomTitleCase;`)();
const adapterTitleCase = new Function(`${adapterTitleCaseSrc}; return joomTitleCase;`)();

const sample = '[READY STOCK] ATEEZ OFFICIAL LIGHT STICK VER 3';
const expected = '[Ready Stock] Ateez Official Light Stick Ver 3';

assert(htmlTitleCase(sample) === expected, 'V2 Joom preview title must be title-cased');
assert(bridgeTitleCase(sample) === expected, 'Joom bridge final payload title must be title-cased');
assert(adapterTitleCase(sample) === expected, 'platform-publish Joom adapter title must be title-cased');

assert(bridge.includes('function isLikelyBlankImage'), 'Joom bridge must detect mostly white generated tiles');
assert(bridge.includes('async function filterLikelyBlankCloudinaryTiles'), 'Joom bridge must verify Cloudinary tiles before sending extraImages');
assert(bridge.includes('JOOM_EXTRA_IMAGE_TILE_SIZE = 1500'), 'Joom bridge must downscale generated square detail tiles');
assert(bridge.includes('/c_crop,w_${img.width},h_${h},x_0,y_${y}/c_pad'), 'Tall Cloudinary crops must be chained before square padding');
assert(!bridge.includes('c_crop,w_${img.width},h_${h},x_0,y_${y},c_pad'), 'Tall Cloudinary crops must not mix crop and pad in one transformation');
assert(bridge.includes('if (isLikelyBlankImage(square))'), 'Storage tile fallback must skip blank white tiles');
assert(edgeBridge.includes('function isLikelyBlankImage') && edgeBridge.includes('async function filterLikelyBlankCloudinaryTiles'), 'edge-functions Joom bridge mirror must include blank-tile filtering');

for (const marker of ['blank', 'spacer', 'transparent', 'pixel', 'empty']) {
  assert(sharedImages.includes(marker), `shared StarOneMall image URL filter should reject ${marker} assets`);
  assert(html.includes(marker), `V2 image URL filter should reject ${marker} assets`);
}

console.log('v2 Joom title-case and blank-image regression checks passed');
