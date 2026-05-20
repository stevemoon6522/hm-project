-- Codex P0 (D0 review 2026-05-20): upsert_platform_listing was created in
-- migration 202605200020 without `SET search_path = public, pg_temp` and
-- with implicit PUBLIC EXECUTE grant.
--   1) search_path injection risk for any caller that controls a writable
--      schema in their session search_path.
--   2) PUBLIC EXECUTE means anon JWT (and unauthenticated PostgREST users)
--      can call the RPC; the dispatcher's own auth gate is the only thing
--      preventing arbitrary platform_listings writes today.
-- Other SECURITY DEFINER RPCs in this project (delete_master_product,
-- promote_source_to_product) already pin search_path; this one was a
-- one-off miss in the D0 implementation.

CREATE OR REPLACE FUNCTION public.upsert_platform_listing(
  p_master_product_id uuid,
  p_platform text,
  p_shop_id text,
  p_country text,
  p_platform_item_id text,
  p_listing_status text,
  p_last_publish_request_id uuid,
  p_last_payload jsonb,
  p_last_sync_at timestamp with time zone,
  p_error_msg text,
  p_error_code text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.platform_listings (
    master_product_id, platform, shop_id, country,
    platform_item_id, listing_status, last_publish_request_id,
    last_payload, last_sync_at, error_msg, error_code, updated_at
  ) VALUES (
    p_master_product_id, p_platform, p_shop_id, p_country,
    p_platform_item_id, p_listing_status, p_last_publish_request_id,
    p_last_payload, p_last_sync_at, p_error_msg, p_error_code, now()
  )
  ON CONFLICT (master_product_id, platform, coalesce(shop_id,''), coalesce(country,''))
    WHERE deleted_at IS NULL
  DO UPDATE SET
    platform_item_id          = EXCLUDED.platform_item_id,
    listing_status            = EXCLUDED.listing_status,
    last_publish_request_id   = EXCLUDED.last_publish_request_id,
    last_payload              = EXCLUDED.last_payload,
    last_sync_at              = EXCLUDED.last_sync_at,
    error_msg                 = EXCLUDED.error_msg,
    error_code                = EXCLUDED.error_code,
    updated_at                = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.upsert_platform_listing(
  uuid, text, text, text, text, text, uuid, jsonb, timestamp with time zone, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.upsert_platform_listing(
  uuid, text, text, text, text, text, uuid, jsonb, timestamp with time zone, text, text
) TO authenticated;
