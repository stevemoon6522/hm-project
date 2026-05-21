-- D2 hot-fix: correct platform_capabilities rows that were wrong in 202605200024.
--
-- Changes:
--   update_images docs_ready=false: the shopee-bridge V2 mutation pipeline
--     (runV2MutationAction, index.ts:1112-1142) does NOT wire image_id_list.
--     Marking docs_ready=true was a false positive — gate 3 would allow the call
--     through but the bridge would fail with PLATFORM_VALIDATION_ERROR.
--     Flip to false so gate 3 refuses the capability cleanly.
--     Re-enable when bridge extension is complete (see TODO in adapters/shopee.ts).

update public.platform_capabilities
set
  docs_ready    = false,
  evidence_note = 'D2 hot-fix: bridge V2 pipeline does not wire image_id_list; adapter returns CAPABILITY_UNSUPPORTED. Re-enable when bridge extension lands.',
  updated_at    = now()
where platform   = 'shopee'
  and capability = 'update_images';
