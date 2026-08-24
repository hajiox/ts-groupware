begin;

create temporary table paid_leave_transition_lump_targets (
  normalized_name text primary key,
  adjustment_days numeric(5,2) not null
) on commit drop;

insert into paid_leave_transition_lump_targets (
  normalized_name,
  adjustment_days
)
values
  ('藤田香織', 1.0),
  ('渡部瞳', 2.0),
  ('武藤志保', 8.0),
  ('石井瑞季', 9.0);

create temporary table paid_leave_transition_employees on commit drop as
select
  employees.id as employee_id,
  employees.user_id,
  targets.normalized_name,
  targets.adjustment_days
from public.gw_payroll_employees employees
join paid_leave_transition_lump_targets targets
  on targets.normalized_name = regexp_replace(
    coalesce(employees.real_name, employees.display_name, ''),
    '[[:space:]　]',
    '',
    'g'
  )
where employees.payroll_status = 'active';

do $$
declare
  target_count integer;
begin
  select count(*) into target_count
  from paid_leave_transition_employees;

  if target_count <> 4 then
    raise exception
      '有給移行調整の一括付与対象は4名の想定ですが、%名見つかりました',
      target_count;
  end if;
end
$$;

create temporary table paid_leave_transition_lump_changes on commit drop as
select
  lots.id,
  lots.employee_id,
  lots.user_id,
  lots.granted_days as previous_days,
  employees.adjustment_days,
  lots.source_key as previous_source_key
from public.gw_paid_leave_grant_lots lots
join paid_leave_transition_employees employees
  on employees.employee_id = lots.employee_id
where lots.grant_date = date '2026-08-01'
  and lots.grant_status = 'granted'
  and lots.source_key like 'paid-leave-transition-monthly-2026:%';

do $$
declare
  target_count integer;
begin
  select count(*) into target_count
  from paid_leave_transition_lump_changes;

  if target_count <> 4 then
    raise exception
      '8月1日の有給移行調整ロットは4件の想定ですが、%件見つかりました',
      target_count;
  end if;
end
$$;

update public.gw_paid_leave_grant_lots lots
set
  granted_days = changes.adjustment_days,
  source_key = 'paid-leave-transition-lump-sum-2026:'
    || changes.employee_id::text,
  notes = '8月更新から入社日基準への移行調整休暇（2026年8月1日に一括付与）',
  updated_at = now()
from paid_leave_transition_lump_changes changes
where lots.id = changes.id;

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
  changes.employee_id,
  changes.user_id,
  'grant_lot',
  changes.id,
  'update',
  'system',
  'paid_leave_transition_lump_sum_2026',
  jsonb_build_object(
    'grant_date', date '2026-08-01',
    'granted_days', changes.previous_days,
    'source_key', changes.previous_source_key,
    'grant_status', 'granted'
  ),
  jsonb_build_object(
    'grant_date', date '2026-08-01',
    'granted_days', changes.adjustment_days,
    'source_key', 'paid-leave-transition-lump-sum-2026:'
      || changes.employee_id::text,
    'grant_status', 'granted'
  )
from paid_leave_transition_lump_changes changes;

create temporary table paid_leave_transition_future_voids on commit drop as
select
  lots.id,
  lots.employee_id,
  lots.user_id,
  lots.grant_date,
  lots.granted_days,
  lots.source_key,
  lots.notes
from public.gw_paid_leave_grant_lots lots
join paid_leave_transition_employees employees
  on employees.employee_id = lots.employee_id
where lots.grant_date > date '2026-08-01'
  and lots.grant_status = 'granted'
  and lots.source_key like 'paid-leave-transition-monthly-2026:%';

update public.gw_paid_leave_grant_lots lots
set
  grant_status = 'voided',
  voided_at = now(),
  notes = concat_ws(
    E'\n',
    nullif(lots.notes, ''),
    '移行調整日数を2026年8月1日に一括付与する運用へ変更したため無効化。'
  ),
  updated_at = now()
from paid_leave_transition_future_voids voids
where lots.id = voids.id;

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
  voids.employee_id,
  voids.user_id,
  'grant_lot',
  voids.id,
  'void',
  'system',
  'paid_leave_transition_lump_sum_2026',
  jsonb_build_object(
    'grant_date', voids.grant_date,
    'granted_days', voids.granted_days,
    'source_key', voids.source_key,
    'grant_status', 'granted',
    'notes', voids.notes
  ),
  jsonb_build_object(
    'grant_date', voids.grant_date,
    'granted_days', voids.granted_days,
    'source_key', voids.source_key,
    'grant_status', 'voided'
  )
from paid_leave_transition_future_voids voids;

update public.gw_paid_leave_profiles profiles
set
  notes = regexp_replace(
    coalesce(profiles.notes, ''),
    '2026年移行調整:[^\n]*',
    format(
      '2026年移行調整: 基準日までの調整分%s日を2026-08-01に一括付与',
      employees.adjustment_days
    ),
    'g'
  ),
  updated_at = now()
from paid_leave_transition_employees employees
where profiles.employee_id = employees.employee_id;

commit;
