# Shopify Price Policy DB/UI Results

Date: 2026-06-28

## Scope

Priority 3 moved Shopify product pricing policy out of the hardcoded adapter path and into an operator-editable DB/UI setting.

## Implemented

- Added `public.shopify_price_policy` singleton table with approved defaults:
  - selling currency `USD`
  - KRW/USD `1460`
  - target margin `30%`
  - payment fee `1%`
  - transaction fee `10%`
  - fixed operation fee `0%`
  - shipping included in product price `false`
  - default product status `ACTIVE`
  - inventory push `false`
- Added RLS:
  - public read policy for the V2 app
  - authenticated write policy for operator edits
- Updated `platform-publish` Shopify adapter:
  - loads `shopify_price_policy` through the service-role client
  - normalizes DB fields into the existing price formula
  - keeps the approved values as fallback defaults
  - uses the loaded policy for variant prices, default status, inventory gating, and dry-run `pricing_policy`
  - uses a 30 second Edge-instance cache so UI changes are picked up without permanent stale policy
- Added V2 fee settings Shopify policy panel:
  - static default fields render before DB load
  - authenticated app load reads `shopify_price_policy`
  - save upserts the singleton row

## Verification

Static and unit-style checks:

```powershell
node scripts\test-shopify-price-policy-db-ui.mjs
node scripts\test-shopify-product-registration.mjs
node scripts\test-v2-qa-stabilization.mjs
node scripts\test-v2-price-sync-joom-preorder-fee-ui.mjs
```

All passed.

Syntax check:

```powershell
node --experimental-vm-modules --input-type=module -
```

Result: V2 inline classic/module scripts parse successfully.

Local render check:

- Served the worktree at `http://127.0.0.1:5174/v2/`.
- The local app reached the auth screen as expected without a local Supabase session.
- The hidden app shell DOM contains `#shopify-price-policy-panel`.
- The panel contains 9 policy controls with default values:
  - `currency=USD`
  - `krw_per_usd=1460`
  - `target_margin_pct=30`
  - `payment_fee_pct=1`
  - `transaction_fee_pct=10`
  - `fixed_operation_fee_pct=0`
  - `include_shipping_in_price=false`
  - `default_status=ACTIVE`
  - `set_inventory=false`

Remote DB verification:

```sql
select id,currency,krw_per_usd,target_margin_pct,payment_fee_pct,
       transaction_fee_pct,fixed_operation_fee_pct,
       include_shipping_in_price,default_status,set_inventory
from public.shopify_price_policy
where id = 'default';
```

Returned the approved default row.

Policy verification:

```sql
select policyname,cmd
from pg_policies
where schemaname='public'
  and tablename='shopify_price_policy'
order by policyname;
```

Returned:

- `shopify_price_policy authenticated write` / `ALL`
- `shopify_price_policy public read` / `SELECT`

Deploy verification:

- Applied only `supabase/migrations/202606280001_shopify_price_policy.sql` with `supabase db query --linked --file ...`.
- Deployed `platform-publish` to project `mgqlwgnmwegzsjelbrih`.
- Called the deployed `platform-publish` with the public anon JWT and a Shopify dry-run body.
  - Expected/observed response: HTTP 401 `auth_anon_rejected`
  - Meaning: the deployed function is reachable and the authenticated dispatcher gate is active.
- Deployed V2 to Vercel production.
  - Verified `https://starphotocard-multi-dashboard.vercel.app/v2/` contains `shopify-price-policy-panel`, `shopify_price_policy`, and `data-shopify-policy-key="krw_per_usd"`.
  - Verified `https://shopee-dashboard-kohl.vercel.app/v2/` contains the same markers.
  - The one-off deployment URL is behind Vercel login protection, so smoke checks use the public aliases.

## Limitation

An authenticated V2 browser JWT was not available in the current local browser session, so the final `platform-publish` dry-run could not be called through the authenticated dispatcher. The function-level deployment succeeded, and the DB/UI/adapter path is covered by static regression checks plus direct DB verification. A live authenticated V2 dry-run should be run after restoring a signed-in V2 browser session.
