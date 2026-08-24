alter table public.gw_shift_ec_sales
  add column if not exists start_time time without time zone,
  add column if not exists end_time time without time zone;

comment on column public.gw_shift_ec_sales.start_time is 'Optional start time displayed with this EC sale in shift notes.';
comment on column public.gw_shift_ec_sales.end_time is 'Optional end time displayed with this EC sale in shift notes.';
