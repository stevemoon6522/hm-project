-- Persistent read-cache for Shopee registration preflight APIs.
-- Kept separate from shopee_mutation_log because these rows are operational
-- cache data, not mutation audit records.

create table if not exists public.shopee_registration_read_cache (
  cache_key text primary key,
  cache_kind text not null,
  account_key text not null default 'starphotocard',
  region text,
  cache_scope text,
  payload jsonb not null,
  expires_at timestamptz not null,
  hit_count integer not null default 0,
  last_hit_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_shopee_registration_read_cache_expires_at
  on public.shopee_registration_read_cache (expires_at);

create index if not exists idx_shopee_registration_read_cache_kind_region
  on public.shopee_registration_read_cache (cache_kind, account_key, region);

drop trigger if exists shopee_registration_read_cache_touch_updated_at
  on public.shopee_registration_read_cache;

create trigger shopee_registration_read_cache_touch_updated_at
before update on public.shopee_registration_read_cache
for each row execute function public.sd_touch_updated_at();

notify pgrst, 'reload schema';
