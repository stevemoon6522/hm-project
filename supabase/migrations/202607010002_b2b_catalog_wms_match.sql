-- Store the operator-confirmed WMS inventory match for B2B catalog rows.
-- The match is internal coverage metadata; buyer-facing Sheet tabs still hide it.

alter table public.catalog_items
  add column if not exists wms_inventory_id bigint,
  add column if not exists wms_sku text,
  add column if not exists wms_matched_at timestamptz;

create index if not exists catalog_items_wms_inventory_idx
  on public.catalog_items (wms_inventory_id);
