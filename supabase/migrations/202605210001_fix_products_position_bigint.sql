-- V1 global search import writes negative millisecond timestamps into
-- products.position so newly added rows sort to the top.
-- Older projects still have products.position as int4, which overflows on
-- values like -1779348209706.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'products'
      and column_name = 'position'
      and data_type <> 'bigint'
  ) then
    alter table public.products
      alter column position type bigint
      using position::bigint;
  end if;
end $$;
