-- Phase A follow-up — structural CHECK on shopee_extra_attributes.
--
-- Codex code review P1 (2026-05-21): the column accepts any jsonb so malformed
-- manual edits (object instead of array, missing attribute_id, non-list value_list)
-- survive until publish time and surface as opaque Shopee `mandatory_attribute_missing`
-- errors. Validate the array-of-objects shape at the DB layer.
--
-- Required shape: jsonb array, each element { attribute_id: int, attribute_value_list: array }.

CREATE OR REPLACE FUNCTION public._validate_shopee_extra_attributes(p jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_elem jsonb;
  v_id text;
BEGIN
  IF p IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(p) <> 'array' THEN RETURN false; END IF;
  -- Empty array is allowed (publish-time builder fills mandatory attrs).
  FOR v_elem IN SELECT * FROM jsonb_array_elements(p) LOOP
    IF jsonb_typeof(v_elem) <> 'object' THEN RETURN false; END IF;
    v_id := v_elem ->> 'attribute_id';
    IF v_id IS NULL OR v_id !~ '^[0-9]+$' THEN RETURN false; END IF;
    IF jsonb_typeof(v_elem -> 'attribute_value_list') <> 'array' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

ALTER TABLE public.products
  ADD CONSTRAINT products_shopee_extra_attributes_shape_check
    CHECK (public._validate_shopee_extra_attributes(shopee_extra_attributes));

COMMENT ON CONSTRAINT products_shopee_extra_attributes_shape_check ON public.products
  IS 'Codex code review P1: shopee_extra_attributes must be array of {attribute_id:int, attribute_value_list:array}. Empty array OK.';
