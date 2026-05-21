-- D2 P1: publish_request_id idempotency gate inside shopee-bridge.
-- A separate table avoids polluting shopee_mutation_log (which uses payload_hash
-- as its idempotency key and is owned by the V2 wizard flow).
-- This table is used only by the shopee-bridge layer for callers that pass
-- publish_request_id directly to the bridge.

create table if not exists shopee_publish_idempotency (
  publish_request_id uuid primary key,
  action             text not null,
  region             text,
  shop_id            bigint,
  response           jsonb,
  created_at         timestamptz not null default now()
);

-- Automatically purge rows older than 7 days via a scheduled vacuum-friendly
-- approach: the bridge SELECT filters on created_at >= now()-interval '7 days',
-- so stale rows are simply ignored. Actual deletion can be done via a pg_cron
-- job or manual VACUUM; no trigger needed here.

create index if not exists idx_shopee_publish_idempotency_created_at
  on shopee_publish_idempotency (created_at desc);
