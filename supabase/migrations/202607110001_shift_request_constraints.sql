alter table public.gw_shift_request_submissions
  add column if not exists max_work_days integer,
  add column if not exists target_work_days integer,
  add column if not exists min_days_off integer,
  add column if not exists max_consecutive_days integer;

alter table public.gw_shift_request_submissions
  drop constraint if exists gw_shift_request_submissions_max_work_days_check,
  drop constraint if exists gw_shift_request_submissions_target_work_days_check,
  drop constraint if exists gw_shift_request_submissions_min_days_off_check,
  drop constraint if exists gw_shift_request_submissions_max_consecutive_days_check;

alter table public.gw_shift_request_submissions
  add constraint gw_shift_request_submissions_max_work_days_check
    check (max_work_days is null or max_work_days between 0 and 90),
  add constraint gw_shift_request_submissions_target_work_days_check
    check (target_work_days is null or target_work_days between 0 and 90),
  add constraint gw_shift_request_submissions_min_days_off_check
    check (min_days_off is null or min_days_off between 0 and 90),
  add constraint gw_shift_request_submissions_max_consecutive_days_check
    check (max_consecutive_days is null or max_consecutive_days between 1 and 90);

comment on column public.gw_shift_request_submissions.max_work_days is 'Maximum days the employee can work during this shift period.';
comment on column public.gw_shift_request_submissions.target_work_days is 'Preferred target work days during this shift period.';
comment on column public.gw_shift_request_submissions.min_days_off is 'Minimum requested days off during this shift period.';
comment on column public.gw_shift_request_submissions.max_consecutive_days is 'Maximum consecutive work days accepted by the employee.';
