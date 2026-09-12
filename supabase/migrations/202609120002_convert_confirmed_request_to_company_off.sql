create or replace function public.gw_convert_confirmed_shift_request_to_company_off(
  p_period_id uuid,
  p_user_id uuid,
  p_work_date date,
  p_actor_user_id uuid
)
returns table (assignment_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_period public.gw_shift_periods%rowtype;
  target_request public.gw_shift_requests%rowtype;
  next_assignment_id uuid;
begin
  select *
  into target_period
  from public.gw_shift_periods
  where id = p_period_id
  for update;

  if not found or target_period.status <> 'confirmed' then
    raise exception '確定済みシフトではありません';
  end if;
  if p_work_date < target_period.start_date or p_work_date > target_period.end_date then
    raise exception '日付がシフト期間外です';
  end if;

  select *
  into target_request
  from public.gw_shift_requests
  where period_id = p_period_id
    and user_id = p_user_id
    and work_date = p_work_date
  for update;

  if not found or target_request.request_type not in ('day_off', 'unavailable') then
    raise exception '変更できる希望休がありません';
  end if;

  delete from public.gw_shift_requests
  where id = target_request.id;

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
    p_period_id,
    p_user_id,
    target_request.employee_id,
    p_work_date,
    null,
    null,
    null,
    null,
    0,
    null,
    'staff',
    '__company_off__',
    'manual',
    p_actor_user_id,
    p_actor_user_id,
    now()
  )
  on conflict (period_id, user_id, work_date)
  do update
  set employee_id = excluded.employee_id,
      pattern_id = null,
      shift_label = null,
      start_time = null,
      end_time = null,
      break_minutes = 0,
      work_minutes = null,
      assignment_type = 'staff',
      note = '__company_off__',
      source = 'manual',
      updated_by = p_actor_user_id,
      updated_at = now()
  returning id into next_assignment_id;

  return query select next_assignment_id;
end;
$$;

revoke all on function public.gw_convert_confirmed_shift_request_to_company_off(uuid, uuid, date, uuid) from public;
revoke all on function public.gw_convert_confirmed_shift_request_to_company_off(uuid, uuid, date, uuid) from anon;
revoke all on function public.gw_convert_confirmed_shift_request_to_company_off(uuid, uuid, date, uuid) from authenticated;
grant execute on function public.gw_convert_confirmed_shift_request_to_company_off(uuid, uuid, date, uuid) to service_role;
