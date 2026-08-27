-- 藤田香織さんの個人別基本勤務と、稼働済みフロアシフトの所定時刻を訂正する。
do $$
declare
  target_count integer;
  target_employee_id uuid;
  target_user_id uuid;
  current_raw_payload jsonb;
  current_profile jsonb;
  change_history jsonb;
  target_assignment_ids uuid[];
  target_assignment_count integer;
  invalid_assignment_count integer;
begin
  select count(*)
    into target_count
  from public.gw_payroll_employees employee
  where employee.employee_code = '9'
    and employee.payroll_status = 'active'
    and regexp_replace(
      coalesce(employee.real_name, employee.display_name, ''),
      '[[:space:]　]',
      '',
      'g'
    ) = '藤田香織';

  if target_count <> 1 then
    raise exception '藤田香織さん（社員NO 9）を一意特定できません（%件）', target_count;
  end if;

  select employee.id, employee.user_id, coalesce(employee.raw_payload, '{}'::jsonb)
    into target_employee_id, target_user_id, current_raw_payload
  from public.gw_payroll_employees employee
  where employee.employee_code = '9'
    and employee.payroll_status = 'active'
    and regexp_replace(
      coalesce(employee.real_name, employee.display_name, ''),
      '[[:space:]　]',
      '',
      'g'
    ) = '藤田香織';

  if target_user_id is null then
    raise exception '藤田香織さんのTSGユーザー連携が見つかりません';
  end if;

  current_profile := case
    when jsonb_typeof(current_raw_payload -> 'hr_profile') = 'object'
      then current_raw_payload -> 'hr_profile'
    else '{}'::jsonb
  end;
  change_history := case
    when jsonb_typeof(current_profile -> 'basic_work_change_history') = 'array'
      then current_profile -> 'basic_work_change_history'
    else '[]'::jsonb
  end;

  if coalesce(current_profile ->> 'basic_work_start', '') <> '11:00'
    or coalesce(current_profile ->> 'basic_work_end', '') <> '18:30'
    or coalesce(current_profile ->> 'basic_break_minutes', '') <> '60'
  then
    change_history := change_history || jsonb_build_array(jsonb_build_object(
      'effective_from', '2026-08-01',
      'previous_start', nullif(current_profile ->> 'basic_work_start', ''),
      'previous_end', nullif(current_profile ->> 'basic_work_end', ''),
      'previous_break_minutes', nullif(current_profile ->> 'basic_break_minutes', '')::integer,
      'next_start', '11:00',
      'next_end', '18:30',
      'break_minutes', 60,
      'changed_at', now(),
      'reason', 'owner_confirmed_floor_work_time_correction'
    ));
  end if;

  update public.gw_payroll_employees employee
  set raw_payload = jsonb_set(
        current_raw_payload,
        '{hr_profile}',
        current_profile || jsonb_build_object(
          'basic_work_start', '11:00',
          'basic_work_end', '18:30',
          'basic_break_minutes', 60,
          'basic_work_effective_from', '2026-08-01',
          'basic_work_change_history', change_history
        ),
        true
      ),
      updated_at = now()
  where employee.id = target_employee_id;

  select array_agg(assignment.id order by assignment.work_date), count(*)
    into target_assignment_ids, target_assignment_count
  from public.gw_shift_assignments assignment
  join public.gw_shift_periods period on period.id = assignment.period_id
  where period.department = 'フロア'
    and assignment.work_date >= date '2026-08-01'
    and (assignment.employee_id = target_employee_id or assignment.user_id = target_user_id)
    and (
      assignment.shift_label = 'フロア勤務'
      or assignment.shift_label like '基本勤務%'
    );

  if target_assignment_count < 25 then
    raise exception '藤田香織さんの訂正対象シフトが不足しています（%件）', target_assignment_count;
  end if;

  update public.gw_shift_assignments assignment
  set start_time = time '11:00',
      end_time = time '18:30',
      break_minutes = 60,
      work_minutes = 390,
      updated_at = now()
  where assignment.id = any(target_assignment_ids);

  update public.gw_paid_leave_requests request
  set scheduled_minutes_snapshot = 390,
      payable_minutes_snapshot = case
        when request.requested_days is null then request.payable_minutes_snapshot
        else round(390 * request.requested_days)::integer
      end,
      updated_at = now()
  where request.shift_assignment_id = any(target_assignment_ids);

  update public.gw_workday_resolutions resolution
  set scheduled_minutes_snapshot = 390,
      raw_payload = case
        when jsonb_typeof(resolution.raw_payload -> 'attendance_issue') = 'object'
          then jsonb_set(
            resolution.raw_payload,
            '{attendance_issue}',
            (resolution.raw_payload -> 'attendance_issue') || jsonb_build_object(
              'scheduled_start_time', '11:00',
              'scheduled_end_time', '18:30'
            ),
            true
          )
        else resolution.raw_payload
      end,
      updated_at = now()
  where resolution.shift_assignment_id = any(target_assignment_ids);

  select count(*)
    into invalid_assignment_count
  from public.gw_shift_assignments assignment
  where assignment.id = any(target_assignment_ids)
    and (
      assignment.start_time <> time '11:00'
      or assignment.end_time <> time '18:30'
      or assignment.break_minutes <> 60
      or assignment.work_minutes <> 390
    );

  if invalid_assignment_count <> 0 then
    raise exception '藤田香織さんのシフト時刻訂正を検証できません（不一致%件）', invalid_assignment_count;
  end if;

  if not exists (
    select 1
    from public.gw_payroll_employees employee
    where employee.id = target_employee_id
      and employee.raw_payload -> 'hr_profile' ->> 'basic_work_start' = '11:00'
      and employee.raw_payload -> 'hr_profile' ->> 'basic_work_end' = '18:30'
      and employee.raw_payload -> 'hr_profile' ->> 'basic_break_minutes' = '60'
  ) then
    raise exception '藤田香織さんの個人別基本勤務を検証できません';
  end if;
end
$$;
