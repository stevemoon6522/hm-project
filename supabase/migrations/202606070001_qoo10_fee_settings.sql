-- Qoo10 JP virtual fee row for SD V2 fee settings and price previews.
-- Operating assumption from 2026-06-07:
-- exchange_rate 9.1 KRW/JPY, category fee 11%, PRE ORDER fee 2%,
-- Megawari event fee 1%; total marketplace fee = 14%.

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
  'Q10',
  'Qoo10 Japan',
  'JPY',
  9.1,
  0,
  11,
  2,
  1,
  0,
  0,
  0,
  0,
  0,
  0
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
