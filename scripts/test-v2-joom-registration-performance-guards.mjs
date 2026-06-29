import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert(start >= 0, `missing function ${name}`);
  const paramsEnd = source.indexOf(')', start);
  assert(paramsEnd > start, `missing function parameters for ${name}`);
  const open = source.indexOf('{', paramsEnd);
  assert(open > paramsEnd, `missing function body for ${name}`);
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

const openDraft = extractFunction(html, 'mrOpenJoomModalDraft');
const buildPayload = extractFunction(html, 'mrBuildJoomPayload');

assert(
  openDraft.includes('const sourceImagesPromise = mrEnsureJoomSourceImages(group);')
    && openDraft.includes('const brandOptionsPromise = mrLoadJoomBrandOptions(group);')
    && openDraft.includes('const countryPromise = _v2LoadJoomCountry();')
    && openDraft.includes('await Promise.all(['),
  'Joom modal opening must start source-image hydration, brand options, and country settings in parallel',
);

assert(
  openDraft.indexOf('mrApplyPreferredJoomBrand(group);') > openDraft.indexOf('await Promise.all(['),
  'Joom preferred-brand selection must run after account brand options finish loading',
);

assert(
  buildPayload.includes(': draft.extraImages.slice();'),
  'Joom payload should reuse the already-computed draft detail images instead of reloading detail images',
);

assert(
  !buildPayload.includes('detailImages = await mrJoomLoadDetailImages(group)'),
  'Joom payload should not perform a second detail-image load after draft construction',
);

console.log('v2 Joom registration performance guards passed');
