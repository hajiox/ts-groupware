begin;

create temporary table fujita_paid_leave_target on commit drop as
select
  employees.id as employee_id,
  employees.user_id
from public.gw_payroll_employees employees
where employees.payroll_status = 'active'
  and regexp_replace(
    coalesce(employees.real_name, employees.display_name, ''),
    '[[:space:]　]',
    '',
    'g'
  ) = '藤田香織';

update public.gw_payroll_employees employees
set
  hire_date = date '2012-02-12',
  raw_payload = coalesce(employees.raw_payload, '{}'::jsonb) || jsonb_build_object(
    'hire_date_corrected_at', now(),
    'hire_date_corrected_source', 'user_confirmation_2026-07-26',
    'previous_hire_date', employees.hire_date
  ),
  updated_at = now()
from fujita_paid_leave_target target
where employees.id = target.employee_id;

with voided as (
  update public.gw_paid_leave_grant_lots lots
  set
    grant_status = 'voided',
    notes = concat_ws(
      E'\n',
      nullif(lots.notes, ''),
      '入社日を2012年2月12日に訂正したため、個人基準日後となる移行調整付与を無効化。'
    )
  from fujita_paid_leave_target target
  where lots.employee_id = target.employee_id
    and lots.grant_date in (date '2026-09-01', date '2026-10-01')
    and lots.source_key like 'paid-leave-transition-monthly-2026:%'
    and lots.grant_status <> 'voided'
  returning
    lots.id,
    lots.employee_id,
    lots.user_id,
    lots.grant_date,
    lots.granted_days,
    lots.source_key
)
insert into public.gw_paid_leave_audit_logs (
  employee_id,
  user_id,
  entity_type,
  entity_id,
  action,
  actor_type,
  source,
  before_payload,
  after_payload
)
select
  voided.employee_id,
  voided.user_id,
  'grant_lot',
  voided.id,
  'void',
  'system',
  'fujita_hire_date_correction_2026',
  jsonb_build_object(
    'grant_date', voided.grant_date,
    'granted_days', voided.granted_days,
    'grant_status', 'granted',
    'source_key', voided.source_key
  ),
  jsonb_build_object(
    'grant_date', voided.grant_date,
    'granted_days', voided.granted_days,
    'grant_status', 'voided',
    'source_key', voided.source_key
  )
from voided;

update public.gw_paid_leave_profiles profiles
set
  grant_schedule_kind = 'standard',
  scheduled_week_days = 5,
  next_grant_date = date '2026-08-12',
  projected_grant_days = 20,
  projection_calculated_at = now(),
  notes = concat_ws(
    E'\n',
    nullif(profiles.notes, ''),
    '2026-07-26入社日訂正: 2012-02-12。次回基準日2026-08-12、付与見込み20日、移行調整は2026-08-01の1日のみ。'
  ),
  updated_at = now()
from fujita_paid_leave_target target
where profiles.employee_id = target.employee_id;

commit;
