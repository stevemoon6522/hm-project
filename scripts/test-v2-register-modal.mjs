import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2/index.html'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(html.includes('id="register-modal"'), 'registration modal is missing');
assert(html.includes('id="region-fields"'), 'region row editor is missing');
assert(html.includes('id="result-body"'), 'row-level result table is missing');
assert(html.includes('/register_cbsc'), 'modal must call existing shopee-bridge register_cbsc path');
assert(html.includes("db.from('product_shopee_listings').upsert"), 'successful mappings must upsert product_shopee_listings');
assert(html.includes('shop_item_id'), 'mapping must persist shop_item_id');
assert(html.includes('shop_model_id'), 'mapping must persist shop_model_id when available');
assert(html.includes('shop_id'), 'mapping must persist shop_id when available');
assert(html.includes('global_item_id'), 'mapping must persist global_item_id');
assert(html.includes('global_model_id'), 'mapping must persist global_model_id when available');
assert(html.includes('fetchShopModels'), 'variant mappings must resolve shop model ids');
assert(html.includes('fetchGlobalModels'), 'variant mappings must resolve global model ids');
assert(!/repricing tab/i.test(html), 'registration modal check must not assert or depend on a repricing tab');

const requiredIds = [
  'field-name',
  'field-sku',
  'field-category',
  'field-price',
  'field-stock',
  'field-weight',
  'field-description',
];
for (const id of requiredIds) {
  assert(html.includes(`id="${id}"`), `${id} required field is missing`);
  assert(html.includes(`data-error-for="${id}"`), `${id} validation message is missing`);
}

console.log('v2 register modal static checks passed');
