# DB Storage, History, and Price Snapshot Plan

Last updated: 2026-06-02

## Goal

The dashboard stores marketplace operation data in one Supabase project. The DB must make three things easy to answer:

1. What is the current master product and platform coverage state?
2. What external/source data produced that state?
3. If price or listing sync goes wrong, which previous known-good value can be restored?

The rule is simple: **current tables are fast read models; history tables are append-only evidence.** Current columns may be updated for UI speed, but important marketplace mutations must leave an immutable snapshot or audit row.

## Current DB Responsibilities

`products`

- Canonical master/variant SKU facts used by V2.
- Stores current operator-facing values such as SKU, product name, option name, cost, weight, lifecycle, StarOneMall URL, and image URL.
- It should not become the long-term home for platform-specific publish history.

`product_shopee_listings`

- Shopee-specific mapping table.
- Keeps Shopee region/shop/global item/model IDs and current sync status.
- Shopee remains separate because region/model mapping is more complex than the other platforms.

`platform_listings`

- Non-Shopee current platform mapping/status table for Joom, Qoo10, eBay, and later supported platforms.
- Stores external SKU/item IDs, mapping status, listing status, last payload, and last sync/error state.
- Existing SKU lookup hits should be absorbed here instead of creating duplicate platform listings.

`source_records` and `platform_listing_snapshots`

- Raw/source evidence tables.
- Use these when importing or reconciling external marketplace/source data before accepting it into master data.

`audit_log`

- Append-only mutation trail for product, platform listing, source, and future price snapshot events.
- Keep this as the cross-entity audit index, not as the full payload warehouse.

Supabase Storage `product-images`

- Stores operator-attached product/option images.
- `products.main_image` can keep the current public URL. If image roles/history grow, add a separate `product_assets` table later.

## Storage Rules

1. `products` is the canonical current master row, not the history table.
2. `product_shopee_listings` and `platform_listings` are current platform state/read models.
3. Platform lookup/create/update raw responses must be preserved in `last_payload` or a snapshot table.
4. Price changes must create a `price_snapshot` before any live platform update.
5. Rollback must use a previous snapshot's known-good platform price, not a recalculated formula.
6. Lookup/auth/network failures must store `error` state and must not be treated as `not_listed`.
7. Alibaba remains unsupported for this flow until explicitly added.

## Minimal Price Snapshot Schema

Start with two tables only: `price_batches` and `price_snapshots`.

`price_batches`

```sql
create table if not exists public.price_batches (
  id uuid primary key default gen_random_uuid(),
  batch_type text not null check (batch_type in ('dry_run', 'apply', 'rollback')),
  status text not null default 'draft'
    check (status in ('draft', 'ready', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  trigger_source text not null default 'manual'
    check (trigger_source in ('manual', 'cost_change', 'fx_change', 'fee_change', 'scheduled', 'rollback')),
  actor text not null default 'operator',
  reason text,
  dry_run boolean not null default true,
  platform_filter text[] not null default array[]::text[],
  summary_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);
```

Purpose:

- Groups one pricing run or rollback run.
- Lets the UI show batch-level status and retry/rollback targets.
- Keeps dry-run and live apply runs separate.

`price_snapshots`

```sql
create table if not exists public.price_snapshots (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.price_batches(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  platform_listing_id uuid references public.platform_listings(id) on delete set null,
  rollback_source_snapshot_id uuid references public.price_snapshots(id) on delete set null,

  platform text not null check (platform in ('shopee', 'joom', 'qoo10', 'ebay')),
  region text,
  country text,
  shop_id text,
  sku text not null,

  currency text not null,
  cost_krw numeric,
  weight_g numeric,
  exchange_rate numeric,
  fee_model jsonb not null default '{}'::jsonb,
  formula_key text,
  rule_version text,
  rounding_rule text,

  previous_platform_price numeric,
  computed_platform_price numeric not null,
  final_platform_price numeric not null,
  margin_krw numeric,
  margin_pct numeric,

  guardrail_status text not null default 'pass'
    check (guardrail_status in ('pass', 'ignore_log', 'approval_required', 'blocked', 'error')),
  guardrail_reasons text[] not null default array[]::text[],

  snapshot_status text not null default 'computed'
    check (snapshot_status in ('computed', 'approved', 'sent', 'applied', 'failed', 'rolled_back', 'skipped')),
  remote_before jsonb not null default '{}'::jsonb,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  error_code text,
  error_msg text,

  created_at timestamptz not null default now(),
  approved_at timestamptz,
  sent_at timestamptz,
  applied_at timestamptz
);
```

Recommended indexes:

```sql
create index if not exists price_snapshots_product_created_idx
  on public.price_snapshots (product_id, created_at desc);

create index if not exists price_snapshots_platform_sku_idx
  on public.price_snapshots (platform, sku, created_at desc);

create index if not exists price_snapshots_batch_idx
  on public.price_snapshots (batch_id, snapshot_status);
```

Purpose:

- Stores each calculated price and the exact inputs used to calculate it.
- Holds previous/current/target price values for rollback.
- Stores guardrail outcome before any live update.
- Stores request/response payload evidence after live update.

## Write Flow

Dry-run price calculation:

1. Create `price_batches` with `batch_type='dry_run'`, `dry_run=true`.
2. For each SKU/platform target, calculate price and insert `price_snapshots`.
3. Do not call marketplace APIs.
4. UI reads snapshots and shows price diff, margin, and guardrail status.

Live price apply:

1. Create a new `price_batches` row with `batch_type='apply'`, `dry_run=false`.
2. Copy or recreate approved snapshot rows into the apply batch.
3. For each `price_snapshots` row where `guardrail_status='pass'`, call the platform update API.
4. Update that snapshot's status to `applied` or `failed`.
5. Update current read-model fields only after success:
   - Shopee: `product_shopee_listings.last_synced_price`, `last_synced_at`
   - Joom/eBay/Qoo10: `platform_listings.last_payload`, `last_sync_at`, and future current price columns if added
6. Insert `audit_log` rows keyed to the batch and snapshot.

Rollback:

1. Operator selects a previous `price_snapshots` row with a known-good `previous_platform_price` or `final_platform_price`.
2. Create `price_batches` with `batch_type='rollback'`.
3. Create rollback `price_snapshots` rows with `rollback_source_snapshot_id`.
4. Send last known-good platform price.
5. Mark rollback result and write `audit_log`.

## Current-State Price Cache Recommendation

Keep current display fields for speed, but make them cache fields:

- Shopee already has `product_shopee_listings.last_synced_price`.
- Joom currently stores price cache on `products.joom_last_synced_price`; keep it short term for compatibility.
- eBay currently stores price cache on product-level eBay columns; keep it short term.

Next DB cleanup should add generic cache columns to `platform_listings`:

```sql
alter table public.platform_listings
  add column if not exists last_remote_price numeric,
  add column if not exists last_remote_currency text,
  add column if not exists last_remote_price_checked_at timestamptz;
```

After the UI reads these columns reliably, Joom/eBay product-level price cache columns can be treated as legacy compatibility fields.

## Execution Order

1. Documentation only: keep this plan and `AGENTS.md` guardrails updated.
2. Add migration for `price_batches` and `price_snapshots`.
3. Add a static/schema test that verifies tables, checks, indexes, and RLS/read policy.
4. Wire Shopee/Joom dry-run price calculation to insert snapshots without live API calls.
5. Add UI history panel for one SKU/platform.
6. Link live price update success/failure to `price_snapshots`.
7. Add rollback action using prior known-good snapshot.
8. Consolidate Joom/eBay current price cache into `platform_listings`.

## Validation Gates

Each step must pass before continuing:

- `git diff --check`
- SQL migration lint/readback
- Targeted V2 static test
- Local `/v2/` or HTML review for UI changes
- No live platform call during dry-run snapshot steps

Do not deploy until the user explicitly asks for deployment.
