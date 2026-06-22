import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(process.cwd(), 'v2', 'index.html'), 'utf8');

function extractFunctionBlock(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `${functionName} must exist`);
  const open = source.indexOf('{', start);
  assert.ok(open > start, `${functionName} must have a body`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${functionName} body must close`);
}

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing end marker after ${start}`);
  return source.slice(from, to);
}

test('price sync catalog sorts newest products first', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${extractFunctionBlock(html, 'catProductCreatedTime')}\n${extractFunctionBlock(html, 'catSortProducts')}\nthis.catSortProducts = catSortProducts;`,
    context,
  );

  const sorted = context.catSortProducts([
    { id: 'older-ready', lifecycle_state: 'ready_stock', cost_updated_at: '2099-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
    { id: 'newer-pre', lifecycle_state: 'pre_order', cost_updated_at: null, created_at: '2026-05-01T00:00:00Z' },
    { id: 'newest-null', lifecycle_state: null, cost_updated_at: '2020-01-01T00:00:00Z', created_at: '2026-06-01T00:00:00Z' },
  ]);

  assert.deepEqual(
    sorted.map((row) => row.id),
    ['newest-null', 'newer-pre', 'older-ready'],
    'price sync view should prioritize created_at DESC over lifecycle or stale-cost queues',
  );
  assert.match(html, /\/rest\/v1\/products[\s\S]*&order=created_at\.desc/, 'product fetch should request newest rows first');
  assert.doesNotMatch(html, /order=lifecycle_state\.asc,cost_updated_at\.asc\.nullsfirst/, 'price sync fetch should not use stale-cost ordering');
});

test('price sync groups start collapsed when entering from tab or platform edit flow', () => {
  const pendingSelection = sliceBetween(html, 'function catApplyPendingSelection() {', '  /** Inject/update region column headers');
  assert.match(pendingSelection, /state\.priceSyncExpandedGroups\.clear\(\);/, 'pending preselection must leave option groups collapsed');
  assert.doesNotMatch(pendingSelection, /priceSyncExpandedGroups\.add\(group\.key\)/, 'pending preselection must not auto-expand selected groups');

  const showViewCatalogPatch = sliceBetween(html, 'function patchShowViewCatalog() {', '  }());');
  assert.match(
    showViewCatalogPatch,
    /if \(viewId === 'view-price-sync'\) \{\s*state\.priceSyncExpandedGroups\.clear\(\);\s*renderCatalogView\(false\);\s*\}/,
    'entering the price sync tab should reset remembered expanded groups before rendering',
  );
});
