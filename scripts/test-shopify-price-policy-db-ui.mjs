import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

const migration = read('supabase', 'migrations', '202606280001_shopify_price_policy.sql');
const adapter = read('supabase', 'functions', 'platform-publish', 'adapters', 'shopify.ts');
const html = read('v2', 'index.html');

assert.match(migration, /create table if not exists public\.shopify_price_policy/, 'Shopify price policy table must exist');
assert.match(migration, /krw_per_usd numeric not null default 1460/, 'Shopify policy must seed KRW/USD 1460');
assert.match(migration, /target_margin_pct numeric not null default 30/, 'Shopify policy must seed target margin 30%');
assert.match(migration, /payment_fee_pct numeric not null default 1/, 'Shopify policy must seed payment fee 1%');
assert.match(migration, /transaction_fee_pct numeric not null default 10/, 'Shopify policy must seed transaction fee 10%');
assert.match(migration, /include_shipping_in_price boolean not null default false/, 'Shopify policy must keep shipping out of product price by default');
assert.match(migration, /default_status text not null default 'ACTIVE'/, 'Shopify policy must default new products to ACTIVE');
assert.match(migration, /set_inventory boolean not null default false/, 'Shopify policy must keep inventory push disabled by default');
assert.match(migration, /create policy "shopify_price_policy public read"/, 'Shopify policy must be readable by the V2 app');
assert.match(migration, /create policy "shopify_price_policy authenticated write"/, 'Shopify policy writes must require authenticated users');

assert.match(adapter, /import \{ createClient \} from 'https:\/\/esm\.sh\/@supabase\/supabase-js@2\.45\.4'/, 'Shopify adapter must be able to read DB policy with service role');
assert.match(adapter, /const SHOPIFY_DEFAULT_PRICE_POLICY = Object\.freeze/, 'Shopify adapter must keep approved defaults as fallback only');
assert.match(adapter, /async function loadShopifyPricePolicy/, 'Shopify adapter must load price policy from DB');
assert.match(adapter, /\.from\('shopify_price_policy'\)/, 'Shopify adapter must query shopify_price_policy');
assert.match(adapter, /shopifyPricePolicyPromise/, 'Shopify adapter must cache policy reads per Edge Function instance');
assert.match(adapter, /function normalizeShopifyPricePolicy/, 'Shopify adapter must normalize DB fields into adapter policy fields');
assert.match(adapter, /async function buildShopifyPayload/, 'Shopify payload build must be async so DB policy is used before pricing');
assert.match(adapter, /const policy = await loadShopifyPricePolicy\(\)/, 'Shopify payload must load the DB policy');
assert.match(adapter, /priceFrom\(row, shopify, policy\)/, 'Shopify variant price must use the loaded policy');
assert.match(adapter, /shopifyProductStatus\(shopify, policy\)/, 'Shopify status default must use the loaded policy');
assert.match(adapter, /set_inventory:\s*shopify\.set_inventory === true && policy\.setInventory === true/, 'Shopify inventory push must be gated by DB policy');
assert.match(adapter, /pricing_policy:\s*policy/, 'Shopify dry-run payload must report the policy actually used');
assert.doesNotMatch(adapter, /SHOPIFY_USD_PRICE_POLICY/, 'Hardcoded Shopify USD policy name must be retired from create path');

assert.match(html, /id="shopify-price-policy-panel"/, 'V2 fee settings must include a Shopify policy panel');
assert.match(html, /SHOPIFY_PRICE_POLICY_DEFAULTS/, 'V2 must define Shopify policy UI defaults');
assert.match(html, /async function shopifyPolicyLoad/, 'V2 must load Shopify policy from Supabase');
assert.match(html, /\.from\('shopify_price_policy'\)/, 'V2 must read/write the Shopify policy table');
assert.match(html, /async function shopifyPolicySave/, 'V2 must save Shopify policy edits');
assert.match(html, /data-shopify-policy-key=/, 'V2 UI renderer must attach Shopify policy data keys');
for (const key of [
  'krw_per_usd',
  'target_margin_pct',
  'payment_fee_pct',
  'transaction_fee_pct',
  'include_shipping_in_price',
  'default_status',
  'set_inventory',
]) {
  assert.match(html, new RegExp(`key: '${key}'`), `V2 UI must expose ${key}`);
}

console.log('Shopify price policy DB/UI checks passed');
