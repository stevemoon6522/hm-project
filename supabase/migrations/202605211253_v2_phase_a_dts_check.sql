-- Phase A follow-up — DTS (days-to-ship) range CHECK constraint.
--
-- Operator msg #673 (2026-05-21): Shopee Shop SKU Pre-Order Yes mode allows
-- "3 to 150 business days". Earlier observation (Global SKU Ready Stock mode)
-- showed "1 to 10". Shopee's official API docs don't publish the explicit
-- min/max but the UI enforces these ranges per lifecycle. Add a DB CHECK so
-- master-data edits that violate the range fail fast instead of being
-- rejected later by Shopee's create_publish_task with error_invalid_days_to_ship.
--
-- Validation: each region's DTS in ready_stock map must be 1-10 inclusive;
--             each region's DTS in pre_order map must be 3-150 inclusive.
-- Uses a helper function so the constraint is reusable + readable.

CREATE OR REPLACE FUNCTION public._validate_shopee_dts(p_dts jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_ready jsonb := p_dts -> 'ready_stock';
  v_pre   jsonb := p_dts -> 'pre_order';
  v_key   text;
  v_val   int;
BEGIN
  -- NULL or missing maps treated as valid (NULL safe; column default fills both).
  IF p_dts IS NULL THEN RETURN true; END IF;

  IF v_ready IS NOT NULL THEN
    FOR v_key IN SELECT jsonb_object_keys(v_ready) LOOP
      v_val := (v_ready ->> v_key)::int;
      IF v_val < 1 OR v_val > 10 THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;

  IF v_pre IS NOT NULL THEN
    FOR v_key IN SELECT jsonb_object_keys(v_pre) LOOP
      v_val := (v_pre ->> v_key)::int;
      IF v_val < 3 OR v_val > 150 THEN
        RETURN false;
      END IF;
    END LOOP;
  END IF;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  -- malformed JSON or non-integer values — reject
  RETURN false;
END;
$$;

ALTER TABLE public.products
  ADD CONSTRAINT products_shopee_days_to_ship_range_check
    CHECK (public._validate_shopee_dts(shopee_days_to_ship));

COMMENT ON CONSTRAINT products_shopee_days_to_ship_range_check ON public.products
  IS 'msg #673: Shopee UI enforces ready_stock DTS in 1-10 days, pre_order DTS in 3-150 days. DB rejects out-of-range values up-front.';
