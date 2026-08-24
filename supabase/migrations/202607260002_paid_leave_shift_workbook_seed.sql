begin;

with workbook_rows (
  department,
  name_pattern,
  worked_days,
  worked_minutes,
  average_minutes,
  details
) as (
  values
    ('製造', '芳賀', 78::numeric, 35280, 452, '{"display_name":"芳賀","classification":"long","main_pattern":"08:00-17:00","source_appearances":78}'::jsonb),
    ('製造', '橋本', 75::numeric, 35280, 470, '{"display_name":"橋本","classification":"long","main_pattern":"08:30-17:30","source_appearances":75}'::jsonb),
    ('製造', '本名', 88::numeric, 35520, 404, '{"display_name":"本名","classification":"long","main_pattern":"08:30-16:15","source_appearances":88}'::jsonb),
    ('製造', '山口', 80::numeric, 32910, 411, '{"display_name":"山口（製造）","classification":"long","main_pattern":"08:30-16:15","source_appearances":84,"unknown_end_times":4}'::jsonb),
    ('フロア', '松崎', 54::numeric, 19440, 360, '{"display_name":"松崎","classification":"short","main_pattern":"早番・遅番","source_appearances":54}'::jsonb),
    ('フロア', '猪俣', 63::numeric, 22680, 360, '{"display_name":"猪俣","classification":"short","main_pattern":"早番・遅番","source_appearances":63}'::jsonb),
    ('フロア', '森', 57::numeric, 20580, 361, '{"display_name":"森","classification":"short","main_pattern":"早番・遅番","source_appearances":57}'::jsonb),
    ('フロア', '山口', 48::numeric, 17220, 359, '{"display_name":"山口（フロア）","classification":"short","main_pattern":"10:00-16:30","source_appearances":48}'::jsonb),
    ('製造', '呉東', 66::numeric, 24300, 368, '{"display_name":"呉東","classification":"short","main_pattern":"09:00-15:30","source_appearances":68,"unknown_end_times":2}'::jsonb),
    ('製造', '鈴木', 15::numeric, 5400, 360, '{"display_name":"鈴木","classification":"short","main_pattern":"09:00-15:30","source_appearances":15}'::jsonb),
    ('製造', '小島', 74::numeric, 22200, 300, '{"display_name":"小島","classification":"short","main_pattern":"12:30-17:30","source_appearances":74}'::jsonb),
    ('製造', '舟木', 73::numeric, 25920, 355, '{"display_name":"舟木","classification":"short","main_pattern":"09:00-15:30","source_appearances":73}'::jsonb),
    ('製造', '小桧山', 51::numeric, 18360, 360, '{"display_name":"小桧山","classification":"short","main_pattern":"09:00-15:30","source_appearances":51}'::jsonb),
    ('道の駅', '(生井|内海)', 76::numeric, 23700, 312, '{"display_name":"生井・内海","classification":"short","main_pattern":"11:00-15:00","source_appearances":76,"name_alias":"生井→内海"}'::jsonb),
    ('道の駅', '角田', 64::numeric, 13380, 209, '{"display_name":"角田","classification":"short","main_pattern":"11:00-14:00","source_appearances":64}'::jsonb),
    ('道の駅', '新田', 12::numeric, 2700, 225, '{"display_name":"新田","classification":"short","main_pattern":"11:00-15:00","source_appearances":12,"first_appearance":"2026-07-16"}'::jsonb)
)
insert into public.gw_paid_leave_average_snapshots (
  employee_id,
  user_id,
  reference_start,
  reference_end,
  source_type,
  calculation_purpose,
  worked_days,
  worked_minutes,
  wage_total,
  average_minutes_per_worked_day,
  average_wage_per_worked_day,
  hourly_rate_snapshot,
  is_reference_only,
  source_key,
  details
)
select
  employees.id,
  employees.user_id,
  date '2026-04-16',
  date '2026-07-31',
  'shift_workbook',
  'reference_display',
  workbook_rows.worked_days,
  workbook_rows.worked_minutes,
  0,
  workbook_rows.average_minutes,
  null,
  null,
  true,
  'shift-workbook-20260416-20260731:' || employees.id::text,
  workbook_rows.details || jsonb_build_object(
    'source_file', 'シフト表2026 のコピー.xlsx',
    'wage_data_present', false,
    'break_rule_explicit', false
  )
from workbook_rows
join public.gw_payroll_employees employees
  on employees.department = workbook_rows.department
  and regexp_replace(
    coalesce(employees.real_name, employees.display_name),
    '[[:space:]　]',
    '',
    'g'
  ) ~ workbook_rows.name_pattern
where employees.payroll_status = 'active'
on conflict (
  employee_id,
  reference_start,
  reference_end,
  source_type,
  calculation_purpose
)
do update
set user_id = excluded.user_id,
    worked_days = excluded.worked_days,
    worked_minutes = excluded.worked_minutes,
    average_minutes_per_worked_day = excluded.average_minutes_per_worked_day,
    details = excluded.details,
    calculated_at = now();

commit;
