alter table public.gw_shift_periods
  add column if not exists is_test_mode boolean not null default false;

alter table public.gw_shift_requests
  add column if not exists is_test boolean not null default false;

alter table public.gw_shift_request_submissions
  add column if not exists is_test boolean not null default false;

create index if not exists idx_gw_shift_periods_test_mode
  on public.gw_shift_periods (is_test_mode, department, start_date);

comment on column public.gw_shift_periods.is_test_mode is 'True while admin-only random shift requests are being tested; hidden from staff APIs.';
comment on column public.gw_shift_requests.is_test is 'Admin-generated test request that must not be treated as a real staff response.';
comment on column public.gw_shift_request_submissions.is_test is 'Admin-generated test submission that must not be treated as a real staff response.';
