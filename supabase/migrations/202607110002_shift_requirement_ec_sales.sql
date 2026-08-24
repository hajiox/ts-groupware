alter table public.gw_shift_requirements
  add column if not exists ec_sale_tags text[] not null default '{}'::text[];

comment on column public.gw_shift_requirements.ec_sale_tags is 'Selected EC sale identifiers shown in the daily shift notes.';
