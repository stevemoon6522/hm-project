import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(process.cwd(), 'v2', 'index.html'), 'utf8');

function sliceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start token: ${start}`);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(endIndex > startIndex, `missing end token after ${start}`);
  return source.slice(startIndex, endIndex);
}

const platformRender = sliceBetween(
  html,
  'function renderPlatformWorkbench(platform) {',
  'function renderPlatformWorkbenches() {',
);

const platformBinding = sliceBetween(
  html,
  'function bindPlatformWorkbench(root, platform) {',
  'function platformGroupsByKeys(keys) {',
);

test('platform tab search keeps the search input mounted while refreshing filtered content', () => {
  assert.match(
    html,
    /function platformRefreshSearchResults\(root, platform\) \{/,
    'platform search should refresh filtered table/actions without rebuilding the whole tab',
  );
  assert.match(
    html,
    /function bindPlatformToolbarControls\(root, platform\) \{/,
    'toolbar action bindings should be reusable after partial refresh',
  );
  assert.match(
    html,
    /function bindPlatformTableControls\(root, platform\) \{/,
    'table row bindings should be reusable after partial refresh',
  );
  assert.match(
    platformRender,
    /data-platform-actions/,
    'platform toolbar actions should have a stable replacement target',
  );

  const searchHandler = sliceBetween(
    platformBinding,
    "root.querySelector('[data-platform-search]')?.addEventListener('input'",
    "root.querySelector('[data-platform-lifecycle]')?.addEventListener('change'",
  );
  assert.match(
    searchHandler,
    /platformRefreshSearchResults\(root, platform\)/,
    'typing in platform search should update only filtered content',
  );
  assert.doesNotMatch(
    searchHandler,
    /renderPlatformWorkbench\(platform\)/,
    'typing in platform search must not replace the search input node',
  );
});

test('Joom remote cleanup search keeps its search input mounted while filtering remote options', () => {
  assert.match(
    html,
    /function joomRemoteCleanupRefreshSearchResults\(root\) \{/,
    'Joom remote cleanup search should have a partial refresh helper',
  );
  assert.match(
    html,
    /data-joom-remote-count/,
    'Joom remote cleanup filtered count should have a stable update target',
  );

  const joomSearchHandler = sliceBetween(
    platformBinding,
    "root.querySelector('[data-joom-remote-search]')?.addEventListener('input'",
    "root.querySelector('[data-joom-remote-select]')?.addEventListener('change'",
  );
  assert.match(
    joomSearchHandler,
    /joomRemoteCleanupRefreshSearchResults\(root\)/,
    'typing in Joom remote cleanup search should filter options in place',
  );
  assert.doesNotMatch(
    joomSearchHandler,
    /renderPlatformWorkbench\('joom'\)/,
    'typing in Joom remote cleanup search must not rebuild the modal containing the input',
  );
});
