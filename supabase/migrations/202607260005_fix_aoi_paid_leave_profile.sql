begin;

update public.gw_payroll_employees
set
  work_style = 'regular_5d_8h',
  raw_payload = coalesce(raw_payload, '{}'::jsonb) || jsonb_build_object(
    'work_style_verified_at', now(),
    'work_style_verified_source', 'paid_leave_audit_2026-07-26'
  ),
  updated_at = now()
where employee_code = '146'
  and payroll_status = 'active';

update public.gw_paid_leave_grant_lots lots
set
  granted_days = 11,
  grant_status = 'granted',
  scheduled_week_days = 5,
  grant_source = 'initial_company_assumption',
  initial_assumption = true,
  expires_on = date '2028-08-01',
  notes = '制度開始時のみなし付与（2026年8月1日）。5日正社員として確認済み。'
from public.gw_payroll_employees employees
where employees.id = lots.employee_id
  and employees.employee_code = '146'
  and lots.grant_date = date '2026-08-01'
  and lots.grant_status <> 'voided';

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
  employees.id,
  employees.user_id,
  date '2026-08-01',
  date '2028-08-01',
  11,
  'initial_company_assumption',
  'granted',
  18,
  5,
  true,
  'paid-leave-system-opening-2026:' || employees.id::text,
  '制度開始時のみなし付与（2026年8月1日）。5日正社員として確認済み。'
from public.gw_payroll_employees employees
where employees.employee_code = '146'
  and employees.payroll_status = 'active'
  and employees.user_id is not null
  and not exists (
    select 1
    from public.gw_paid_leave_grant_lots lots
    where lots.employee_id = employees.id
      and lots.grant_date = date '2026-08-01'
      and lots.grant_status <> 'voided'
  )
on conflict (source_key) where source_key is not null do nothing;

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
  employees.id,
  employees.user_id,
  'standard',
  5,
  date '2027-06-17',
  12,
  now(),
  '佐藤葵（フロア）は5日正社員として確認済み。'
from public.gw_payroll_employees employees
where employees.employee_code = '146'
  and employees.payroll_status = 'active'
on conflict (employee_id) do update
set
  user_id = excluded.user_id,
  grant_schedule_kind = 'standard',
  scheduled_week_days = 5,
  next_grant_date = date '2027-06-17',
  projected_grant_days = 12,
  projection_calculated_at = now(),
  notes = concat_ws(
    E'\n',
    nullif(public.gw_paid_leave_profiles.notes, ''),
    '佐藤葵（フロア）は5日正社員として確認済み。'
  ),
  updated_at = now();

commit;
