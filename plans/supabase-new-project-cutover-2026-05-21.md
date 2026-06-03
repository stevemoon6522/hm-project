# Supabase New Project Cutover - 2026-05-21

Project: `C:\dev\shopee-dashboard`

New Supabase project:

- Name: `multi-platform dashboard`
- Ref: `mgqlwgnmwegzsjelbrih`
- URL: `https://mgqlwgnmwegzsjelbrih.supabase.co`

## Findings

- Local runtime files already point at the new project URL/ref: `index.html`, `v2/index.html`, `api/v2-daily-close-summary.js`, `scripts/smoke-gkp-search.ps1`, `scripts/check-shopee-token-health.ps1`.
- New Supabase project is empty from the public REST and Functions probes:
  - Missing tables: `products`, `country_settings`, `product_shopee_listings`, `shopee_shops`, `shopee_tokens`, `shopee_app`, `inventory`, `shopee_mutation_log`.
  - Missing functions: `shopee-bridge`, `shopee-orders`, `joom-bridge`, `sheets-sync`, `starone-crawl`.
- Existing local migrations were v2 deltas only. They require base tables first, especially `products`, `country_settings`, `product_shopee_listings`, `shopee_shops`, `shopee_tokens`, and `shopee_app`.
- Added `supabase/migrations/202605110001_sd_base_schema.sql` as the prerequisite base schema. It creates the v1 browser-facing tables, token/shop/app tables, country seed rows, bigint Shopee ID columns, and the grants/RLS needed for the current v1 product search/add flow.
- Added standard Supabase CLI project files via `supabase init`: `supabase/config.toml` and `supabase/.gitignore`. The repo previously had migrations/functions but no `config.toml`.
- Supabase CLI is installed (`2.100.1`) but not authenticated. `supabase projects list`, `supabase link`, and function deploy all fail with `Access token not provided`.
- A task-parent question was forwarded requesting either `supabase login` or `SUPABASE_ACCESS_TOKEN` for project `mgqlwgnmwegzsjelbrih`.
- Vercel CLI auth works as `stevemoon6522-2807`.
- Vercel production still serves the old Supabase project in `/` and `/v2/` (`bpdafetvjyvvwbksvowu`, not `mgqlwgnmwegzsjelbrih`).
- Vercel production has `SUPABASE_SERVICE_ROLE_KEY` configured and `/api/v2-daily-close-summary` is using service-role mode against the old project. Before deploying the local runtime change, update Vercel production `SUPABASE_SERVICE_ROLE_KEY` to the new project service-role key, otherwise the Vercel API route will not match the new hard-coded URL.
- `edge-functions/joom-bridge/index.ts` was left untouched.

## Minimum Safe Cutover Steps

1. Authenticate Supabase CLI:
   - `supabase login`
   - or set `SUPABASE_ACCESS_TOKEN` for the account that owns `mgqlwgnmwegzsjelbrih`.
2. Link repo:
   - `supabase link --project-ref mgqlwgnmwegzsjelbrih`
3. Push DB migrations:
   - `supabase db push --linked`
   - This should apply `202605110001_sd_base_schema.sql` first, then existing v2 migrations including bigint migration `202605200012_bigint_shopee_ids.sql`.
4. Configure new project secrets/data:
   - Set or seed Shopee app credentials: `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY`, optionally `SHOPEE_MAIN_ACCOUNT_ID`.
   - Migrate or re-authorize `shopee_tokens` and `shopee_shops` for SG/TW/TH/MY/PH/BR. Without token rows, GKP search can load global catalog only after bridge auth is configured, but published shop auto-mapping will not work.
5. Deploy only required Edge Functions:
   - `supabase functions deploy shopee-bridge --project-ref mgqlwgnmwegzsjelbrih`
   - Optional next for ops script parity: `supabase functions deploy shopee-orders --project-ref mgqlwgnmwegzsjelbrih`
6. Probe:
   - `https://mgqlwgnmwegzsjelbrih.supabase.co/rest/v1/products?select=id&limit=1`
   - `https://mgqlwgnmwegzsjelbrih.supabase.co/rest/v1/country_settings?select=country_code&limit=1`
   - `https://mgqlwgnmwegzsjelbrih.supabase.co/functions/v1/shopee-bridge/health`
   - `https://mgqlwgnmwegzsjelbrih.supabase.co/functions/v1/shopee-bridge/tokens`
7. Update Vercel production env:
   - Replace `SUPABASE_SERVICE_ROLE_KEY` with the new project service-role key.
8. Deploy Vercel only after DB/functions/secrets pass:
   - `vercel deploy --prod --yes`

## Verification Run

Passed:

- `node scripts\test-gkp-product-master-import.mjs`
- `node scripts\test-shopee-registration-catalog-endpoints.mjs`
- `node scripts\test-v2-daily-close.mjs`
- `node scripts\test-v2-register-modal.mjs`

Failed / residual:

- `node scripts\test-shopee-bridge-image-hardening.mjs`
  - Failure: `edge-functions and supabase/functions shopee-bridge copies must match`
  - This mismatch was not changed in this task.

Blocked:

- Supabase remote link, migration push, and Edge Function deploy are blocked by missing Supabase CLI auth/access token.
- New project live HTTP probes still return 404 for required tables/functions because migrations/deploys could not be applied.

## Commands Run

```powershell
git status --short
Get-ChildItem -Force
Get-ChildItem -Recurse -Filter AGENTS.md | Select-Object -ExpandProperty FullName
Get-ChildItem -Recurse -Depth 2 -Path supabase,edge-functions,scripts,api -ErrorAction SilentlyContinue | Select-Object FullName,Mode,Length
Get-Content -Raw CLAUDE.md
Get-Content -Raw supabase\.temp\linked-project.json
if (Test-Path supabase\config.toml) { Get-Content -Raw supabase\config.toml }
supabase init
Get-ChildItem supabase\migrations | Select-Object -ExpandProperty Name
supabase --version
supabase projects list
supabase migration list
supabase functions list
vercel whoami
vercel env ls
supabase link --project-ref mgqlwgnmwegzsjelbrih
supabase functions deploy shopee-bridge --project-ref mgqlwgnmwegzsjelbrih
supabase db push --project-ref mgqlwgnmwegzsjelbrih
supabase db push --linked
supabase db push --linked --dry-run
node scripts\test-gkp-product-master-import.mjs
node scripts\test-shopee-registration-catalog-endpoints.mjs
node scripts\test-shopee-bridge-image-hardening.mjs
node scripts\test-v2-daily-close.mjs
node scripts\test-v2-register-modal.mjs
Invoke-WebRequest -Uri 'https://shopee-dashboard-kohl.vercel.app/' -UseBasicParsing -TimeoutSec 30
Invoke-WebRequest -Uri 'https://shopee-dashboard-kohl.vercel.app/v2/' -UseBasicParsing -TimeoutSec 30
Invoke-WebRequest -Uri 'https://shopee-dashboard-kohl.vercel.app/api/v2-daily-close-summary' -UseBasicParsing -TimeoutSec 30
vercel env pull .tmp_vercel_prod_env --environment=production --yes
Remove-Item -LiteralPath .tmp_vercel_prod_env -Force
psql --version
supabase db lint --help
```
