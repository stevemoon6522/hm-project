import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const html = readFileSync(join(root, 'v2/index.html'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const requiredTokens = [
  'id="register-modal"',
  'id="field-retail-price"',
  'id="field-purchase-cost"',
  'id="field-member-count"',
  'id="field-bundle-albums"',
  'id="field-bundle-cards"',
  'id="field-bundle-set-price"',
  'calculateModalBundleSetPrice',
  'readModalBundlePricing',
  'syncModalBundlePricing',
  'bindLegacyModalBundlePricing',
];

for (const token of requiredTokens) {
  assert(html.includes(token), `missing modal bundle token: ${token}`);
}

const parseStart = html.indexOf('function parseRegisterBundleNumber');
const parseEnd = html.indexOf('function setStatus', parseStart);
assert(parseStart >= 0 && parseEnd > parseStart, 'failed to isolate parse/calc helpers');

const modalStart = html.indexOf('function calculateModalBundleSetPrice');
const modalEnd = html.indexOf('function openModal', modalStart);
assert(modalStart >= 0 && modalEnd > modalStart, 'failed to isolate modal bundle calculator');

const source = `${html.slice(parseStart, parseEnd)}\n${html.slice(modalStart, modalEnd)}`;
const context = {};
vm.runInNewContext(`
${source}
globalThis.exampleA = calculateModalBundleSetPrice(21200, 5000, 5, 4, 5);
globalThis.exampleB = calculateModalBundleSetPrice(19800, 6000, 5, 3, 4);
globalThis.defaultRatio = calculateModalBundleSetPrice('15,800', '10,400', '5', '', '');
`, context);

assert(context.exampleA === 64800, `Example A mismatch: ${context.exampleA}`);
assert(context.exampleB === 51750, `Example B mismatch: ${context.exampleB}`);
assert(context.defaultRatio === 27000, `Default ratio mismatch: ${context.defaultRatio}`);

console.log('v2 register modal bundle pricing checks passed');
