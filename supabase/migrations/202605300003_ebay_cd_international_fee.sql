-- Align the virtual eBay EX fee row with current operating assumptions.
-- CD/Music has the highest commonly used category fee, so use it as the
-- conservative default: Final Value Fee 15.3% + International Fee 1.45%.
-- Other eBay fee buckets remain 0 because the dashboard's eBay tab models
-- only these two percentage fees for now.

update public.country_settings
set
  sales_fee = 15.3,
  pg_fee = 1.45,
  fsp_fee = 0,
  other_fee = 0,
  settlement_fee = 0,
  gst = 0,
  fsp_ccb = 0,
  import_duty = 0,
  fixed_service_fee = 0
where country_code = 'EX';
