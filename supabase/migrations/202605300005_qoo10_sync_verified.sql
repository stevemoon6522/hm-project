-- Enable Qoo10 read-only SKU sync now that qoo10-bridge can verify seller/option SKU lookups.
-- Listing creation/publish capabilities remain blocked by the adapter; this only
-- allows platform-publish capability='sync' to absorb existing Qoo10 listings.

update public.platform_capabilities
set auth_verified = true,
    evidence_note = coalesce(evidence_note, '') || case when coalesce(evidence_note, '') = '' then '' else E'\n' end || 'Qoo10 sync verified via qoo10-bridge lookup-sku inventory scan.'
where platform = 'qoo10'
  and capability = 'sync';
