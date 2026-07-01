import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(source, token, label) {
  assert(source.includes(token), `${label} missing token: ${token}`);
}

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');
const bridge = readFileSync(join(root, 'supabase', 'functions', 'joom-bridge', 'index.ts'), 'utf8');
const edgeBridge = readFileSync(join(root, 'edge-functions', 'joom-bridge', 'index.ts'), 'utf8');
const openapi = readFileSync(join('C:', 'dev', 'api-refs', 'marketplaces', 'joom', 'openapi.yaml'), 'utf8');

for (const source of [bridge, edgeBridge]) {
  for (const token of [
    'function normalizeJoomRemoteProduct',
    'action === "products-list" && req.method === "GET"',
    'action === "product-info" && req.method === "GET"',
    '/products/multi?',
    '/products?id=',
    'target_type',
    'targetType',
    'POST /products/remove removes a product and all variants',
  ]) {
    assertIncludes(source, token, 'Joom bridge remote cleanup');
  }
}

for (const token of [
  'joomRemoteCleanup',
  'open: false',
  'function joomRemoteCleanupModalHtml',
  'data-joom-remote-open',
  'data-joom-remote-close',
  'joom-remote-cleanup-modal',
  'data-joom-remote-load',
  'data-joom-remote-search',
  'data-joom-remote-select',
  'data-joom-remote-master',
  'data-joom-remote-dryrun',
  'data-joom-remote-delete-reregister',
  'async function joomRemoteCleanupLoadProducts',
  'async function joomRemoteCleanupExecute',
  'async function joomRemoteCleanupPreflightCurrentSkus',
  'async function joomRemoteCleanupDryRunMaster',
  'async function joomRemoteCleanupDeleteSelectedRemoteProduct',
  'async function joomRemoteCleanupPublishMaster',
  'remote_cleanup_publish_failed_after_delete',
  'window.mrPrepareJoomHeadlessPublish',
  'window.mrPublishJoomGroupHeadless',
  'window.plBuildJoomPublishGroupFromProducts',
]) {
  assertIncludes(html, token, 'V2 Joom remote cleanup UI');
}

assert(
  !html.includes('const joomRemoteCleanupHtml = platform === \'joom\' ? joomRemoteCleanupPanelHtml() : \'\';'),
  'Joom remote cleanup must not render as a persistent top panel',
);
assert(
  !html.includes('${joomRemoteCleanupHtml}'),
  'Joom remote cleanup must not be inserted above the registration table',
);

const preflight = html.indexOf('await joomRemoteCleanupPreflightCurrentSkus');
const dryrun = html.indexOf('await joomRemoteCleanupDryRunMaster');
const del = html.indexOf('await joomRemoteCleanupDeleteSelectedRemoteProduct');
const publish = html.indexOf('await joomRemoteCleanupPublishMaster');
assert(preflight > 0, 'cleanup flow must preflight current SKUs');
assert(dryrun > preflight, 'cleanup flow must dry-run current master before delete');
assert(del > dryrun, 'cleanup flow must delete only after dry-run succeeds');
assert(publish > del, 'cleanup flow must publish only after delete succeeds');

for (const token of [
  "'/products/multi':",
  "'/products/remove':",
  'All product',
  'You will not be able to',
  'Do not',
  'temporarily disable products',
  'Variants with',
  'new SKUs will be created',
]) {
  assertIncludes(openapi, token, 'Official Joom OpenAPI rationale');
}

console.log('V2 Joom remote cleanup flow checks passed');
