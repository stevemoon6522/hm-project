-- Allow authenticated operators to remove rows that should not remain in the
-- internal B2B catalog. Buyer-facing Google Sheet tabs are rebuilt from the
-- remaining catalog_items rows.

alter table public.catalog_items enable row level security;

drop policy if exists "catalog_items deletable by authenticated" on public.catalog_items;
create policy "catalog_items deletable by authenticated"
  on public.catalog_items for delete
  to authenticated
  using (true);

grant delete on public.catalog_items to authenticated;
