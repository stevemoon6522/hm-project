import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const html = read('v2/index.html');
const migration = read('supabase/migrations/202606160001_shopee_account_profiles.sql');
const credentialMigration = read('supabase/migrations/202606160002_shopee_account_credentials.sql');
const bridge = read('supabase/functions/shopee-bridge/index.ts');
const adapter = read('supabase/functions/platform-publish/adapters/shopee.ts');
const platformPublish = read('supabase/functions/platform-publish/index.ts');
const orders = read('supabase/functions/shopee-orders/index.ts');
const skuChange = read('supabase/functions/_shared/shopee-sku-change-api.ts');
const sheetsSync = read('supabase/functions/sheets-sync/index.ts');

assert(migration.includes('create table if not exists public.shopee_account_profiles'), 'migration creates Shopee account profiles');
assert(migration.includes('primary key (account_key, region)'), 'shopee_tokens primary key is account-aware');
assert(migration.includes('primary key (product_id, account_key, region)'), 'product_shopee_listings primary key is account-aware');
assert(migration.includes("coalesce(psl.account_key, 'starphotocard') || ':' || coalesce(psl.region"), 'rollup detail keys include account_key');
assert(credentialMigration.includes('create table if not exists public.shopee_account_credentials'), 'migration creates private Shopee credential table');
assert(credentialMigration.includes('partner_key_secret_name'), 'credential migration stores partner key secret names');
assert(credentialMigration.includes('revoke all on public.shopee_account_credentials from anon, authenticated'), 'credential table is not public-readable');

assert(html.includes("const SHOPEE_DEFAULT_ACCOUNT_KEY = 'starphotocard'"), 'V2 has a default Shopee account key');
assert(html.includes("id=\"rsh-account-key\""), 'Shopee registration modal exposes account selector');
assert(html.includes('sdLoadShopeeAccountProfiles'), 'V2 loads Shopee account profiles');
assert(html.includes('sdShopeeLayerUrl(accountKey)'), 'V2 layer compositing resolves layer by selected account');
assert(html.includes('account_key: accountKey'), 'V2 sends selected account_key in registration payloads');
assert(html.includes("const SHOPEE_LISTING_CONFLICT = 'product_id,account_key,region'"), 'V2 upserts listing rows with account-aware conflict key');
assert(html.includes("applyShopLayer(productImageUrl)"), 'legacy applyShopLayer signature remains available');

assert(bridge.includes('const DEFAULT_SHOPEE_ACCOUNT_KEY = "starphotocard"'), 'bridge defines default Shopee account key');
assert(bridge.includes('getShopeeAccountProfile'), 'bridge can load Shopee account profile metadata');
assert(bridge.includes('getAccountCredential'), 'bridge can load account-specific Shopee app credentials');
assert(bridge.includes('Shopee credential missing for account='), 'bridge does not silently reuse default credentials for non-default accounts');
assert(bridge.includes("if (action === 'account_profile' && req.method === 'POST')"), 'bridge exposes gated account profile setup endpoint');
assert(bridge.includes(".eq('account_key', accountKey).eq('region', region)"), 'bridge token reads are account-scoped');
assert(bridge.includes('body.account_key = accountKey'), 'bridge normalizes request account_key');
assert(bridge.includes("upsert(profilePayload, { onConflict: 'account_key' })"), 'bridge oauth_exchange upserts account profiles');
assert(bridge.includes("upsert({\r\n            account_key: accountKey") || bridge.includes("upsert({\n            account_key: accountKey"), 'bridge OAuth token rows include account_key');

assert(adapter.includes("const SHOPEE_LISTING_CONFLICT = 'product_id,account_key,region'"), 'Shopee adapter uses account-aware listing conflict');
assert(adapter.includes('account_key,'), 'Shopee adapter includes account_key in upsert payloads');
assert(adapter.includes('const bridgeBody: Record<string, unknown> = {') && adapter.includes('    account_key,'), 'Shopee adapter forwards account_key to shopee-bridge');
assert(platformPublish.includes('account_key:'), 'platform-publish dispatcher passes account_key to adapters');

assert(orders.includes('const DEFAULT_SHOPEE_ACCOUNT_KEY = "starphotocard"'), 'orders function pins legacy flow to default account');
assert(orders.includes('.eq("account_key", DEFAULT_SHOPEE_ACCOUNT_KEY)'), 'orders token/shop queries are default-account scoped');
assert(skuChange.includes('const DEFAULT_SHOPEE_ACCOUNT_KEY = "starphotocard"'), 'sku-change helper pins legacy flow to default account');
assert(skuChange.includes('.eq("account_key", DEFAULT_SHOPEE_ACCOUNT_KEY)'), 'sku-change token/shop queries are default-account scoped');
assert(sheetsSync.includes('product_shopee_listings: ["product_id", "account_key", "region"]'), 'sheets-sync primary key matches account-aware listing schema');

console.log('Shopee account-aware listing static checks passed.');
