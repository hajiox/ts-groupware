-- TSG core integrity audit (read-only)
-- Returns only aggregate counts so employee details are not exposed in logs.

with
locked_periods as (
  select id, department, start_date, end_date
  from public.gw_shift_periods
  where coalesce(is_test_mode, false) = false
    and status in ('confirmed', 'exported', 'archived')
),
missing_paid_leave_sync as (
  select r.id
  from public.gw_shift_requests r
  join locked_periods p on p.id = r.period_id
  where coalesce(r.is_test, false) = false
    and r.request_type in ('paid_leave_full', 'paid_leave_half')
    and not exists (
      select 1
      from public.gw_paid_leave_requests l
      where l.source_key = concat('shift:', r.period_id, ':', r.user_id, ':', r.work_date)
    )
),
active_leave as (
  select *
  from public.gw_paid_leave_requests
  where request_status in ('draft', 'submitted', 'approved', 'consumed')
    and coalesce((raw_payload ->> 'opening_balance_adjustment')::boolean, false) = false
),
approved_leave as (
  select *
  from public.gw_paid_leave_requests
  where request_status in ('approved', 'consumed')
    and coalesce((raw_payload ->> 'opening_balance_adjustment')::boolean, false) = false
),
allocated_days as (
  select request_id, sum(allocated_days)::numeric as allocated_days
  from public.gw_paid_leave_consumption_allocations
  where voided_at is null
  group by request_id
),
punch_days as (
  select
    user_id,
    work_date,
    count(*) filter (where punch_type = 'clock_in') as clock_in_count,
    count(*) filter (where punch_type = 'clock_out') as clock_out_count,
    bool_and(source_type = 'import') as imports_only
  from public.gw_attendance_punches
  where is_voided = false
  group by user_id, work_date
),
overlapping_periods as (
  select p1.id as left_id, p2.id as right_id
  from locked_periods p1
  join locked_periods p2
    on p1.department = p2.department
   and p1.id < p2.id
   and p1.start_date <= p2.end_date
   and p2.start_date <= p1.end_date
),
current_profiles as (
  select distinct employee_id
  from public.gw_payroll_calculation_profiles
  where effective_from <= current_date
    and (effective_to is null or effective_to >= current_date)
),
metrics as (
  select 'missing_paid_leave_sync'::text as metric, count(*)::bigint as value
  from missing_paid_leave_sync
  union all
  select 'invalid_paid_leave_snapshots', count(*)
  from active_leave
  where coalesce(scheduled_minutes_snapshot, 0) <= 0
     or coalesce(payable_minutes_snapshot, 0) <= 0
  union all
  select 'paid_leave_allocation_mismatches', count(*)
  from approved_leave l
  left join allocated_days a on a.request_id = l.id
  where abs(coalesce(a.allocated_days, 0) - case when l.leave_unit = 'full_day' then 1 else 0.5 end) > 0.001
  union all
  select 'broken_paid_leave_assignments', count(*)
  from active_leave l
  where l.shift_assignment_id is not null
    and not exists (
      select 1 from public.gw_shift_assignments a where a.id = l.shift_assignment_id
    )
  union all
  select 'full_day_leave_punch_conflicts', count(*)
  from approved_leave l
  where l.leave_unit = 'full_day'
    and exists (
      select 1
      from public.gw_attendance_punches p
      where p.user_id = l.user_id
        and p.work_date = l.leave_date
        and p.is_voided = false
    )
  union all
  select 'overlapping_confirmed_shift_periods', count(*)
  from overlapping_periods
  union all
  select 'attendance_punches_without_employee', count(*)
  from public.gw_attendance_punches
  where is_voided = false and employee_id is null
  union all
  select 'historical_unpaired_punch_days', count(*)
  from punch_days
  where work_date < (now() at time zone 'Asia/Tokyo')::date
    and work_date >= date '2026-06-16'
    and (clock_in_count = 0 or clock_out_count = 0 or clock_in_count <> clock_out_count)
  union all
  select 'multiple_session_punch_days', count(*)
  from punch_days
  where clock_in_count > 1 or clock_out_count > 1
  union all
  select 'active_employees_without_payroll_profile', count(*)
  from public.gw_payroll_employees e
  where e.payroll_status = 'active'
    and regexp_replace(coalesce(e.real_name, e.display_name, ''), '[[:space:]　]', '', 'g') <> 'TSG君'
    and not exists (select 1 from current_profiles p where p.employee_id = e.id)
  union all
  select 'duplicate_active_employee_user_links', count(*)
  from (
    select user_id
    from public.gw_payroll_employees
    where payroll_status = 'active' and user_id is not null
    group by user_id
    having count(*) > 1
  ) duplicated
  union all
  select 'orphan_group_memberships', count(*)
  from public.gw_group_members m
  where not exists (select 1 from public.gw_users u where u.id = m.user_id)
     or not exists (select 1 from public.gw_groups g where g.id = m.group_id)
)
select
  metric,
  value,
  case when value = 0 then 'ok' else 'review' end as state
from metrics
order by metric;
