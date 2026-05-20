-- D1 alert-bot: atomic bucket evaluation + rollback RPCs.
-- Fixes three P0 issues from Codex D1 review (commit cf0a4ca):
--   P0 #1 — SELECT-then-UPDATE race: replaced by SELECT FOR UPDATE inside txn.
--   P0 #2 — last_alert_at advanced before sendTelegram: rollback_alert_bucket
--            restores prev state on Telegram failure.
--   P0 #3 — telegram_not_configured still touched bucket: fixed in TS handler
--            (early 503 before any bucket call); these RPCs are never reached.
--
-- Pattern matches upsert_platform_listing hardening (migration 202605200021):
--   SECURITY DEFINER, SET search_path, REVOKE PUBLIC, GRANT authenticated.

-- ---------------------------------------------------------------------------
-- evaluate_alert_bucket
-- ---------------------------------------------------------------------------
-- Atomically decides whether this event should be sent to Telegram.
-- Uses SELECT FOR UPDATE to serialize concurrent callers on the same bucket_key.
--
-- Returns one row:
--   should_send                 bool    — true if caller should call sendTelegram
--   suppressed_count_for_rollup int     — # suppressed since last send (for rollup msg)
--   prev_last_alert_at          tstz    — snapshot before this call (needed for rollback)
--   prev_suppressed_count       int     — snapshot before this call (needed for rollback)
--   prev_total_count            int     — snapshot before this call (informational)
CREATE OR REPLACE FUNCTION public.evaluate_alert_bucket(
  p_bucket_key text,
  p_payload    jsonb
)
RETURNS TABLE(
  should_send                 bool,
  suppressed_count_for_rollup integer,
  prev_last_alert_at          timestamptz,
  prev_suppressed_count       integer,
  prev_total_count            integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_row                  public.alert_buckets%ROWTYPE;
  v_prev_last_alert_at   timestamptz;
  v_prev_suppressed      integer;
  v_prev_total           integer;
BEGIN
  -- Try to lock an existing row. FOR UPDATE serializes concurrent evaluations
  -- on the same bucket_key — only one txn proceeds at a time.
  SELECT * INTO v_row
    FROM public.alert_buckets
   WHERE bucket_key = p_bucket_key
     FOR UPDATE;

  IF NOT FOUND THEN
    -- First alert for this bucket: insert and send.
    INSERT INTO public.alert_buckets (
      bucket_key, last_alert_at, last_payload, suppressed_count, total_count
    ) VALUES (
      p_bucket_key, now(), p_payload, 0, 1
    );
    RETURN QUERY SELECT
      true::bool,
      0::integer,
      NULL::timestamptz,
      0::integer,
      0::integer;
    RETURN;
  END IF;

  -- Capture snapshot before any mutation (needed for rollback).
  v_prev_last_alert_at := v_row.last_alert_at;
  v_prev_suppressed    := v_row.suppressed_count;
  v_prev_total         := v_row.total_count;

  IF now() - v_row.last_alert_at < interval '15 minutes' THEN
    -- Within cooldown: suppress. Increment counters, no send.
    UPDATE public.alert_buckets SET
      suppressed_count = v_row.suppressed_count + 1,
      total_count      = v_row.total_count + 1,
      last_payload     = p_payload,
      updated_at       = now()
    WHERE bucket_key = p_bucket_key;

    RETURN QUERY SELECT
      false::bool,
      0::integer,
      v_prev_last_alert_at,
      v_prev_suppressed,
      v_prev_total;
  ELSE
    -- Cooldown elapsed: send with rollup.
    UPDATE public.alert_buckets SET
      last_alert_at    = now(),
      suppressed_count = 0,
      total_count      = v_row.total_count + 1,
      last_payload     = p_payload,
      updated_at       = now()
    WHERE bucket_key = p_bucket_key;

    RETURN QUERY SELECT
      true::bool,
      v_prev_suppressed,          -- suppressed since last send, for rollup msg
      v_prev_last_alert_at,
      v_prev_suppressed,
      v_prev_total;
  END IF;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.evaluate_alert_bucket(text, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.evaluate_alert_bucket(text, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- rollback_alert_bucket
-- ---------------------------------------------------------------------------
-- Restores the bucket to the state captured before evaluate_alert_bucket ran.
-- Called by alert-bot when sendTelegram fails after should_send=true was returned,
-- so the next real alert is not silently suppressed by an advanced last_alert_at.
CREATE OR REPLACE FUNCTION public.rollback_alert_bucket(
  p_bucket_key           text,
  p_prev_last_alert_at   timestamptz,
  p_prev_suppressed_count integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  UPDATE public.alert_buckets SET
    last_alert_at    = p_prev_last_alert_at,
    suppressed_count = p_prev_suppressed_count,
    updated_at       = now()
  WHERE bucket_key = p_bucket_key;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rollback_alert_bucket(text, timestamptz, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.rollback_alert_bucket(text, timestamptz, integer) TO authenticated;
