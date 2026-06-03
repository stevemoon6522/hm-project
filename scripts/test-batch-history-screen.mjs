import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const token of [
  'data-tab="batch-history"',
  'id="tab-batch-history"',
  'id="bh-from"',
  'id="bh-to"',
  'id="bh-platform"',
  'id="bh-status"',
  'id="bh-keyword"',
  'id="bh-refresh"',
  'id="bh-tbody"',
  'id="bh-detail"',
  'function loadBatchHistory()',
  "from('shopee_mutation_log')",
  'function bhBuildBatches(rows)',
  'function bhOperationStatus(items)',
]) {
  assert(html.includes(token), `missing batch history token: ${token}`);
}

assert(html.includes("tab === 'batch-history'"), 'batch-history tab switch handler missing');
assert(html.includes('bhRenderRows(batchHistoryState.rows, bhReadFilters())'), 'filter re-render handler missing');

console.log('batch history screen static checks passed');
