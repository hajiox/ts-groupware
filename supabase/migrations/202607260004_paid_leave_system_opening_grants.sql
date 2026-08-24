begin;

update public.gw_payroll_employees
set
  hire_date = case employee_code
    when '146' then date '2025-12-11'
    when '147' then date '2024-12-17'
    when '148' then date '2019-03-01'
  end,
  raw_payload = coalesce(raw_payload, '{}'::jsonb) || jsonb_build_object(
    'hire_date_source',
    case employee_code
      when '146' then '旧労務データ: 佐藤葵（女性）社員NO141'
      when '147' then '旧労務データ: 佐藤葵（男性）社員NO125'
      when '148' then '旧労務データ: 内海美穂 社員NO68'
    end
  ),
  updated_at = now()
where employee_code in ('146', '147', '148')
  and hire_date is null;

create temporary table paid_leave_opening_targets on commit drop as
with latest_workbook as (
  select distinct on (snapshots.employee_id)
    snapshots.employee_id,
    greatest(
      1,
      least(
        5,
        round(
          snapshots.worked_days
          / greatest(1, snapshots.reference_end - snapshots.reference_start + 1)
          * 7
        )::integer
      )
    ) as weekly_days
  from public.gw_paid_leave_average_snapshots snapshots
  where snapshots.source_type = 'shift_workbook'
  order by snapshots.employee_id, snapshots.reference_end desc
),
employee_basis as (
  select
    employees.id as employee_id,
    employees.user_id,
    employees.hire_date,
    employees.work_style,
    regexp_replace(
      coalesce(employees.real_name, employees.display_name, ''),
      '[[:space:]　]',
      '',
      'g'
    ) as normalized_name,
    case
      when employees.work_style in ('regular_5d_8h', 'regular_6d_6_5h', 'full_time_part') then 5
      when employees.work_style = 'part_time_under_29_5h' then coalesce(latest_workbook.weekly_days, 4)
    end as weekly_days,
    (
      extract(year from age(date '2026-08-01', employees.hire_date))::integer * 12
      + extract(month from age(date '2026-08-01', employees.hire_date))::integer
    ) as service_months
  from public.gw_payroll_employees employees
  left join latest_workbook
    on latest_workbook.employee_id = employees.id
  where employees.payroll_status = 'active'
    and employees.user_id is not null
    and employees.hire_date is not null
    and employees.hire_date <= date '2026-08-01'
    and employees.work_style in (
      'regular_5d_8h',
      'regular_6d_6_5h',
      'part_time_under_29_5h',
      'full_time_part'
    )
    and regexp_replace(
      coalesce(employees.real_name, employees.display_name, ''),
      '[[:space:]　]',
      '',
      'g'
    ) not in ('佐藤正彦', '佐藤ちさと', 'TSG君')
),
sequenced as (
  select
    employee_basis.*,
    least(6, floor((employee_basis.service_months - 6) / 12.0)::integer) as opening_sequence,
    floor((employee_basis.service_months - 6) / 12.0)::integer + 1 as next_sequence
  from employee_basis
  where employee_basis.service_months >= 6
)
select
  sequenced.*,
  case
    when sequenced.weekly_days >= 5
      then (array[10, 11, 12, 14, 16, 18, 20])[sequenced.opening_sequence + 1]
    when sequenced.weekly_days = 4
      then (array[7, 8, 9, 10, 12, 13, 15])[sequenced.opening_sequence + 1]
    when sequenced.weekly_days = 3
      then (array[5, 6, 6, 8, 9, 10, 11])[sequenced.opening_sequence + 1]
    when sequenced.weekly_days = 2
      then (array[3, 4, 4, 5, 6, 6, 7])[sequenced.opening_sequence + 1]
    else (array[1, 2, 2, 2, 3, 3, 3])[sequenced.opening_sequence + 1]
  end::numeric(5,2) as opening_days,
  (
    sequenced.hire_date
    + make_interval(months => 6 + sequenced.next_sequence * 12)
  )::date as next_grant_date,
  case
    when sequenced.weekly_days >= 5
      then (array[10, 11, 12, 14, 16, 18, 20])[least(6, sequenced.next_sequence) + 1]
    when sequenced.weekly_days = 4
      then (array[7, 8, 9, 10, 12, 13, 15])[least(6, sequenced.next_sequence) + 1]
    when sequenced.weekly_days = 3
      then (array[5, 6, 6, 8, 9, 10, 11])[least(6, sequenced.next_sequence) + 1]
    when sequenced.weekly_days = 2
      then (array[3, 4, 4, 5, 6, 6, 7])[least(6, sequenced.next_sequence) + 1]
    else (array[1, 2, 2, 2, 3, 3, 3])[least(6, sequenced.next_sequence) + 1]
  end::numeric(5,2) as next_grant_days
from sequenced;

with inserted as (
  insert into public.gw_paid_leave_grant_lots (
    employee_id,
    user_id,
    grant_date,
    expires_on,
    granted_days,
    grant_source,
    grant_status,
    service_months,
    scheduled_week_days,
    initial_assumption,
    source_key,
    notes
  )
  select
    targets.employee_id,
    targets.user_id,
    date '2026-08-01',
    date '2028-08-01',
    targets.opening_days,
    'initial_company_assumption',
    'granted',
    6 + targets.opening_sequence * 12,
    targets.weekly_days,
    true,
    'paid-leave-system-opening-2026:' || targets.employee_id::text,
    '制度開始時みなし付与（2026年8月1日）。初回は過去出勤率を満たしたものとして付与'
  from paid_leave_opening_targets targets
  where not exists (
    select 1
    from public.gw_paid_leave_grant_lots lots
    where lots.employee_id = targets.employee_id
      and lots.grant_status = 'granted'
      and lots.granted_days > 0
  )
  on conflict (source_key) where source_key is not null do nothing
  returning id, employee_id, user_id, granted_days, source_key
)
insert into public.gw_paid_leave_audit_logs (
  employee_id,
  user_id,
  entity_type,
  entity_id,
  action,
  actor_type,
  source,
  after_payload
)
select
  inserted.employee_id,
  inserted.user_id,
  'grant_lot',
  inserted.id,
  'create',
  'system',
  'paid_leave_system_opening_2026',
  jsonb_build_object(
    'grant_date', date '2026-08-01',
    'expires_on', date '2028-08-01',
    'granted_days', inserted.granted_days,
    'source_key', inserted.source_key
  )
from inserted;

insert into public.gw_paid_leave_profiles (
  employee_id,
  user_id,
  grant_schedule_kind,
  scheduled_week_days,
  next_grant_date,
  projected_grant_days,
  projection_calculated_at,
  notes
)
select
  targets.employee_id,
  targets.user_id,
  case when targets.weekly_days >= 5 then 'standard' else 'proportional' end,
  targets.weekly_days,
  targets.next_grant_date,
  targets.next_grant_days,
  now(),
  '2026年8月1日の制度開始時みなし付与を登録'
from paid_leave_opening_targets targets
on conflict (employee_id) do update
set
  user_id = excluded.user_id,
  grant_schedule_kind = excluded.grant_schedule_kind,
  scheduled_week_days = excluded.scheduled_week_days,
  next_grant_date = excluded.next_grant_date,
  projected_grant_days = excluded.projected_grant_days,
  projection_calculated_at = excluded.projection_calculated_at,
  notes = concat_ws(
    E'\n',
    nullif(public.gw_paid_leave_profiles.notes, ''),
    '2026年8月1日の制度開始時みなし付与を登録'
  ),
  updated_at = now();

commit;
