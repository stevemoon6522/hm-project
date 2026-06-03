import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const crawler = readFileSync(join(root, 'supabase', 'functions', 'starone-crawl', 'index.ts'), 'utf8');
const html = readFileSync(join(root, 'v2', 'index.html'), 'utf8');

assert.match(crawler, /DEFAULT_DISCOVERY_URL = `\$\{STARONEMALL_BASE\}\/shop\/big_section\.php\?cno1=26`/, 'crawler must default to StarOneMall ALBUM newest page');
assert.match(crawler, /function extractDiscoveryItems\(/, 'crawler must parse discovery list pages');
assert.match(crawler, /function discoverStaronemallProducts\(/, 'crawler must expose discovery workflow');
assert.match(crawler, /body\.discover/, 'crawler handler must route discover payloads before URL crawl');
assert.match(crawler, /STARONE_CRON_SECRET/, 'crawler must support cron secret auth');
assert.match(crawler, /source_type: "staronemall"/, 'crawler discovery must write StarOneMall source records');
assert.match(crawler, /status: "pending_review"/, 'discovered products must remain pending_review for operator registration');
assert.match(crawler, /\.from\("products"\)[\s\S]*\.eq\("staronemall_url", item\.url\)/, 'discovery must skip already registered products');
assert.match(crawler, /\.from\("source_records"\)[\s\S]*\.eq\("source_external_id", pno\)/, 'discovery must dedupe existing source_records by pno');

assert.match(html, /MR_PENDING_STARONE_LOADED/, 'V2 URL registration must track pending StarOneMall preload state');
assert.match(html, /function mrLoadPendingStaronemallRows\(/, 'V2 URL registration must load pending StarOneMall source records');
assert.match(html, /\.from\('source_records'\)[\s\S]*\.eq\('source_type', 'staronemall'\)[\s\S]*\.eq\('status', 'pending_review'\)/, 'V2 preload must read pending StarOneMall source_records');
assert.match(html, /if \(target === 'url'\) mrLoadPendingStaronemallRows\(false\)/, 'V2 must preload pending StarOneMall rows when URL tab opens');
assert.match(html, /discovery_title/, 'V2 URL rows must show a product hint, not only a raw URL');
assert.match(html, /무게\(g\)만 입력하세요/, 'V2 preload copy must keep operator workflow focused on weight input');

console.log('StarOneMall discovery cron static checks passed');
