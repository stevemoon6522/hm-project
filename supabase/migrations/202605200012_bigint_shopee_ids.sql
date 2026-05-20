-- Shopee Global/Shop IDs exceed signed 32-bit integer range.
-- Keep this idempotent because some columns may already be bigint in newer DBs.

do $$
declare
  column_spec record;
begin
  for column_spec in
    select *
    from (values
      ('products', 'shopee_item_id'),
      ('products', 'global_model_id'),
      ('product_shopee_listings', 'global_item_id'),
      ('product_shopee_listings', 'global_model_id'),
      ('product_shopee_listings', 'shop_id'),
      ('product_shopee_listings', 'shop_item_id'),
      ('product_shopee_listings', 'shop_model_id'),
      ('shopee_shops', 'shop_id'),
      ('shopee_shops', 'merchant_id')
    ) as columns(table_name, column_name)
  loop
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = column_spec.table_name
        and column_name = column_spec.column_name
        and data_type <> 'bigint'
    ) then
      execute format(
        'alter table public.%I alter column %I type bigint using nullif(%I::text, '''')::bigint',
        column_spec.table_name,
        column_spec.column_name,
        column_spec.column_name
      );
    end if;
  end loop;
end $$;
