begin;

alter table public.gw_paid_leave_requests
  drop constraint if exists gw_paid_leave_requests_half_day_check;

alter table public.gw_paid_leave_requests
  add constraint gw_paid_leave_requests_half_day_check
  check (
    leave_unit = 'full_day'
    or scheduled_minutes_snapshot is null
    or payable_minutes_snapshot is null
    or payable_minutes_snapshot <= scheduled_minutes_snapshot
    or (
      wage_method = 'ordinary_wage'
      and coalesce(raw_payload ->> 'wage_basis', '') = 'three_month_average_hours'
    )
  );

comment on constraint gw_paid_leave_requests_half_day_check
  on public.gw_paid_leave_requests is
  'Half-day wage minutes based on a three-month average may exceed the actual half-day shift minutes. Other wage bases retain the scheduled-minute limit.';

commit;
