-- Shopee Global SKU master dispatch foundation.
--
-- Goals:
--   1) Expose canonical SKU coverage across supported platforms.
--   2) Absorb remote SKU lookup hits into platform_listings without publishing duplicates.
--
-- Alibaba is intentionally excluded from the new SKU-dispatch flow.

create or replace view public.sku_platform_coverage as
select
  p.id as master_product_id,
  p.sku,
  'shopee'::text as platform,
  case
    when exists (
      select 1
      from public.product_shopee_listings psl
      where psl.product_id = p.id
        and psl.shop_item_id is not null
        and coalesce(psl.status, '') in ('mapped', 'listed')
    ) then 'listed'
    when exists (
      select 1
      from public.product_shopee_listings psl
      where psl.product_id = p.id
        and psl.global_item_id is not null
    ) then 'mapped_global'
    else 'not_listed'
  end as coverage_status,
  null::text as platform_item_id,
  null::text as external_variant_id,
  null::text as external_sku,
  null::text as shop_id,
  null::text as country
from public.products p
where btrim(coalesce(p.sku, '')) <> ''

union all

select
  p.id as master_product_id,
  p.sku,
  platform_name.platform,
  coalesce(latest.coverage_status, 'not_listed') as coverage_status,
  latest.platform_item_id,
  latest.external_variant_id,
  latest.external_sku,
  latest.shop_id,
  latest.country
from public.products p
cross join (values ('joom'), ('qoo10'), ('ebay')) as platform_name(platform)
left join lateral (
  select
    case
      when pl.mapping_status = 'mapped'
        and coalesce(pl.listing_status, '') not in ('error', 'rejected', 'banned') then 'listed'
      when coalesce(pl.listing_status, '') <> '' then pl.listing_status
      else pl.mapping_status
    end as coverage_status,
    pl.platform_item_id,
    pl.external_variant_id,
    pl.external_sku,
    pl.shop_id,
    pl.country
  from public.platform_listings pl
  where pl.master_product_id = p.id
    and pl.platform = platform_name.platform
    and pl.deleted_at is null
  order by pl.last_seen_at desc nulls last, pl.updated_at desc
  limit 1
) latest on true
where btrim(coalesce(p.sku, '')) <> '';

grant select on public.sku_platform_coverage to authenticated;

-- Compatibility view for the existing V2 coverage dashboard.
-- Replaces the older five-platform view with the SKU-first supported set:
-- Shopee/Joom/Qoo10/eBay. Alibaba is intentionally omitted.
create or replace view public.platform_listing_coverage as
select
  c.master_product_id as product_id,
  p.sku,
  p.product_name,
  p.option_name,
  p.lifecycle_state,
  c.platform,
  (case when c.coverage_status in ('listed', 'mapped', 'mapped_global') then 1 else 0 end)::bigint as listed_count,
  (case when c.coverage_status in ('draft', 'pending') then 1 else 0 end)::bigint as pending_count,
  (case when c.coverage_status in ('error', 'rejected', 'banned') then 1 else 0 end)::bigint as error_count,
  (case when c.coverage_status <> 'not_listed' then 1 else 0 end)::bigint as total_count,
  case
    when c.coverage_status in ('listed', 'mapped', 'mapped_global') then 'mapped'
    when c.coverage_status in ('draft', 'pending') then 'pending'
    when c.coverage_status in ('error', 'rejected', 'banned') then 'error'
    else 'missing'
  end as coverage_status,
  case
    when c.coverage_status = 'not_listed' then '{}'::jsonb
    else jsonb_build_object(
      coalesce(c.country, c.shop_id, c.platform),
      jsonb_build_object(
        'status', c.coverage_status,
        'platform_item_id', c.platform_item_id,
        'external_variant_id', c.external_variant_id,
        'external_sku', c.external_sku,
        'shop_id', c.shop_id,
        'country', c.country
      )
    )
  end as per_shop_detail
from public.sku_platform_coverage c
join public.products p on p.id = c.master_product_id;

grant select on public.platform_listing_coverage to authenticated;

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
      last_seen_at
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
      now()
    ) returning id into v_id;
  exception when unique_violation then
    -- Race-safe retry for expression/partial unique indexes such as
    -- platform_listings_dispatcher_uniq / platform_listings_remote_uniq.
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

revoke all on function public.absorb_platform_sku_lookup(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb
) from public;

revoke all on function public.absorb_platform_sku_lookup(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb
) from authenticated;

grant execute on function public.absorb_platform_sku_lookup(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb
) to service_role;
