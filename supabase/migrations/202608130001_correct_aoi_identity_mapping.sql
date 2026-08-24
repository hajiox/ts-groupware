begin;

create temporary table aoi_identity_targets (
  identity_key text primary key,
  employee_id uuid not null,
  user_id uuid,
  employee_code text not null
) on commit drop;

insert into aoi_identity_targets (identity_key, employee_id, user_id, employee_code)
select 'floor_female', id, user_id, employee_code
from public.gw_payroll_employees
where employee_code = '146';

insert into aoi_identity_targets (identity_key, employee_id, user_id, employee_code)
select 'manufacturing_male', id, user_id, employee_code
from public.gw_payroll_employees
where employee_code = '147';

insert into aoi_identity_targets (identity_key, employee_id, user_id, employee_code)
select 'labor_male', id, user_id, employee_code
from public.gw_payroll_employees
where employee_code = '125';

insert into aoi_identity_targets (identity_key, employee_id, user_id, employee_code)
select 'labor_female', id, user_id, employee_code
from public.gw_payroll_employees
where employee_code = '141';

do $$
declare
  target_count integer;
  invalid_count integer;
begin
  select count(*) into target_count from aoi_identity_targets;
  if target_count <> 4 then
    raise exception '佐藤葵の本人確認対象は4社員行の想定ですが、%行でした', target_count;
  end if;

  select count(*) into invalid_count
  from public.gw_payroll_employees employees
  join aoi_identity_targets targets on targets.employee_id = employees.id
  where (
    targets.identity_key = 'floor_female'
    and (
      regexp_replace(coalesce(employees.real_name, employees.display_name, ''), '[[:space:]　]', '', 'g') <> '佐藤葵（フロア）'
      or employees.department is distinct from 'フロア'
      or employees.work_style is distinct from 'regular_5d_8h'
    )
  ) or (
    targets.identity_key = 'manufacturing_male'
    and (
      regexp_replace(coalesce(employees.real_name, employees.display_name, ''), '[[:space:]　]', '', 'g') <> '佐藤葵（製造）'
      or employees.department is distinct from '製造'
      or employees.work_style is distinct from 'part_time_under_29_5h'
    )
  ) or (
    targets.identity_key = 'labor_male'
    and regexp_replace(coalesce(employees.real_name, employees.display_name, ''), '[[:space:]　]', '', 'g') not like '佐藤葵%男性%'
  ) or (
    targets.identity_key = 'labor_female'
    and regexp_replace(coalesce(employees.real_name, employees.display_name, ''), '[[:space:]　]', '', 'g') not like '佐藤葵%女性%'
  );

  if invalid_count <> 0 then
    raise exception '佐藤葵の社員NO・所属・勤務形態が想定と一致しません（%行）', invalid_count;
  end if;
end
$$;

update public.gw_payroll_employees employees
set
  birth_date = date '2004-05-25',
  hire_date = date '2025-12-11',
  gender = 'female',
  department = 'フロア',
  employment_type = 'monthly',
  pay_type = 'monthly',
  work_style = 'regular_5d_8h',
  raw_payload = jsonb_set(
    coalesce(employees.raw_payload, '{}'::jsonb) || jsonb_build_object(
      'identity_verified_at', now(),
      'identity_verified_source', 'owner_confirmation_2026-08-13',
      'labor_employee_code', '141',
      'hire_date_source', '旧労務データ: 佐藤葵（女性）社員NO141'
    ),
    '{hr_profile}',
    coalesce(employees.raw_payload -> 'hr_profile', '{}'::jsonb) || jsonb_build_object(
      'payroll_name_aliases', jsonb_build_array(jsonb_build_object(
        'source_employee_id', (select employee_id from aoi_identity_targets where identity_key = 'labor_female'),
        'employee_code', '141',
        'name', '佐藤 葵（女性）',
        'source', 'labor_employee_master'
      ))
    ),
    true
  ),
  updated_at = now()
where employees.id = (
  select employee_id from aoi_identity_targets where identity_key = 'floor_female'
);

update public.gw_payroll_employees employees
set
  birth_date = date '2002-07-31',
  hire_date = date '2024-12-17',
  gender = 'male',
  department = '製造',
  employment_type = 'part_time',
  pay_type = 'hourly',
  work_style = 'part_time_under_29_5h',
  raw_payload = jsonb_set(
    coalesce(employees.raw_payload, '{}'::jsonb) || jsonb_build_object(
      'identity_verified_at', now(),
      'identity_verified_source', 'owner_confirmation_2026-08-13',
      'labor_employee_code', '125',
      'hire_date_source', '旧労務データ: 佐藤葵（男性）社員NO125'
    ),
    '{hr_profile}',
    coalesce(employees.raw_payload -> 'hr_profile', '{}'::jsonb) || jsonb_build_object(
      'payroll_name_aliases', jsonb_build_array(jsonb_build_object(
        'source_employee_id', (select employee_id from aoi_identity_targets where identity_key = 'labor_male'),
        'employee_code', '125',
        'name', '佐藤 葵（男性）',
        'source', 'labor_employee_master'
      ))
    ),
    true
  ),
  updated_at = now()
where employees.id = (
  select employee_id from aoi_identity_targets where identity_key = 'manufacturing_male'
);

update public.gw_payroll_employees employees
set
  raw_payload = jsonb_set(
    coalesce(employees.raw_payload, '{}'::jsonb),
    '{payroll_alias_of}',
    jsonb_build_object(
      'employee_id', (select employee_id from aoi_identity_targets where identity_key = 'manufacturing_male'),
      'employee_code', '147',
      'name', '佐藤 葵（製造）',
      'verified_at', now(),
      'source', 'owner_confirmation_2026-08-13'
    ),
    true
  ),
  updated_at = now()
where employees.id = (
  select employee_id from aoi_identity_targets where identity_key = 'labor_male'
);

update public.gw_payroll_employees employees
set
  raw_payload = jsonb_set(
    coalesce(employees.raw_payload, '{}'::jsonb),
    '{payroll_alias_of}',
    jsonb_build_object(
      'employee_id', (select employee_id from aoi_identity_targets where identity_key = 'floor_female'),
      'employee_code', '146',
      'name', '佐藤 葵（フロア）',
      'verified_at', now(),
      'source', 'owner_confirmation_2026-08-13'
    ),
    true
  ),
  updated_at = now()
where employees.id = (
  select employee_id from aoi_identity_targets where identity_key = 'labor_female'
);

-- Imported payroll rows and learned calculation profiles were assigned in the
-- opposite direction. A temporary employee preserves all result IDs and item
-- rows while satisfying per-period unique constraints during the swap.
insert into public.gw_payroll_employees (
  employee_code,
  display_name,
  real_name,
  payroll_status,
  employment_type,
  pay_type,
  source_key,
  raw_payload
)
values (
  '__AOI_SWAP_20260813__',
  '佐藤葵本人対応修正用',
  '佐藤葵本人対応修正用',
  'inactive',
  'unknown',
  'unknown',
  'aoi-identity-swap-2026-08-13',
  jsonb_build_object('temporary', true)
);

insert into aoi_identity_targets (identity_key, employee_id, user_id, employee_code)
select 'swap_temporary', id, user_id, employee_code
from public.gw_payroll_employees
where employee_code = '__AOI_SWAP_20260813__';

update public.gw_payroll_employee_results results
set employee_id = (select employee_id from aoi_identity_targets where identity_key = 'swap_temporary'),
    updated_at = now()
where results.payroll_run_id in (
    select runs.id from public.gw_payroll_runs runs where runs.calculation_mode = 'imported'
  )
  and (
    coalesce(results.raw_payload ->> 'employeeCode', results.raw_payload ->> 'employee_code', '') = '125'
    or coalesce(results.raw_payload ->> 'sourceEmployeeName', results.raw_payload ->> 'employee_name', '') like '%男性%'
    or results.employee_id = (select employee_id from aoi_identity_targets where identity_key = 'labor_male')
    or (
      results.employee_id = (select employee_id from aoi_identity_targets where identity_key = 'floor_female')
      and coalesce(results.raw_payload ->> 'employeeCode', results.raw_payload ->> 'employee_code', '') <> '141'
      and coalesce(results.raw_payload ->> 'sourceEmployeeName', results.raw_payload ->> 'employee_name', '') not like '%女性%'
    )
  );

update public.gw_payroll_employee_results results
set employee_id = (select employee_id from aoi_identity_targets where identity_key = 'floor_female'),
    updated_at = now()
where results.payroll_run_id in (
    select runs.id from public.gw_payroll_runs runs where runs.calculation_mode = 'imported'
  )
  and (
    coalesce(results.raw_payload ->> 'employeeCode', results.raw_payload ->> 'employee_code', '') = '141'
    or coalesce(results.raw_payload ->> 'sourceEmployeeName', results.raw_payload ->> 'employee_name', '') like '%女性%'
    or results.employee_id = (select employee_id from aoi_identity_targets where identity_key = 'labor_female')
    or results.employee_id = (select employee_id from aoi_identity_targets where identity_key = 'manufacturing_male')
  );

update public.gw_payroll_employee_results results
set employee_id = (select employee_id from aoi_identity_targets where identity_key = 'manufacturing_male'),
    updated_at = now()
where results.employee_id = (
  select employee_id from aoi_identity_targets where identity_key = 'swap_temporary'
);

-- Earlier imports left duplicate monthly profiles on both the old labor row
-- and the current TSG row. Keep one authoritative source snapshot per person
-- and month, then rebuild those learned profiles on the verified identity.
create temporary table aoi_profile_repair on commit drop as
select distinct on (candidates.identity_key, candidates.effective_from)
  candidates.identity_key,
  candidates.effective_from,
  candidates.effective_to,
  candidates.calculation_type,
  candidates.monthly_base_amount,
  candidates.hourly_rate,
  candidates.overtime_divisor,
  candidates.weekday_saturday_overtime_multiplier,
  candidates.sunday_overtime_multiplier,
  candidates.scheduled_minutes,
  candidates.public_holidays_per_month,
  candidates.paid_leave_mode,
  candidates.taxable_additions,
  candidates.deduction_snapshot,
  candidates.source_snapshot,
  candidates.verification,
  candidates.source_note,
  candidates.created_at
from (
  select
    case
      when coalesce(profiles.source_snapshot ->> 'employee_code', profiles.source_snapshot ->> 'employeeCode', '') = '125'
        or coalesce(profiles.source_snapshot ->> 'name', profiles.source_snapshot ->> 'source_employee_name', '') like '%男性%'
        or profiles.employee_id = (select employee_id from aoi_identity_targets where identity_key = 'labor_male')
        then 'manufacturing_male'
      when coalesce(profiles.source_snapshot ->> 'employee_code', profiles.source_snapshot ->> 'employeeCode', '') = '141'
        or coalesce(profiles.source_snapshot ->> 'name', profiles.source_snapshot ->> 'source_employee_name', '') like '%女性%'
        or profiles.employee_id = (select employee_id from aoi_identity_targets where identity_key = 'labor_female')
        then 'floor_female'
      when profiles.employee_id = (select employee_id from aoi_identity_targets where identity_key = 'floor_female')
        then 'manufacturing_male'
      when profiles.employee_id = (select employee_id from aoi_identity_targets where identity_key = 'manufacturing_male')
        then 'floor_female'
    end as identity_key,
    profiles.*,
    case
      when coalesce(profiles.source_snapshot ->> 'employee_code', profiles.source_snapshot ->> 'employeeCode', '') in ('125', '141') then 0
      when coalesce(profiles.source_snapshot ->> 'name', profiles.source_snapshot ->> 'source_employee_name', '') like '%男性%'
        or coalesce(profiles.source_snapshot ->> 'name', profiles.source_snapshot ->> 'source_employee_name', '') like '%女性%' then 1
      else 2
    end as identity_priority
  from public.gw_payroll_calculation_profiles profiles
  where profiles.employee_id in (
      select employee_id
      from aoi_identity_targets
      where identity_key in ('floor_female', 'manufacturing_male', 'labor_male', 'labor_female')
    )
    and (
      coalesce(profiles.source_snapshot ->> 'employee_code', profiles.source_snapshot ->> 'employeeCode', '') in ('125', '141')
      or coalesce(profiles.source_snapshot ->> 'name', profiles.source_snapshot ->> 'source_employee_name', '') like '%男性%'
      or coalesce(profiles.source_snapshot ->> 'name', profiles.source_snapshot ->> 'source_employee_name', '') like '%女性%'
      or coalesce(profiles.source_snapshot ->> 'source', '') in ('labor_payroll_zip', 'labor_result_fallback')
      or coalesce(profiles.source_note, '') like 'labor_office_inferred:%'
      or profiles.employee_id in (
        select employee_id
        from aoi_identity_targets
        where identity_key in ('labor_male', 'labor_female')
      )
    )
) candidates
where candidates.identity_key is not null
order by
  candidates.identity_key,
  candidates.effective_from,
  candidates.identity_priority,
  candidates.updated_at desc,
  candidates.id desc;

delete from public.gw_payroll_calculation_profiles profiles
where profiles.employee_id in (
    select employee_id
    from aoi_identity_targets
    where identity_key in ('floor_female', 'manufacturing_male', 'labor_male', 'labor_female')
  )
  and (
    coalesce(profiles.source_snapshot ->> 'employee_code', profiles.source_snapshot ->> 'employeeCode', '') in ('125', '141')
    or coalesce(profiles.source_snapshot ->> 'name', profiles.source_snapshot ->> 'source_employee_name', '') like '%男性%'
    or coalesce(profiles.source_snapshot ->> 'name', profiles.source_snapshot ->> 'source_employee_name', '') like '%女性%'
    or coalesce(profiles.source_snapshot ->> 'source', '') in ('labor_payroll_zip', 'labor_result_fallback')
    or coalesce(profiles.source_note, '') like 'labor_office_inferred:%'
    or profiles.employee_id in (
      select employee_id
      from aoi_identity_targets
      where identity_key in ('labor_male', 'labor_female')
    )
  );

insert into public.gw_payroll_calculation_profiles (
  employee_id,
  effective_from,
  effective_to,
  calculation_type,
  monthly_base_amount,
  hourly_rate,
  overtime_divisor,
  weekday_saturday_overtime_multiplier,
  sunday_overtime_multiplier,
  scheduled_minutes,
  public_holidays_per_month,
  paid_leave_mode,
  taxable_additions,
  deduction_snapshot,
  source_snapshot,
  verification,
  source_note,
  created_at,
  updated_at
)
select
  targets.employee_id,
  repair.effective_from,
  repair.effective_to,
  repair.calculation_type,
  repair.monthly_base_amount,
  repair.hourly_rate,
  repair.overtime_divisor,
  repair.weekday_saturday_overtime_multiplier,
  repair.sunday_overtime_multiplier,
  repair.scheduled_minutes,
  repair.public_holidays_per_month,
  repair.paid_leave_mode,
  repair.taxable_additions,
  repair.deduction_snapshot,
  repair.source_snapshot,
  repair.verification,
  repair.source_note,
  repair.created_at,
  now()
from aoi_profile_repair repair
join aoi_identity_targets targets on targets.identity_key = repair.identity_key
on conflict (employee_id, effective_from) do update
set
  effective_to = excluded.effective_to,
  calculation_type = excluded.calculation_type,
  monthly_base_amount = excluded.monthly_base_amount,
  hourly_rate = excluded.hourly_rate,
  overtime_divisor = excluded.overtime_divisor,
  weekday_saturday_overtime_multiplier = excluded.weekday_saturday_overtime_multiplier,
  sunday_overtime_multiplier = excluded.sunday_overtime_multiplier,
  scheduled_minutes = excluded.scheduled_minutes,
  public_holidays_per_month = excluded.public_holidays_per_month,
  paid_leave_mode = excluded.paid_leave_mode,
  taxable_additions = excluded.taxable_additions,
  deduction_snapshot = excluded.deduction_snapshot,
  source_snapshot = excluded.source_snapshot,
  verification = excluded.verification,
  source_note = excluded.source_note,
  updated_at = now();

do $$
declare
  floor_allocated numeric(7,2);
begin
  select coalesce(sum(allocations.allocated_days) filter (where allocations.voided_at is null), 0)
  into floor_allocated
  from public.gw_paid_leave_consumption_allocations allocations
  where allocations.employee_id = (
    select employee_id from aoi_identity_targets where identity_key = 'floor_female'
  );

  if floor_allocated > 10 then
    raise exception '佐藤葵（フロア）の有給使用済み日数%日が修正後付与10日を超えています', floor_allocated;
  end if;
end
$$;

create temporary table aoi_leave_lot_before on commit drop as
select lots.*
from public.gw_paid_leave_grant_lots lots
where lots.grant_date = date '2026-08-01'
  and lots.grant_status = 'granted'
  and lots.employee_id in (
    select employee_id
    from aoi_identity_targets
    where identity_key in ('floor_female', 'manufacturing_male')
  );

do $$
declare
  opening_lot_count integer;
  profile_count integer;
begin
  select count(*) into opening_lot_count from aoi_leave_lot_before;
  if opening_lot_count <> 2 then
    raise exception '佐藤葵2名の8月1日付与ロットは2件の想定ですが、%件でした', opening_lot_count;
  end if;

  select count(*) into profile_count
  from public.gw_paid_leave_profiles profiles
  where profiles.employee_id in (
    select employee_id
    from aoi_identity_targets
    where identity_key in ('floor_female', 'manufacturing_male')
  );
  if profile_count <> 2 then
    raise exception '佐藤葵2名の有給プロファイルは2件の想定ですが、%件でした', profile_count;
  end if;
end
$$;

update public.gw_paid_leave_grant_lots lots
set
  granted_days = 10,
  service_months = 6,
  scheduled_week_days = 5,
  notes = '制度開始時みなし付与。本人確認によりフロア女性・入社日2025-12-11・5日正社員へ修正。',
  updated_at = now()
where lots.employee_id = (
    select employee_id from aoi_identity_targets where identity_key = 'floor_female'
  )
  and lots.grant_date = date '2026-08-01'
  and lots.grant_status = 'granted';

update public.gw_paid_leave_grant_lots lots
set
  granted_days = 8,
  service_months = 18,
  scheduled_week_days = 4,
  notes = '制度開始時みなし付与。本人確認により製造男性・入社日2024-12-17・週4日相当パートへ修正。',
  updated_at = now()
where lots.employee_id = (
    select employee_id from aoi_identity_targets where identity_key = 'manufacturing_male'
  )
  and lots.grant_date = date '2026-08-01'
  and lots.grant_status = 'granted';

update public.gw_paid_leave_profiles profiles
set
  user_id = targets.user_id,
  grant_schedule_kind = 'standard',
  scheduled_week_days = 5,
  next_grant_date = date '2027-06-11',
  projected_grant_days = 11,
  projection_calculated_at = now(),
  notes = concat_ws(E'\n', nullif(profiles.notes, ''), '本人確認: フロア女性、5日正社員、入社日2025-12-11。'),
  updated_at = now()
from aoi_identity_targets targets
where targets.identity_key = 'floor_female'
  and profiles.employee_id = targets.employee_id;

update public.gw_paid_leave_profiles profiles
set
  user_id = targets.user_id,
  grant_schedule_kind = 'proportional',
  scheduled_week_days = 4,
  next_grant_date = date '2027-06-17',
  projected_grant_days = 9,
  projection_calculated_at = now(),
  notes = concat_ws(E'\n', nullif(profiles.notes, ''), '本人確認: 製造男性、週4日相当パート、入社日2024-12-17。'),
  updated_at = now()
from aoi_identity_targets targets
where targets.identity_key = 'manufacturing_male'
  and profiles.employee_id = targets.employee_id;

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
  before.employee_id,
  before.user_id,
  'grant_lot',
  before.id,
  'update',
  'system',
  'aoi_identity_correction_2026_08_13',
  jsonb_build_object(
    'granted_days', before.granted_days,
    'service_months', before.service_months,
    'scheduled_week_days', before.scheduled_week_days
  ),
  jsonb_build_object(
    'granted_days', after.granted_days,
    'service_months', after.service_months,
    'scheduled_week_days', after.scheduled_week_days
  )
from aoi_leave_lot_before before
join public.gw_paid_leave_grant_lots after on after.id = before.id
where before.granted_days is distinct from after.granted_days
   or before.service_months is distinct from after.service_months
   or before.scheduled_week_days is distinct from after.scheduled_week_days;

do $$
declare
  invalid_count integer;
begin
  select count(*) into invalid_count
  from public.gw_payroll_employees employees
  join aoi_identity_targets targets on targets.employee_id = employees.id
  where (
    targets.identity_key = 'floor_female'
    and (
      employees.birth_date is distinct from date '2004-05-25'
      or employees.hire_date is distinct from date '2025-12-11'
      or employees.gender is distinct from 'female'
      or employees.department is distinct from 'フロア'
      or employees.employment_type is distinct from 'monthly'
      or employees.pay_type is distinct from 'monthly'
      or employees.work_style is distinct from 'regular_5d_8h'
      or employees.raw_payload ->> 'labor_employee_code' is distinct from '141'
    )
  ) or (
    targets.identity_key = 'manufacturing_male'
    and (
      employees.birth_date is distinct from date '2002-07-31'
      or employees.hire_date is distinct from date '2024-12-17'
      or employees.gender is distinct from 'male'
      or employees.department is distinct from '製造'
      or employees.employment_type is distinct from 'part_time'
      or employees.pay_type is distinct from 'hourly'
      or employees.work_style is distinct from 'part_time_under_29_5h'
      or employees.raw_payload ->> 'labor_employee_code' is distinct from '125'
    )
  );
  if invalid_count <> 0 then
    raise exception '佐藤葵2名の最終人事マスタ検証に失敗しました（%行）', invalid_count;
  end if;

  select count(*) into invalid_count
  from public.gw_payroll_employee_results results
  where (
      coalesce(results.raw_payload ->> 'employeeCode', results.raw_payload ->> 'employee_code', '') = '125'
      or coalesce(results.raw_payload ->> 'sourceEmployeeName', results.raw_payload ->> 'employee_name', '') like '%男性%'
    )
    and results.employee_id <> (
      select employee_id from aoi_identity_targets where identity_key = 'manufacturing_male'
    );
  if invalid_count <> 0 then
    raise exception '男性の佐藤葵に誤った給与結果が%件残っています', invalid_count;
  end if;

  select count(*) into invalid_count
  from public.gw_payroll_employee_results results
  where (
      coalesce(results.raw_payload ->> 'employeeCode', results.raw_payload ->> 'employee_code', '') = '141'
      or coalesce(results.raw_payload ->> 'sourceEmployeeName', results.raw_payload ->> 'employee_name', '') like '%女性%'
    )
    and results.employee_id <> (
      select employee_id from aoi_identity_targets where identity_key = 'floor_female'
    );
  if invalid_count <> 0 then
    raise exception '女性の佐藤葵に誤った給与結果が%件残っています', invalid_count;
  end if;

  select count(*) into invalid_count
  from public.gw_payroll_calculation_profiles profiles
  where (
      coalesce(profiles.source_snapshot ->> 'employee_code', profiles.source_snapshot ->> 'employeeCode', '') = '125'
      or coalesce(profiles.source_snapshot ->> 'name', profiles.source_snapshot ->> 'source_employee_name', '') like '%男性%'
    )
    and profiles.employee_id <> (
      select employee_id from aoi_identity_targets where identity_key = 'manufacturing_male'
    );
  if invalid_count <> 0 then
    raise exception '男性の佐藤葵に誤った給与プロファイルが%件残っています', invalid_count;
  end if;

  select count(*) into invalid_count
  from public.gw_payroll_calculation_profiles profiles
  where (
      coalesce(profiles.source_snapshot ->> 'employee_code', profiles.source_snapshot ->> 'employeeCode', '') = '141'
      or coalesce(profiles.source_snapshot ->> 'name', profiles.source_snapshot ->> 'source_employee_name', '') like '%女性%'
    )
    and profiles.employee_id <> (
      select employee_id from aoi_identity_targets where identity_key = 'floor_female'
    );
  if invalid_count <> 0 then
    raise exception '女性の佐藤葵に誤った給与プロファイルが%件残っています', invalid_count;
  end if;

  select count(*) into invalid_count
  from public.gw_paid_leave_grant_lots lots
  join aoi_identity_targets targets on targets.employee_id = lots.employee_id
  where lots.grant_date = date '2026-08-01'
    and lots.grant_status = 'granted'
    and (
      (targets.identity_key = 'floor_female' and (
        lots.granted_days is distinct from 10
        or lots.service_months is distinct from 6
        or lots.scheduled_week_days is distinct from 5
      ))
      or (targets.identity_key = 'manufacturing_male' and (
        lots.granted_days is distinct from 8
        or lots.service_months is distinct from 18
        or lots.scheduled_week_days is distinct from 4
      ))
    );
  if invalid_count <> 0 then
    raise exception '佐藤葵2名の有給付与検証に失敗しました（%件）', invalid_count;
  end if;

  select count(*) into invalid_count
  from public.gw_paid_leave_profiles profiles
  join aoi_identity_targets targets on targets.employee_id = profiles.employee_id
  where (
    targets.identity_key = 'floor_female'
    and (
      profiles.grant_schedule_kind is distinct from 'standard'
      or profiles.scheduled_week_days is distinct from 5
      or profiles.next_grant_date is distinct from date '2027-06-11'
      or profiles.projected_grant_days is distinct from 11
    )
  ) or (
    targets.identity_key = 'manufacturing_male'
    and (
      profiles.grant_schedule_kind is distinct from 'proportional'
      or profiles.scheduled_week_days is distinct from 4
      or profiles.next_grant_date is distinct from date '2027-06-17'
      or profiles.projected_grant_days is distinct from 9
    )
  );
  if invalid_count <> 0 then
    raise exception '佐藤葵2名の次回有給付与検証に失敗しました（%件）', invalid_count;
  end if;
end
$$;

delete from public.gw_payroll_employees
where employee_code = '__AOI_SWAP_20260813__';

commit;
