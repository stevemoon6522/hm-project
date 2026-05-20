-- D1 alert-bot: per-(entity_type, error_code) rate-limit buckets.
-- Plan ref: platform-publish-dispatcher-plan.md v2 §D1
--
-- bucket_key = entity_type || ':' || error_code
--   e.g. 'platform_listing:DOCS_NOT_READY'
--        'platform_listing:PLATFORM_AUTH_FAILED'
--
-- 1 alert / 15 min per bucket. When more events arrive within the window
-- we increment suppressed_count and stash last_payload; on the next emission
-- after the window we send a "+N more events since last alert" rollup.

CREATE TABLE IF NOT EXISTS public.alert_buckets (
  bucket_key        text        PRIMARY KEY,
  last_alert_at     timestamptz NOT NULL DEFAULT now(),
  last_payload      jsonb,
  suppressed_count  integer     NOT NULL DEFAULT 0,
  total_count       integer     NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alert_buckets_last_alert_idx
  ON public.alert_buckets (last_alert_at DESC);

ALTER TABLE public.alert_buckets ENABLE ROW LEVEL SECURITY;
-- No user-facing access needed; only service_role writes (via alert-bot Edge Function).

-- ---------------------------------------------------------------------------
-- Codex follow-up: explicit service_role write policy on ebay_revision_counts.
-- The original D0 migration comment said "service-role bypasses RLS" which is
-- correct in Supabase, but an explicit policy makes the intent auditable and
-- prevents surprises if bypass settings change.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "ebay_revision_counts service_role write"
  ON public.ebay_revision_counts;
CREATE POLICY "ebay_revision_counts service_role write"
  ON public.ebay_revision_counts FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);
