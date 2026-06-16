-- Private Shopee Open Platform app credentials per Shopee account.
--
-- Local docs referenced:
-- - C:\dev\api-refs\marketplaces\shopee\docs_ai_guides\common\token_rules.json
-- - C:\dev\api-refs\marketplaces\shopee\docs_ai_guides\guides\regional\krsc-api-integration-guide.md
-- Shopee signatures are tied to the Open Platform partner_id/partner_key,
-- so a completely separate merchant app must not reuse the default app key.

create table if not exists public.shopee_account_credentials (
  account_key text primary key references public.shopee_account_profiles(account_key) on delete cascade,
  partner_id bigint not null,
  partner_key_secret_name text not null,
  is_sandbox boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopee_account_credentials_key_check
    check (account_key ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  constraint shopee_account_credentials_secret_check
    check (partner_key_secret_name ~ '^[A-Z0-9_]{3,128}$')
);

drop trigger if exists shopee_account_credentials_touch_updated_at on public.shopee_account_credentials;
create trigger shopee_account_credentials_touch_updated_at
before update on public.shopee_account_credentials
for each row execute function public.sd_touch_updated_at();

insert into public.shopee_account_credentials (
  account_key,
  partner_id,
  partner_key_secret_name,
  is_sandbox,
  notes
) values (
  'starphotocard',
  2033682,
  'SHOPEE_PARTNER_KEY',
  false,
  'Default existing Shopee Open Platform app. Existing global env fallback is kept for compatibility.'
) on conflict (account_key) do update
set
  partner_id = excluded.partner_id,
  partner_key_secret_name = excluded.partner_key_secret_name,
  is_sandbox = excluded.is_sandbox,
  updated_at = now();

alter table public.shopee_account_credentials enable row level security;

revoke all on public.shopee_account_credentials from anon, authenticated;
grant all on public.shopee_account_credentials to service_role;
