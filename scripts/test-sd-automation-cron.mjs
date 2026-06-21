import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync('v2/index.html', 'utf8');
const fn = readFileSync('supabase/functions/sd-automation-cron/index.ts', 'utf8');
const migration = readFileSync('supabase/migrations/202606010001_sd_automation_retry_log.sql', 'utf8');

assert.match(html, /function syncPlatformSkusForProductIds\(productIds\)/, 'V2 must expose post-register platform SKU sync helper');
assert.match(html, /post-register platform SKU sync failed/, 'V2 must run platform SKU sync after successful registration');
assert.match(html, /discovery_thumbnail_url/, 'V2 StarOneMall pending rows must carry discovery thumbnails');

assert.match(fn, /SD_AUTOMATION_CRON_SECRET/, 'automation cron must support a dedicated cron secret');
assert.match(fn, /buildDailyDigest/, 'automation cron must build a daily digest');
assert.match(fn, /retryTransientFailures/, 'automation cron must retry transient failures');
assert.match(fn, /sd_automation_retry_log/, 'automation cron must persist retry attempts');
assert.match(fn, /sendAlertBot/, 'automation cron must fall back to alert-bot when direct Telegram token is unavailable');
assert.match(fn, /SD_TELEGRAM_BOT_TOKEN/, 'automation cron must use the SD-specific Telegram bot token');
assert.match(fn, /SD_TELEGRAM_CHAT_ID/, 'automation cron must use the SD-specific Telegram chat id');
assert.doesNotMatch(fn, /Deno\.env\.get\("TELEGRAM_BOT_TOKEN"\)/, 'automation cron must not read the generic Telegram bot token');
assert.doesNotMatch(fn, /Deno\.env\.get\("TELEGRAM_CHAT_ID"\)/, 'automation cron must not read the generic Telegram chat id');
assert.match(fn, /entity_type: "sd_daily_digest"/, 'automation cron must send daily digest through alert-bot with a typed payload');
assert.match(fn, /source_type", "staronemall"\)\.eq\("status", "pending_review"\)/, 'daily digest must count pending StarOneMall candidates');
assert.match(fn, /Price\/cost change detection is excluded/, 'daily digest must document that cost-change detection is excluded');
assert.match(fn, /v2_resume_failed/, 'automation cron must reuse the existing failed mutation resume endpoint');
assert.match(fn, /prior\.length >= 2/, 'automation cron must cap automatic retry attempts');

assert.match(migration, /create table if not exists public\.sd_automation_retry_log/i, 'retry log migration must create retry log table');
assert.match(migration, /source_log_id bigint not null/i, 'retry log must store source mutation log id');
assert.match(migration, /enable row level security/i, 'retry log must enable RLS');

const alertBot = readFileSync('supabase/functions/alert-bot/index.ts', 'utf8');
assert.match(alertBot, /entityType === "sd_daily_digest"/, 'alert-bot must render SD daily digest messages');
assert.match(alertBot, /SD_TELEGRAM_BOT_TOKEN/, 'alert-bot must use the SD-specific Telegram bot token');
assert.match(alertBot, /SD_TELEGRAM_CHAT_ID/, 'alert-bot must use the SD-specific Telegram chat id');
assert.doesNotMatch(alertBot, /Deno\.env\.get\("TELEGRAM_BOT_TOKEN"\)/, 'alert-bot must not read the generic Telegram bot token');
assert.doesNotMatch(alertBot, /Deno\.env\.get\("TELEGRAM_CHAT_ID"\)/, 'alert-bot must not read the generic Telegram chat id');

console.log('SD automation cron static checks passed');
