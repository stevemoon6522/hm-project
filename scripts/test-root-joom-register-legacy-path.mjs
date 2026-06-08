import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
const html = readFileSync(join(root, 'index.html'), 'utf8');

const start = html.indexOf('function openJoomModal(row)');
const end = html.indexOf('async function _joomDeleteRow(row)', start);
assert(start >= 0 && end > start, 'legacy Joom modal/publish block must exist');
const block = html.slice(start, end);
const bodyStart = block.indexOf('const body = {');
const bodyEnd = block.indexOf("status.textContent = '2/2", bodyStart);
assert(bodyStart >= 0 && bodyEnd > bodyStart, 'legacy Joom publish body block must exist');
const bodyBlock = block.slice(bodyStart, bodyEnd);

assert(
  html.includes("const JOOM_MUSIC_ALBUMS_CATEGORY_ID = '1567805338802406105-13-2-26202-1432821636'"),
  'legacy Joom modal should hard-default to the Music Albums Joom category ID',
);
assert(
  html.includes('function _joomCanonicalProductName(row, artist = \'\', album = \'\')'),
  'legacy Joom publish should build a canonical master product title',
);
assert(
  block.includes("document.getElementById('jm-category-search').value = 'Music Albums'") &&
    block.includes("document.getElementById('jm-category').value = JOOM_MUSIC_ALBUMS_CATEGORY_ID"),
  'legacy Joom modal should preselect Music Albums',
);
assert(
  block.includes('const masterName = _joomCanonicalProductName(row, artist, album);') &&
    block.includes('name: masterName,'),
  'legacy Joom payload should send the full master product title to the bridge',
);
assert(
  block.includes('const detailImages = _joomDetailImageSources(scrapedAssets);') &&
    block.includes('extraImages: [],') &&
    block.includes('detailImages,'),
  'legacy Joom payload should send detail image sources once and let the bridge square-convert them',
);
assert(
  bodyBlock.includes('scrapedAssets: normalizedScrapedAssets,') &&
    !bodyBlock.includes('    scrapedAssets,\n'),
  'legacy Joom payload should not pass raw scrapedAssets directly',
);

console.log('root legacy Joom register checks passed');
