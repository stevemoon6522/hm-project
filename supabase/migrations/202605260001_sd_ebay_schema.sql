-- eBay integration schema for shopee-dashboard
-- Matches joom_tokens / products pattern; adds ebay_tokens, ebay_policy_ids,
-- eBay columns on products, and a virtual 'EX' row in country_settings.
-- Created: 2026-05-26
-- Author: Claude (Sonnet 4.6 sub-agent)

-- ---------------------------------------------------------------------------
-- 1. ebay_tokens — single-row (id=1) OAuth refresh/access token store
--    Pattern: identical to joom_tokens
-- ---------------------------------------------------------------------------
create table if not exists public.ebay_tokens (
  id                integer primary key default 1,
  access_token      text,
  refresh_token     text not null,
  expiry_time       bigint,         -- Unix epoch seconds (access token expiry)
  client_id         text not null,
  client_secret     text not null,
  ru_name           text not null,  -- eBay RuName (redirect_uri)
  marketplace_id    varchar(16) not null default 'EBAY_US',
  updated_at        timestamptz not null default now(),
  constraint ebay_tokens_single_row check (id = 1)
);

comment on table public.ebay_tokens is
  'Single-row OAuth credential store for eBay Sell API. '
  'Populated once by scripts/setup-ebay-oauth.mjs; refresh_token valid 18 months.';

-- ---------------------------------------------------------------------------
-- 2. ebay_policy_ids — marketplace-scoped business policy IDs
--    Populated on first ebay-bridge call; avoids repeated Account API lookups
-- ---------------------------------------------------------------------------
create table if not exists public.ebay_policy_ids (
  marketplace_id          varchar(16) primary key,
  fulfillment_policy_id   text not null,
  return_policy_id        text not null,
  payment_policy_id       text not null,
  merchant_location_key   text not null default 'STARONE-SUWON-B105',
  updated_at              timestamptz not null default now()
);

comment on table public.ebay_policy_ids is
  'Per-marketplace business policy IDs queried from eBay Account API. '
  'ebay-bridge populates this on first publish; subsequent publishes read from here.';

-- ---------------------------------------------------------------------------
-- 3. products — eBay listing columns
--    All idempotent (add column if not exists)
-- ---------------------------------------------------------------------------

alter table public.products
  add column if not exists ebay_sku            varchar(50),        -- max 50 per Inventory spec L748
  add column if not exists ebay_offer_id       varchar(64),        -- POST /offer → offerId
  add column if not exists ebay_item_id        varchar(64),        -- POST /offer/{id}/publish → listingId
  add column if not exists ebay_marketplace_id varchar(16) not null default 'EBAY_US',
  add column if not exists ebay_status         varchar(32),        -- PUBLISHED | UNPUBLISHED | failed | pending
  add column if not exists ebay_published_at   timestamptz,
  add column if not exists ebay_last_synced_price numeric,
  add column if not exists ebay_last_synced_at    timestamptz,
  add column if not exists ebay_mapping_status varchar(16),        -- mapped | error
  add column if not exists ebay_mapping_error  text,
  add column if not exists ebay_category_id   varchar(16);         -- eBay taxonomy leaf category id

-- ---------------------------------------------------------------------------
-- 4. country_settings — virtual 'EX' row for eBay (US marketplace)
--    exchange_rate, sales_fee, pg_fee are the three fields used by
--    _v2EbayCalcUsdListing. Operator adjusts these values as needed.
--    INSERT only if 'EX' row doesn't already exist.
-- ---------------------------------------------------------------------------
insert into public.country_settings (
  country_code,
  name,
  currency,
  exchange_rate,   -- KRW → USD: 1380
  sales_fee,       -- eBay final value fee 13% (general categories)
  pg_fee,          -- Managed Payments: 2.7%
  gst,             -- US sales tax handled externally; 0 here
  fsp_fee,
  other_fee,
  settlement_fee,
  fsp_ccb,
  import_duty,
  fixed_service_fee,
  purchase_vat
)
values (
  'EX',
  'eBay US',
  'USD',
  1380,
  13,
  2.7,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0
)
on conflict (country_code) do nothing;

comment on column public.country_settings.country_code is
  '''EX'' = virtual eBay row (not a real ISO country). '
  'Used by _v2EbayCalcUsdListing in v2/index.html.';
