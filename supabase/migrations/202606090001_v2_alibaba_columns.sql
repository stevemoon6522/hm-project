-- Alibaba (ICBU) master-product registration — Phase A scaffolding.
--
-- Plan ref: plans/alibaba-deep-lemon.md §1.
-- Adds the products columns the Alibaba create_listing adapter reads, and
-- lowers the Alibaba auth_verified flag so the dispatcher (gate 4) blocks any
-- LIVE registration until an operator runs an ICBU auth smoke test and flips
-- the flag back to true — mirroring how Qoo10 is gated.
--
-- HARD CONSTRAINT (Codex P0 #1, see 202605200003 header): no implementation
-- against guessed API behavior. The exact shape of alibaba_attributes and the
-- set of truly-required ICBU fields come from the operator's local
-- C:\dev\api-refs\marketplaces\alibaba\markdown\api\*.md docs, which are NOT in
-- this repo. Columns flagged [B] below are provisional until those docs land.

-- ---------------------------------------------------------------------------
-- 1. products columns (mirror the qoo10_* / ebay_* naming convention).
-- ---------------------------------------------------------------------------
alter table public.products
  add column if not exists alibaba_category_id text;            -- ICBU category id (required for create_listing)

alter table public.products
  add column if not exists alibaba_attributes jsonb;            -- [B] required category/SKU attribute payload

alter table public.products
  add column if not exists alibaba_group_id text;               -- [B] ICBU product group id

alter table public.products
  add column if not exists alibaba_freight_template_id text;    -- shipping/freight template id (-> ALIBABA_SHIPPING_TEMPLATE_MISSING)

alter table public.products
  add column if not exists alibaba_moq integer not null default 1;  -- minimum order quantity (B2B); default single unit

alter table public.products
  add column if not exists alibaba_unit text;                   -- trade unit (e.g. 'piece'); [B] enum from docs

alter table public.products
  add column if not exists alibaba_price_usd numeric;           -- single FOB price (1st cut: no ladder tiers)

-- ---------------------------------------------------------------------------
-- 2. Gate Alibaba behind an auth smoke test (plan §1, §5).
--    The 202605200020 seed defaulted alibaba auth_verified=true; lower it so
--    platform-publish gate 4 returns AUTH_NOT_VERIFIED until an operator
--    confirms ICBU credentials work, then flips this back to true.
--    docs_ready stays true (create_listing/sync are already doc-evidenced).
-- ---------------------------------------------------------------------------
update public.platform_capabilities
   set auth_verified = false,
       updated_at = now()
 where platform = 'alibaba'
   and capability in ('create_listing', 'sync');

-- ---------------------------------------------------------------------------
-- Verify the columns and the gate landed.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'products'
       and column_name = 'alibaba_category_id'
  ) then
    raise exception 'products.alibaba_category_id was not created';
  end if;

  if exists (
    select 1 from public.platform_capabilities
     where platform = 'alibaba' and capability = 'create_listing'
       and auth_verified = true
  ) then
    raise exception 'alibaba create_listing should be auth_verified=false until smoke test passes';
  end if;
end$$;
