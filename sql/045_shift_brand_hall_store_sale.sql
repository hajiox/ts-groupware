insert into public.gw_shift_ec_sales (
  id,
  label,
  color,
  start_time,
  end_time,
  sort_order,
  is_active
)
values (
  'brand_hall_store_sale',
  'ブランド館店舗SALE',
  'red',
  null,
  null,
  5,
  true
)
on conflict (id) do update
set
  label = excluded.label,
  color = excluded.color,
  sort_order = excluded.sort_order,
  is_active = true,
  updated_at = now();
