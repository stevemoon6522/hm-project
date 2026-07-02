import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const repairScriptPath = join(root, 'scripts', 'repair-master-detail-images-from-staronemall.mjs');

function extractFunctionBlock(source, functionName) {
  let start = source.indexOf(`function ${functionName}(`);
  assert(start >= 0, `${functionName} must exist`);
  const asyncStart = start - 'async '.length;
  if (asyncStart >= 0 && source.slice(asyncStart, start) === 'async ') start = asyncStart;
  const paramsEnd = source.indexOf(')', start);
  assert(paramsEnd > start, `${functionName} must close its parameter list`);
  const open = source.indexOf('{', paramsEnd);
  assert(open > start, `${functionName} must have a body`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${functionName} body must close`);
}

const ebayDraftFn = extractFunctionBlock(html, 'mrBuildEbayDraft');
const ensureCallIndex = ebayDraftFn.indexOf('await mrEnsureEbaySourceImages(group);');
const representativeIndex = ebayDraftFn.indexOf('const representativeImageUrl = mrEbayRepresentativeImageUrl(group, sourceRow);');
assert(
  ensureCallIndex >= 0 && representativeIndex >= 0 && ensureCallIndex < representativeIndex,
  'eBay draft creation must backfill missing source detail images before building the default image list',
);

const ensureFn = extractFunctionBlock(html, 'mrEnsureEbaySourceImages');
assert(
  ensureFn.includes('mrJoomSourceUrl(group)')
    && ensureFn.includes('mrJoomFetchSourceImages(group)')
    && ensureFn.includes('mrJoomApplyObservedImages(group, nextObserved)'),
  'eBay source image backfill must reuse the existing StarOneMall observed-image helpers',
);
assert(
  ensureFn.includes('firstRow._extra_images')
    && ensureFn.includes('firstRow.extra_images')
    && ensureFn.includes('firstRow._detail_image_urls')
    && ensureFn.includes('observed.detail_image_urls')
    && ensureFn.includes('hasDetail || !sourceUrl'),
  'eBay source image backfill must fetch only when all local detail-image candidates are missing',
);

const ebayImageUrlsFn = extractFunctionBlock(html, 'mrEbayImageUrls');
assert(
  ebayImageUrlsFn.includes('row?._extra_images')
    && ebayImageUrlsFn.includes('row?.extra_images')
    && ebayImageUrlsFn.includes('row?._detail_image_urls')
    && ebayImageUrlsFn.includes('row?.observed?.detail_image_urls')
    && !ebayImageUrlsFn.includes('mrEbayActiveRows(group).map'),
  'eBay image list must use master/detail image candidates and avoid variant option images as detail photos',
);

assert(
  !html.includes('row._extra_images = [];'),
  'option image upload must not clear master detail-image candidates',
);

assert(existsSync(repairScriptPath), 'StarOneMall detail image repair dry-run script must exist');
const repairScript = readFileSync(repairScriptPath, 'utf8');
assert(
  repairScript.includes('DEFAULT_GROUP_ID')
    && repairScript.includes('--apply')
    && repairScript.includes('--confirm')
    && repairScript.includes('dry_run')
    && repairScript.includes('write_to_source_records: false'),
  'repair script must default to dry-run and require --apply plus --confirm before DB writes',
);

console.log('v2 eBay detail image source backfill checks passed');
