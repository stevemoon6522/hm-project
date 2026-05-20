import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');

assert(
  html.includes("const SHOPEE_MERCHANT = SHOPEE_BRIDGE;"),
  'Shopee registration catalog loader must use shopee-bridge, not a missing shopee-merchant function'
);

for (const token of [
  "SHOPEE_MERCHANT + '/global_categories'",
  "SHOPEE_MERCHANT + '/global_brands?category_id='",
  "catRefresh?.addEventListener('click'",
  "await _shopeeLoadCategories(true)",
  "{ code: 'BR', currency: 'BRL' }",
]) {
  assert(html.includes(token), `missing catalog loader token: ${token}`);
}

assert(
  !html.includes("'/functions/v1/shopee-merchant'"),
  'index.html must not reference the undeployed shopee-merchant Edge Function'
);

console.log('shopee registration catalog endpoint checks passed');
