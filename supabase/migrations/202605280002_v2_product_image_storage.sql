-- V2 master product image attachments.
-- Operators create the final product/option images directly, then attach files
-- during master-data creation. The public URL is stored in products.main_image.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "product images public read" on storage.objects;
create policy "product images public read"
  on storage.objects for select
  to public
  using (bucket_id = 'product-images');

drop policy if exists "product images authenticated insert" on storage.objects;
create policy "product images authenticated insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'product-images');

drop policy if exists "product images authenticated update" on storage.objects;
create policy "product images authenticated update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'product-images')
  with check (bucket_id = 'product-images');

drop policy if exists "product images authenticated delete" on storage.objects;
create policy "product images authenticated delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'product-images');
