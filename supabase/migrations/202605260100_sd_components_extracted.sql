-- staronemall Vision API — components extraction columns
-- Created: 2026-05-26
-- Author: Claude (Sonnet 4.6)
-- Adds three columns to products for Claude Vision-based component extraction.
-- All idempotent (add column if not exists).

alter table public.products
  add column if not exists components_extracted_en   text,        -- English bullet-list from Claude Vision
  add column if not exists components_extracted_at   timestamptz, -- timestamp of last extraction
  add column if not exists components_approved       integer not null default 0; -- 0=pending, 1=approved

comment on column public.products.components_extracted_en is
  'Claude Vision-extracted English components list (hyphen-prefixed lines). '
  'Populated by staronemall-vision edge function. Null = not yet extracted.';

comment on column public.products.components_extracted_at is
  'Timestamp of last Claude Vision extraction for components_extracted_en.';

comment on column public.products.components_approved is
  '0 = extracted but not yet approved by operator; 1 = approved and applied to description.';
