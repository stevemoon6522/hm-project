-- Backfill master option image URLs for rows created before the dedicated
-- products.shopee_option_image_url write path was consistently populated.

alter table public.products
  add column if not exists shopee_option_image_url text;

comment on column public.products.shopee_option_image_url is
  'Master option image URL used by marketplace option/variant publishing. Falls back from legacy main_image for grouped rows when backfilled.';

update public.products p
   set shopee_option_image_url = nullif(btrim(p.main_image), ''),
       updated_at = now()
 where nullif(btrim(coalesce(p.shopee_option_image_url, '')), '') is null
   and nullif(btrim(coalesce(p.main_image, '')), '') is not null
   and p.product_group_id is not null
   and (
     p.variation_tier_names is not null
     or p.variation_option_names is not null
     or nullif(btrim(coalesce(p.option_name, '')), '') is not null
     or exists (
       select 1
         from public.products sibling
        where sibling.product_group_id = p.product_group_id
          and sibling.id <> p.id
     )
   );
