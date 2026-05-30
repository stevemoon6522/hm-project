-- Ensure the virtual Joom fee row exists in environments that were created
-- before JM was added to the base schema.
insert into public.country_settings (
  country_code,
  name,
  currency,
  exchange_rate,
  pg_fee,
  sales_fee,
  fsp_fee,
  other_fee,
  settlement_fee,
  gst,
  fsp_ccb,
  import_duty,
  fixed_service_fee,
  purchase_vat
) values (
  'JM',
  'Joom (Global)',
  'USD',
  1380,
  0.00,
  15.00,
  0.00,
  0.00,
  0.00,
  0.00,
  0.00,
  0.00,
  0.00,
  9.10
)
on conflict (country_code) do update set
  name = excluded.name,
  currency = excluded.currency,
  exchange_rate = excluded.exchange_rate,
  pg_fee = excluded.pg_fee,
  sales_fee = excluded.sales_fee,
  fsp_fee = excluded.fsp_fee,
  other_fee = excluded.other_fee,
  settlement_fee = excluded.settlement_fee,
  gst = excluded.gst,
  fsp_ccb = excluded.fsp_ccb,
  import_duty = excluded.import_duty,
  fixed_service_fee = excluded.fixed_service_fee,
  purchase_vat = excluded.purchase_vat;
