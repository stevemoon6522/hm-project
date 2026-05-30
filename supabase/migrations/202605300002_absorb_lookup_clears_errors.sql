-- Ensure a successful SKU lookup absorb clears stale failure fields.
-- Without this, a row can be listing_status='listed' while still showing the last
-- joom_product_lookup_failed error from a previous failed sync.

create or replace function public.absorb_platform_sku_lookup(
  p_master_product_id uuid,
  p_platform text,
  p_external_sku text,
  p_platform_item_id text,
  p_external_variant_id text default null,
  p_country text default null,
  p_shop_id text default null,
  p_listing_status text default 'listed',
  p_raw_payload jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_master_sku text;
  v_platform text := lower(btrim(coalesce(p_platform, '')));
  v_external_sku text := btrim(coalesce(p_external_sku, ''));
  v_platform_item_id text := nullif(btrim(coalesce(p_platform_item_id, '')), '');
  v_external_variant_id text := nullif(btrim(coalesce(p_external_variant_id, '')), '');
  v_country text := nullif(btrim(coalesce(p_country, '')), '');
  v_shop_id text := nullif(btrim(coalesce(p_shop_id, '')), '');
  v_listing_status text := coalesce(nullif(btrim(p_listing_status), ''), 'listed');
begin
  if v_platform not in ('joom', 'qoo10', 'ebay') then
    raise exception 'Unsupported platform for SKU lookup absorb: %', p_platform;
  end if;

  if v_external_sku = '' then
    raise exception 'external SKU required';
  end if;

  select btrim(coalesce(p.sku, ''))
    into v_master_sku
  from public.products p
  where p.id = p_master_product_id;

  if v_master_sku is null then
    raise exception 'master product not found: %', p_master_product_id;
  end if;

  if v_master_sku = '' then
    raise exception 'master product SKU required: %', p_master_product_id;
  end if;

  if v_master_sku <> v_external_sku then
    raise exception 'SKU mismatch: master %, external %', v_master_sku, v_external_sku;
  end if;

  update public.platform_listings pl
     set platform_item_id = coalesce(v_platform_item_id, pl.platform_item_id),
         external_variant_id = v_external_variant_id,
         external_sku = v_external_sku,
         listing_status = v_listing_status,
         mapping_status = 'mapped',
         publish_origin = 'remote_imported',
         last_payload = coalesce(p_raw_payload, '{}'::jsonb),
         last_sync_at = now(),
         last_seen_at = now(),
         error_msg = null,
         error_code = null,
         deleted_at = null,
         updated_at = now()
   where pl.master_product_id = p_master_product_id
     and pl.platform = v_platform
     and coalesce(pl.shop_id, '') = coalesce(v_shop_id, '')
     and coalesce(pl.country, '') = coalesce(v_country, '')
     and pl.deleted_at is null
   returning pl.id into v_id;

  if v_id is not null then
    return v_id;
  end if;

  begin
    insert into public.platform_listings (
      master_product_id,
      platform,
      shop_id,
      country,
      platform_item_id,
      external_variant_id,
      external_sku,
      listing_status,
      mapping_status,
      publish_origin,
      last_payload,
      last_sync_at,
      last_seen_at,
      error_msg,
      error_code
    ) values (
      p_master_product_id,
      v_platform,
      v_shop_id,
      v_country,
      v_platform_item_id,
      v_external_variant_id,
      v_external_sku,
      v_listing_status,
      'mapped',
      'remote_imported',
      coalesce(p_raw_payload, '{}'::jsonb),
      now(),
      now(),
      null,
      null
    ) returning id into v_id;
  exception when unique_violation then
    update public.platform_listings pl
       set platform_item_id = coalesce(v_platform_item_id, pl.platform_item_id),
           external_variant_id = v_external_variant_id,
           external_sku = v_external_sku,
           listing_status = v_listing_status,
           mapping_status = 'mapped',
           publish_origin = 'remote_imported',
           last_payload = coalesce(p_raw_payload, '{}'::jsonb),
           last_sync_at = now(),
           last_seen_at = now(),
           error_msg = null,
           error_code = null,
           deleted_at = null,
           updated_at = now()
     where pl.master_product_id = p_master_product_id
       and pl.platform = v_platform
       and coalesce(pl.shop_id, '') = coalesce(v_shop_id, '')
       and coalesce(pl.country, '') = coalesce(v_country, '')
     returning pl.id into v_id;
  end;

  if v_id is null then
    raise exception 'failed to absorb platform SKU lookup for product %, platform %', p_master_product_id, v_platform;
  end if;

  return v_id;
end;
$$;
