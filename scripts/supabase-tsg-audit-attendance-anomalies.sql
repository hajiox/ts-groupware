-- TSG attendance anomaly details (read-only)

with punch_days as (
  select
    p.user_id,
    p.work_date,
    count(*) filter (where p.punch_type = 'clock_in') as clock_in_count,
    count(*) filter (where p.punch_type = 'clock_out') as clock_out_count,
    string_agg(
      concat(
        to_char(p.punched_at at time zone 'Asia/Tokyo', 'HH24:MI'),
        '/',
        p.punch_type,
        '/',
        coalesce(p.source_type, '-')
      ),
      ', '
      order by p.punched_at
    ) as punches
  from public.gw_attendance_punches p
  where p.is_voided = false
  group by p.user_id, p.work_date
),
anomalies as (
  select *
  from punch_days
  where (
      work_date < (now() at time zone 'Asia/Tokyo')::date
      and work_date >= date '2026-06-16'
      and (clock_in_count = 0 or clock_out_count = 0 or clock_in_count <> clock_out_count)
    )
    or clock_in_count > 1
    or clock_out_count > 1
)
select
  coalesce(e.real_name, e.display_name, u.real_name, u.display_name, '不明') as employee_name,
  a.work_date,
  a.clock_in_count,
  a.clock_out_count,
  a.punches
from anomalies a
left join public.gw_payroll_employees e
  on e.user_id = a.user_id and e.payroll_status = 'active'
left join public.gw_users u on u.id = a.user_id
order by a.work_date desc, employee_name;
