import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const html = readFileSync(join(root, 'v2/index.html'), 'utf8');

function sliceBetween(source, start, end) {
  const s = source.indexOf(start);
  assert(s >= 0, `missing start token: ${start}`);
  const e = source.indexOf(end, s);
  assert(e > s, `missing end token after ${start}`);
  return source.slice(s, e);
}

const authPanel = sliceBetween(html, '<div id="auth-panel"', '<div id="app-shell"');
assert(authPanel.includes('<form id="login-form">'), 'v2 login fields must be inside a form');
assert(authPanel.includes('id="login-password" type="password"'), 'password field must remain present');
assert(authPanel.includes('id="login-submit" type="submit"'), 'sign-in button must submit the auth form');
assert(!authPanel.includes('id="login-github"'), 'disabled Supabase GitHub OAuth must not be exposed in the V2 login form');
assert(!html.includes("provider: 'github'"), 'V2 must not call Supabase GitHub OAuth while the provider is disabled');

const listenerBlock = sliceBetween(html, 'if (els.loginForm)', 'if (els.logout)');
assert(listenerBlock.includes("addEventListener('submit'"), 'login form submit handler is missing');
assert(listenerBlock.includes('e.preventDefault()'), 'login form submit must prevent page reload');
assert(listenerBlock.includes('signIn()'), 'login form submit must call signIn');

assert(html.includes('function isAuthenticatedSession(session)'), 'V2 auth bootstrap must validate a real authenticated Supabase session');
assert.match(html, /function applySession\(session\)[\s\S]*const authenticated = isAuthenticatedSession\(session\)[\s\S]*SUPABASE_ANON[\s\S]*return authenticated;/, 'applySession must fall back to anon headers and return authenticated=false for invalid sessions');
assert.match(html, /if \(event === 'SIGNED_IN' \|\| event === 'INITIAL_SESSION'\)[\s\S]*if \(authenticated\)[\s\S]*showApp\(\)[\s\S]*loadData\(\)/, 'auth state listener must show the app only for authenticated sessions');
assert.match(html, /const authenticated = applySession\(data\?\.session\);[\s\S]*if \(authenticated\)[\s\S]*showApp\(\)[\s\S]*loadData\(\)/, 'initial bootstrap must show the app only for authenticated sessions');
assert.match(html, /token === SUPABASE_ANON/, 'auth validation must reject the anon JWT as an app session');

const catalogFetch = sliceBetween(html, 'async function fetchCatalogData', 'function catSortProducts');
assert(catalogFetch.includes('countrySettings = await catReloadCountrySettings()'), 'catalog price sync must load country_settings through the shared reload helper');
assert(html.includes("country_settings?select=*"), 'catalog price sync must not query a non-existent region column');
assert(!html.includes('country_settings?select=region,margin_formula'), 'catalog price sync must not use the old invalid country_settings select');
assert(html.includes('cs.region || cs.country_code'), 'catalog margin formulas must map country_code rows to operating regions');

console.log('v2 QA stabilization static checks passed');
