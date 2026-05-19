import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const html = readFileSync(join(root, 'v2/index.html'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const requiredTokens = [
  'id="w-retail-price"',
  'id="w-purchase-cost"',
  'id="w-member-count"',
  'id="w-bundle-albums"',
  'id="w-bundle-cards"',
  'id="w-bundle-set-price"',
  'calculateRegisterBundleSetPrice',
  'syncRegisterBundlePricing',
  'registerCurrentSetPrice',
  'bundle_pricing: readRegisterBundlePricing()',
  'cost_krw: baseCostKrw',
  'cost_krw: Math.round(Number(variant.originalPrice',
  'cost_krw: Math.round(Number(row.cost_krw',
];

for (const token of requiredTokens) {
  assert(html.includes(token), `bundle pricing token missing: ${token}`);
}

assert(
  html.includes('purchase_cost is operator-owned. Bundle changes only the multiplier.'),
  'purchase_cost must be documented as fixed manual input',
);

const start = html.indexOf('function parseRegisterBundleNumber');
const end = html.indexOf('function readRegisterBundlePricing', start);
assert(start >= 0 && end > start, 'could not isolate bundle pricing pure functions');

const pureFunctionSource = html.slice(start, end);
const context = {};
vm.runInNewContext(`
${pureFunctionSource}
globalThis.exampleA = calculateRegisterBundleSetPrice(21200, 5000, 5, 4, 5);
globalThis.exampleB = calculateRegisterBundleSetPrice(19800, 6000, 5, 3, 4);
globalThis.defaultRatio = calculateRegisterBundleSetPrice('15,800', '10,400', '5', '', '');
`, context);

assert(context.exampleA === 64800, `Example A expected 64800, got ${context.exampleA}`);
assert(context.exampleB === 51750, `Example B expected 51750, got ${context.exampleB}`);
assert(context.defaultRatio === 27000, `Default ratio expected 27000, got ${context.defaultRatio}`);

console.log('v2 register bundle pricing checks passed');
