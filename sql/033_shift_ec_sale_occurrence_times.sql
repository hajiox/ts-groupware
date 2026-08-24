alter table public.gw_shift_requirements
  add column if not exists ec_sale_times jsonb not null default '{}'::jsonb;

comment on column public.gw_shift_requirements.ec_sale_times is
  'Per-day EC sale time overrides keyed by EC sale id: {sale_id:{start_time,end_time}}';
