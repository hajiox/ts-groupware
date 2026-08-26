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
    approval_result := public.gw_approve_paid_leave_request_with_management_post(
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

revoke all on function public.gw_confirm_workday_resolution(uuid, uuid, text) from public;
grant execute on function public.gw_confirm_workday_resolution(uuid, uuid, text) to service_role;

comment on function public.gw_confirm_workday_resolution(uuid, uuid, text) is
  '管理者が打刻回答を確定する。有給回答は残日数引当と管理職掲示板投稿も同一トランザクションで完了する。';

do $$
declare
  target_request record;
begin
  for target_request in
    select requests.id, requests.approved_by
    from public.gw_paid_leave_requests requests
    join public.gw_workday_resolutions resolutions
      on resolutions.paid_leave_request_id = requests.id
    where requests.request_source = 'missing_punch_resolution'
      and requests.request_status = 'approved'
      and requests.management_post_id is null
      and requests.approved_at >= timestamptz '2026-08-03 00:00:00+09'
      and requests.approved_by is not null
      and resolutions.resolution_status = 'admin_confirmed'
    order by requests.approved_at, requests.id
  loop
    perform public.gw_approve_paid_leave_request_with_management_post(
      target_request.id,
      target_request.approved_by
    );
  end loop;
end;
$$;
