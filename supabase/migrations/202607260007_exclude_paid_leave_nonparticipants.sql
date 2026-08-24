begin;

create temporary table excluded_paid_leave_employees on commit drop as
select
  employees.id as employee_id,
  employees.user_id,
  regexp_replace(
    coalesce(employees.real_name, employees.display_name, ''),
    '[[:space:]　]',
    '',
    'g'
  ) as normalized_name
from public.gw_payroll_employees employees
where regexp_replace(
  coalesce(employees.real_name, employees.display_name, ''),
  '[[:space:]　]',
  '',
  'g'
) in ('佐藤正彦', '佐藤ちさと', 'TSG君');

with target_lots as (
  select
    lots.id,
    lots.employee_id,
    lots.user_id,
    lots.grant_date,
    lots.granted_days,
    lots.grant_status,
    lots.grant_source,
    lots.source_key
  from public.gw_paid_leave_grant_lots lots
  join excluded_paid_leave_employees excluded
    on excluded.employee_id = lots.employee_id
  where lots.grant_status <> 'voided'
),
voided_lots as (
  update public.gw_paid_leave_grant_lots lots
  set
    grant_status = 'voided',
    notes = concat_ws(
      E'\n',
      nullif(lots.notes, ''),
      '有給管理対象外のため無効化（2026-07-26）'
    ),
    updated_at = now()
  from target_lots targets
  where lots.id = targets.id
  returning lots.id
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
  targets.employee_id,
  targets.user_id,
  'grant_lot',
  targets.id,
  'void',
  'system',
  'paid_leave_exclusion_2026',
  jsonb_build_object(
    'grant_date', targets.grant_date,
    'granted_days', targets.granted_days,
    'grant_status', targets.grant_status,
    'grant_source', targets.grant_source,
    'source_key', targets.source_key
  ),
  jsonb_build_object(
    'grant_status', 'voided',
    'reason', '有給管理対象外'
  )
from target_lots targets
join voided_lots voided
  on voided.id = targets.id;

with target_requests as (
  select
    requests.id,
    requests.employee_id,
    requests.user_id,
    requests.leave_date,
    requests.leave_unit,
    requests.request_status
  from public.gw_paid_leave_requests requests
  join excluded_paid_leave_employees excluded
    on excluded.employee_id = requests.employee_id
  where requests.request_status in ('draft', 'submitted', 'approved')
),
voided_requests as (
  update public.gw_paid_leave_requests requests
  set
    request_status = 'voided',
    manager_memo = concat_ws(
      E'\n',
      nullif(requests.manager_memo, ''),
      '有給管理対象外のため無効化（2026-07-26）'
    ),
    updated_at = now()
  from target_requests targets
  where requests.id = targets.id
  returning requests.id
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
  targets.employee_id,
  targets.user_id,
  'request',
  targets.id,
  'void',
  'system',
  'paid_leave_exclusion_2026',
  jsonb_build_object(
    'leave_date', targets.leave_date,
    'leave_unit', targets.leave_unit,
    'request_status', targets.request_status
  ),
  jsonb_build_object(
    'request_status', 'voided',
    'reason', '有給管理対象外'
  )
from target_requests targets
join voided_requests voided
  on voided.id = targets.id;

update public.gw_workday_resolutions resolutions
set
  resolution_status = 'voided',
  manager_memo = concat_ws(
    E'\n',
    nullif(resolutions.manager_memo, ''),
    '有給管理対象外のため無効化（2026-07-26）'
  ),
  updated_at = now()
from excluded_paid_leave_employees excluded
where resolutions.employee_id = excluded.employee_id
  and resolutions.resolution_status in ('pending', 'employee_answered', 'reopened')
  and resolutions.resolution_type in ('paid_leave_full', 'paid_leave_half');

update public.gw_paid_leave_profiles profiles
set
  next_grant_date = null,
  projected_grant_days = 0,
  notes = concat_ws(
    E'\n',
    nullif(profiles.notes, ''),
    '有給管理対象外: 佐藤正彦・佐藤ちさと・TSG君'
  ),
  updated_at = now()
from excluded_paid_leave_employees excluded
where profiles.employee_id = excluded.employee_id;

commit;
