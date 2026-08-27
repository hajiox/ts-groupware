create or replace function public.gw_link_paid_leave_request_to_shift(
  p_request_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_request public.gw_paid_leave_requests%rowtype;
  target_period public.gw_shift_periods%rowtype;
  target_assignment public.gw_shift_assignments%rowtype;
  assignment_id uuid;
  next_request_type text;
  previous_request_type text;
  planned_start time;
  planned_end time;
  planned_break integer;
begin
  select *
  into target_request
  from public.gw_paid_leave_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception '有給申請が見つかりません';
  end if;

  if target_request.request_status not in ('submitted', 'approved') then
    raise exception '承認対象ではない有給申請です';
  end if;

  if target_request.shift_period_id is null or target_request.user_id is null then
    raise exception '有給申請に確定シフトが紐付いていません';
  end if;

  select *
  into target_period
  from public.gw_shift_periods
  where id = target_request.shift_period_id
  for update;

  if not found or target_period.is_test_mode or target_period.status not in ('confirmed', 'exported', 'archived') then
    raise exception '有給申請の対象シフトが確定されていません';
  end if;

  if target_request.scheduled_minutes_snapshot is null
     or target_request.scheduled_minutes_snapshot <= 0 then
    raise exception '有給の基準となる所定勤務時間が設定されていません';
  end if;

  planned_start := nullif(target_request.raw_payload #>> '{paid_leave_schedule,start_time}', '')::time;
  planned_end := nullif(target_request.raw_payload #>> '{paid_leave_schedule,end_time}', '')::time;
  planned_break := greatest(
    coalesce(nullif(target_request.raw_payload #>> '{paid_leave_schedule,break_minutes}', '')::integer, 0),
    0
  );

  assignment_id := null;
  if target_request.shift_assignment_id is not null then
    select *
    into target_assignment
    from public.gw_shift_assignments
    where id = target_request.shift_assignment_id
      and period_id = target_request.shift_period_id
      and user_id = target_request.user_id
      and work_date = target_request.leave_date
    for update;
    if found then
      assignment_id := target_assignment.id;
    end if;
  end if;

  if assignment_id is null then
    select *
    into target_assignment
    from public.gw_shift_assignments
    where period_id = target_request.shift_period_id
      and user_id = target_request.user_id
      and work_date = target_request.leave_date
    for update;
    if found then
      assignment_id := target_assignment.id;
    end if;
  end if;

  if target_request.leave_unit = 'full_day' then
    next_request_type := 'paid_leave_full';

    if assignment_id is null then
      insert into public.gw_shift_assignments (
        period_id,
        user_id,
        employee_id,
        work_date,
        pattern_id,
        shift_label,
        start_time,
        end_time,
        break_minutes,
        work_minutes,
        assignment_type,
        note,
        source,
        created_by,
        updated_by,
        updated_at
      )
      values (
        target_request.shift_period_id,
        target_request.user_id,
        target_request.employee_id,
        target_request.leave_date,
        null,
        '有給（全休）',
        planned_start,
        planned_end,
        planned_break,
        target_request.scheduled_minutes_snapshot,
        'staff',
        '__paid_leave_full__',
        'manual',
        p_actor_user_id,
        p_actor_user_id,
        now()
      )
      on conflict (period_id, user_id, work_date)
      do update
      set employee_id = excluded.employee_id,
          pattern_id = null,
          shift_label = excluded.shift_label,
          start_time = coalesce(public.gw_shift_assignments.start_time, excluded.start_time),
          end_time = coalesce(public.gw_shift_assignments.end_time, excluded.end_time),
          break_minutes = case
            when public.gw_shift_assignments.work_minutes is not null then public.gw_shift_assignments.break_minutes
            else excluded.break_minutes
          end,
          work_minutes = coalesce(public.gw_shift_assignments.work_minutes, excluded.work_minutes),
          note = excluded.note,
          source = 'manual',
          updated_by = excluded.updated_by,
          updated_at = now()
      returning id into assignment_id;
    else
      update public.gw_shift_assignments
      set pattern_id = null,
          shift_label = '有給（全休）',
          start_time = coalesce(start_time, planned_start),
          end_time = coalesce(end_time, planned_end),
          break_minutes = case when work_minutes is not null then break_minutes else planned_break end,
          work_minutes = coalesce(work_minutes, target_request.scheduled_minutes_snapshot),
          note = '__paid_leave_full__',
          source = 'manual',
          updated_by = p_actor_user_id,
          updated_at = now()
      where id = assignment_id;
    end if;
  else
    next_request_type := 'paid_leave_half';
    if assignment_id is null then
      raise exception '半休を承認するには確定シフトの勤務時間が必要です';
    end if;
  end if;

  select request_type
  into previous_request_type
  from public.gw_shift_requests
  where period_id = target_request.shift_period_id
    and user_id = target_request.user_id
    and work_date = target_request.leave_date;

  insert into public.gw_shift_requests (
    period_id,
    user_id,
    employee_id,
    work_date,
    request_type,
    priority,
    start_time,
    end_time,
    memo,
    status,
    is_test,
    updated_at
  )
  values (
    target_request.shift_period_id,
    target_request.user_id,
    target_request.employee_id,
    target_request.leave_date,
    next_request_type,
    'must',
    null,
    null,
    target_request.employee_memo,
    'accepted',
    false,
    now()
  )
  on conflict (period_id, user_id, work_date)
  do update
  set employee_id = excluded.employee_id,
      request_type = excluded.request_type,
      priority = excluded.priority,
      start_time = null,
      end_time = null,
      memo = excluded.memo,
      status = 'accepted',
      is_test = false,
      updated_at = now();

  update public.gw_paid_leave_requests
  set shift_assignment_id = assignment_id,
      raw_payload = jsonb_set(
        coalesce(raw_payload, '{}'::jsonb),
        '{paid_leave_schedule,linked_on_approval}',
        'true'::jsonb,
        true
      ),
      updated_at = now()
  where id = target_request.id;

  insert into public.gw_paid_leave_audit_logs (
    employee_id,
    user_id,
    entity_type,
    entity_id,
    action,
    actor_user_id,
    actor_type,
    source,
    before_payload,
    after_payload
  )
  values (
    target_request.employee_id,
    target_request.user_id,
    'request',
    target_request.id,
    'update',
    p_actor_user_id,
    'user',
    'gw_link_paid_leave_request_to_shift',
    jsonb_build_object(
      'shift_assignment_id', target_request.shift_assignment_id,
      'shift_request_type', previous_request_type
    ),
    jsonb_build_object(
      'shift_assignment_id', assignment_id,
      'shift_request_type', next_request_type,
      'scheduled_minutes', target_request.scheduled_minutes_snapshot
    )
  );

  return jsonb_build_object(
    'shift_assignment_id', assignment_id,
    'shift_request_type', next_request_type,
    'previous_shift_request_type', previous_request_type
  );
end;
$$;

create or replace function public.gw_approve_paid_leave_request_flexible(
  p_request_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  shift_result jsonb;
  approval_result jsonb;
begin
  shift_result := public.gw_link_paid_leave_request_to_shift(p_request_id, p_actor_user_id);
  approval_result := public.gw_approve_paid_leave_request_with_management_post(p_request_id, p_actor_user_id);
  return approval_result || jsonb_build_object('shift_link', shift_result);
end;
$$;

create or replace function public.gw_confirm_workday_resolution(
  p_resolution_id uuid,
  p_actor_user_id uuid,
  p_manager_memo text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_resolution public.gw_workday_resolutions%rowtype;
  approval_result jsonb := '{}'::jsonb;
begin
  select *
  into target_resolution
  from public.gw_workday_resolutions
  where id = p_resolution_id
  for update;

  if not found then
    raise exception '未打刻回答が見つかりません';
  end if;

  if target_resolution.resolution_status not in ('employee_answered', 'reopened') then
    raise exception '確認待ちではない回答は確定できません';
  end if;

  if target_resolution.paid_leave_request_id is not null then
    approval_result := public.gw_approve_paid_leave_request_flexible(
      target_resolution.paid_leave_request_id,
      p_actor_user_id
    );
  end if;

  update public.gw_workday_resolutions
  set resolution_status = 'admin_confirmed',
      confirmed_by = p_actor_user_id,
      confirmed_at = now(),
      manager_memo = nullif(btrim(coalesce(p_manager_memo, '')), ''),
      updated_at = now()
  where id = target_resolution.id;

  insert into public.gw_paid_leave_audit_logs (
    employee_id,
    user_id,
    entity_type,
    entity_id,
    action,
    actor_user_id,
    actor_type,
    source,
    after_payload
  )
  values (
    target_resolution.employee_id,
    target_resolution.user_id,
    'workday_resolution',
    target_resolution.id,
    'resolve',
    p_actor_user_id,
    'user',
    'gw_confirm_workday_resolution',
    jsonb_build_object(
      'resolution_type', target_resolution.resolution_type,
      'paid_leave_request_id', target_resolution.paid_leave_request_id,
      'management_post_id', approval_result ->> 'management_post_id'
    )
  );

  return approval_result || jsonb_build_object(
    'resolution_id', target_resolution.id,
    'status', 'admin_confirmed'
  );
end;
$$;

revoke all on function public.gw_link_paid_leave_request_to_shift(uuid, uuid) from public;
revoke all on function public.gw_approve_paid_leave_request_flexible(uuid, uuid) from public;
revoke all on function public.gw_confirm_workday_resolution(uuid, uuid, text) from public;

grant execute on function public.gw_link_paid_leave_request_to_shift(uuid, uuid) to service_role;
grant execute on function public.gw_approve_paid_leave_request_flexible(uuid, uuid) to service_role;
grant execute on function public.gw_confirm_workday_resolution(uuid, uuid, text) to service_role;

comment on function public.gw_link_paid_leave_request_to_shift(uuid, uuid) is
  '承認時に確定シフトの休み・勤務割当を有給表示へ同期する。申請中と却下時は確定シフトを変更しない。';

comment on function public.gw_approve_paid_leave_request_flexible(uuid, uuid) is
  '確定後の有給申請をシフト、有給残、労務用仮打刻、管理職掲示板へ同一トランザクションで反映する。';
