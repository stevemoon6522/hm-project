import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../v2/index.html', import.meta.url), 'utf8');

function sliceBetween(source, start, end) {
  const s = source.indexOf(start);
  assert.ok(s >= 0, `missing start token: ${start}`);
  const e = source.indexOf(end, s);
  assert.ok(e > s, `missing end token after ${start}`);
  return source.slice(s, e);
}

const snapshotInput = sliceBetween(
  html,
  'function catBuildShopeePriceSnapshotInput(payload)',
  'async function catRecordPriceDryRunSnapshots(payloads, nowIso)',
);
const snapshotRpc = sliceBetween(
  html,
  'async function catRecordPriceDryRunSnapshots(payloads, nowIso)',
  'async function catExecuteDryRun(payloads)',
);
const dryRun = sliceBetween(
  html,
  'async function catExecuteDryRun(payloads)',
  'function catSelectedProducts()',
);

for (const token of [
  "platform: 'shopee'",
  "formula_key: 'v1_shopee_price_sync'",
  "rule_version: '2026-06-02'",
  "rounding_rule: region === 'BR' ? '2dp' : 'integer'",
  'previous_platform_price',
  'computed_platform_price: payload.price',
  'final_platform_price: payload.price',
  'remote_before',
  'request_payload: payload.payload',
]) {
  assert.ok(snapshotInput.includes(token), `snapshot input must include ${token}`);
}

assert.ok(!snapshotInput.includes('fetch('), 'snapshot input builder must not call marketplace/network APIs');

for (const token of [
  "db.rpc('record_price_dry_run_batch'",
  "p_actor: 'v2-catalog'",
  "p_platform_filter: ['shopee']",
  'p_summary_json',
  'p_snapshots: snapshots',
]) {
  assert.ok(snapshotRpc.includes(token), `snapshot RPC helper must include ${token}`);
}

assert.ok(!snapshotRpc.includes('update_price'), 'snapshot RPC helper must not call Shopee update_price');
assert.ok(!snapshotRpc.includes('/joom-bridge'), 'snapshot RPC helper must not call Joom bridge');
assert.match(
  dryRun,
  /const snapshotResult = await catRecordPriceDryRunSnapshots\(payloads, now\);[\s\S]*for \(const p of payloads\)/,
  'dry-run must record price snapshots before per-row cost persistence loop',
);
assert.ok(dryRun.includes('snapshotResult.count'), 'dry-run success toast must include recorded snapshot count');

console.log('v2 price snapshot dry-run UI checks passed');
