import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2/index.html'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const token of [
  '일일 마감',
  'id="view-daily-close"',
  'id="dc-card-failed"',
  'id="dc-card-approval"',
  'id="dc-card-pricing"',
  'id="dc-card-drift"',
  'id="dc-card-priority"',
  'id="dc-updated"',
  'id="dc-priority-list"',
  '데이터 소스 미연결',
  'renderDailyClose',
  'initDailyCloseListeners',
]) {
  assert(html.includes(token), `daily close UI missing token: ${token}`);
}

assert(!html.includes("showView('view-daily-close')"), 'daily close must stay hidden from the primary sidebar navigation');

for (const mapping of [
  'dcFetchSummaryRpc',
  '/api/v2-daily-close-summary',
  "dcCount('shopee_mutation_log'",
  'actor=eq.v2-wizard&status=eq.error',
  'review/approval queue',
  'dcAnalyzePricing(products, listings)',
  'product_shopee_listings.last_synced_at',
  'products.lifecycle_state/cost_krw/weight_g/cost_updated_at',
  'margin_source_mode',
  'country_settings fee fields',
  'approval_source_mode',
  'mutation_log_approval_required',
  'failed_batch_raw_error_rows_count',
  'failed_batch_source_mode',
  'sync_drift_source_mode',
  'remote_aware_mutation_log_checkpoint',
]) {
  assert(html.includes(mapping), `daily close metric mapping missing: ${mapping}`);
}

assert(/dc-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(5/.test(html), 'daily close must show five metric cards on one desktop row');
assert(/\.dc-label[\s\S]*color:\s*#111827/.test(html), 'daily close labels must use high-contrast text');
assert(/\.dc-value[\s\S]*font-size:\s*34px/.test(html), 'daily close metric values must be visually prominent');

console.log('v2 daily close static checks passed');
