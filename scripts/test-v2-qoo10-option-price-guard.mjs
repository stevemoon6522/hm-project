import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');

function extractFunctionBlock(source, functionName) {
  let start = source.indexOf(`function ${functionName}(`);
  assert(start >= 0, `${functionName} must exist`);
  const paramsEnd = source.indexOf(')', start);
  const open = source.indexOf('{', paramsEnd);
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

const baseFn = extractFunctionBlock(html, 'mrQoo10BasePriceFromRows');
assert.match(baseFn, /Math\.max\(\.\.\.prices\)/, 'Qoo10 modal must default grouped base price to the highest option target');
assert.doesNotMatch(baseFn, /Math\.min\(\.\.\.prices\)/, 'Qoo10 modal must not default grouped base price to the lowest option target');

const clampFn = extractFunctionBlock(html, 'mrQoo10ClampOptionPriceForBase');
assert.match(clampFn, /Math\.ceil\(normalizedBase \* 0\.5\)/, 'Qoo10 modal must enforce the -50% option delta floor');
assert.match(clampFn, /Math\.floor\(normalizedBase \* 2\)/, 'Qoo10 modal must enforce the +100% option delta ceiling');

const renderFn = extractFunctionBlock(html, 'mrQoo10RenderOptions');
assert.match(renderFn, /mrQoo10ClampOptionPriceForBase\(defaultPrice,\s*basePrice\)/, 'Qoo10 modal option table must show clamped option prices');

const payloadFn = extractFunctionBlock(html, 'mrQoo10ReadPayload');
assert.match(payloadFn, /mrQoo10ClampOptionPriceForBase\(mrQoo10ReadNumber\(`mr-qoo10-price-\$\{idx\}`,\s*basePrice\),\s*basePrice\)/, 'Qoo10 publish payload must clamp edited option prices before bridge calls');

console.log('v2 Qoo10 option price guard checks passed');
