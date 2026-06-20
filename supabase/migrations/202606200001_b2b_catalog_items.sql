-- B2B catalog source-of-truth for buyer-facing Google Sheet mirrors.
-- Internal StarOneMall URL/pno is stored here for matching, but hidden from
-- public buyer tabs by the sync API.

create table if not exists public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  artist text not null,
  release_title text not null,
  edition text not null default '',
  category text not null default 'Album',
  availability_status text not null default 'Available',
  retail_price_krw numeric not null default 0,
  supply_note text not null default '',
  main_image_url text,
  staronemall_url text not null,
  staronemall_pno text not null,
  source_option_key text not null default '',
  raw_title text,
  raw_payload jsonb not null default '{}'::jsonb,
  manual_discontinued boolean not null default false,
  last_crawled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_items_category_check
    check (category in ('Album', 'Photocard', 'MD')),
  constraint catalog_items_availability_check
    check (availability_status in ('Available', 'Restock Watch', 'Inquiry Only')),
  constraint catalog_items_price_check
    check (retail_price_krw >= 0),
  constraint catalog_items_staronemall_pno_required
    check (length(btrim(staronemall_pno)) > 0)
);

create unique index if not exists catalog_items_source_option_uniq
  on public.catalog_items (staronemall_pno, source_option_key);

create index if not exists catalog_items_artist_release_idx
  on public.catalog_items (lower(artist), lower(release_title), lower(edition));

create index if not exists catalog_items_availability_idx
  on public.catalog_items (availability_status, updated_at desc);

create or replace function public.set_catalog_items_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists catalog_items_set_updated_at on public.catalog_items;
create trigger catalog_items_set_updated_at
before update on public.catalog_items
for each row execute function public.set_catalog_items_updated_at();

alter table public.catalog_items enable row level security;

drop policy if exists "catalog_items readable by authenticated" on public.catalog_items;
create policy "catalog_items readable by authenticated"
  on public.catalog_items for select
  to authenticated
  using (true);

drop policy if exists "catalog_items writable by authenticated" on public.catalog_items;
create policy "catalog_items writable by authenticated"
  on public.catalog_items for insert
  to authenticated
  with check (true);

drop policy if exists "catalog_items updatable by authenticated" on public.catalog_items;
create policy "catalog_items updatable by authenticated"
  on public.catalog_items for update
  to authenticated
  using (true)
  with check (true);

grant select, insert, update on public.catalog_items to authenticated;
