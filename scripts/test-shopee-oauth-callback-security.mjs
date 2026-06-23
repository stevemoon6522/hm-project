import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bridge = readFileSync('supabase/functions/shopee-bridge/index.ts', 'utf8');
const relay = readFileSync('supabase/functions/shopee-oauth-relay/index.ts', 'utf8');

const publicActions = bridge.slice(
  bridge.indexOf('const PUBLIC_ACTIONS'),
  bridge.indexOf(']);', bridge.indexOf('const PUBLIC_ACTIONS')) + 3,
);
assert.match(publicActions, /"oauth_callback"/, 'signed Shopee OAuth callback must be public so Shopee can redirect into it');
assert.doesNotMatch(publicActions, /"oauth_exchange"/, 'manual OAuth exchange must remain behind the auth/internal bridge gate');

assert.match(
  bridge,
  /function shopeeOAuthCallbackBase[\s\S]*account_key[\s\S]*main_account_id[\s\S]*shop_id/,
  'OAuth callback signature must cover account and principal fields',
);

assert.match(
  bridge,
  /const SHOPEE_OAUTH_CALLBACK_TTL_SEC = 30 \* 60/,
  'Shopee OAuth callback signature should stay valid long enough for slower seller approval',
);

assert.match(
  bridge,
  /async function verifyShopeeOAuthCallbackSignature[\s\S]*oauth_callback_sig_required[\s\S]*oauth_callback_expired[\s\S]*oauth_callback_sig_invalid/,
  'OAuth callback must reject missing, expired, and invalid signatures',
);

assert.match(
  bridge,
  /if \(action === 'oauth_callback'\)[\s\S]*verifyShopeeOAuthCallbackSignature[\s\S]*exchangeShopeeOAuthCode/,
  'public OAuth callback must verify the callback signature before exchanging the code',
);

assert.match(
  bridge,
  /if \(action === 'oauth_url'\)[\s\S]*\/api\/v2\/shop\/auth_partner[\s\S]*callbackMode[\s\S]*buildShopeeOAuthCallbackRedirect[\s\S]*buildShopeeOAuthRelayRedirect/,
  'oauth_url must generate documented shop/auth_partner URLs and use the registered-domain relay for callback mode',
);

assert.doesNotMatch(
  bridge,
  /\/api\/v2\/merchant\/auth_partner/,
  'Shopee does not expose merchant/auth_partner; main-account authorization still uses shop/auth_partner',
);

assert.match(
  bridge,
  /async function exchangeShopeeOAuthCode[\s\S]*\/api\/v2\/auth\/token\/get[\s\S]*region: '_MERCHANT'[\s\S]*shop_id_list/,
  'OAuth exchange must persist merchant and shop token rows from the Shopee code response',
);

assert.match(
  bridge,
  /function sanitizedShopeeOAuthTokenResponse[\s\S]*access_token[\s\S]*refresh_token[\s\S]*access_token_set[\s\S]*refresh_token_set/,
  'OAuth callback responses must not expose raw Shopee access or refresh tokens',
);

assert.match(
  relay,
  /ALLOWED_TARGET_HOSTS[\s\S]*mgqlwgnmwegzsjelbrih\.supabase\.co[\s\S]*ALLOWED_TARGET_PATH[\s\S]*\/functions\/v1\/shopee-bridge\/oauth_callback/,
  'OAuth relay must restrict callback forwarding to the dashboard bridge callback only',
);

assert.match(
  relay,
  /FORWARDED_QUERY_KEYS[\s\S]*code[\s\S]*shop_id[\s\S]*main_account_id[\s\S]*request_id/,
  'OAuth relay must forward Shopee callback identity fields to the signed dashboard callback',
);

console.log('Shopee OAuth callback security assertions passed');
