alter table public.gw_paid_leave_requests
  add column if not exists management_post_id uuid
    references public.gw_posts(id) on delete set null,
  add column if not exists management_posted_at timestamptz;

create unique index if not exists idx_gw_paid_leave_requests_management_post
  on public.gw_paid_leave_requests (management_post_id)
  where management_post_id is not null;

create or replace function public.gw_approve_paid_leave_request_with_management_post(
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
  approval_result jsonb := '{}'::jsonb;
  target_group_id uuid;
  tsg_user_id uuid;
  created_post_id uuid;
  employee_name text;
  employee_department text;
  actor_name text;
  leave_label text;
  post_content text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));

  select *
  into target_request
  from public.gw_paid_leave_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception '有給申請が見つかりません';
  end if;

  if target_request.management_post_id is not null then
    return jsonb_build_object(
      'request_id', target_request.id,
      'status', target_request.request_status,
      'management_post_id', target_request.management_post_id,
      'management_post_created', false
    );
  end if;

  if target_request.request_status = 'approved' then
    approval_result := jsonb_build_object(
      'request_id', target_request.id,
      'allocated_days', target_request.requested_days,
      'status', 'approved'
    );
  else
    approval_result := public.gw_approve_paid_leave_request(
      p_request_id,
      p_actor_user_id
    );
  end if;

  select *
  into target_request
  from public.gw_paid_leave_requests
  where id = p_request_id
  for update;

  select groups.id
  into target_group_id
  from public.gw_groups groups
  where groups.type = 'board'
    and (
      groups.name in ('TS（管理職）', 'TS(管理職)', 'ＴＳ（管理職）', 'ＴＳ(管理職)')
      or groups.name like '%管理職%'
    )
  order by
    case groups.name
      when 'TS（管理職）' then 0
      when 'TS(管理職)' then 1
      when 'ＴＳ（管理職）' then 2
      when 'ＴＳ(管理職)' then 3
      else 4
    end,
    groups.created_at
  limit 1;

  if target_group_id is null then
    raise exception '管理職の掲示板が見つかりません';
  end if;

  select users.id
  into tsg_user_id
  from public.gw_users users
  where users.status = 'approved'
    and (
      users.display_name in ('TSGくん', 'TSG君')
      or users.line_user_id like 'system_tsg_%'
    )
  order by
    case when users.display_name = 'TSGくん' then 0 else 1 end,
    users.created_at
  limit 1;

  if tsg_user_id is null then
    raise exception 'TSGくんのユーザーが見つかりません';
  end if;

  select
    coalesce(nullif(trim(employees.real_name), ''), nullif(trim(employees.display_name), ''), '氏名未設定'),
    coalesce(nullif(trim(employees.department), ''), '所属未設定')
  into employee_name, employee_department
  from public.gw_payroll_employees employees
  where employees.id = target_request.employee_id;

  select coalesce(nullif(trim(users.real_name), ''), nullif(trim(users.display_name), ''), '管理者')
  into actor_name
  from public.gw_users users
  where users.id = p_actor_user_id;

  leave_label := case target_request.leave_unit
    when 'full_day' then '有給（全休）'
    when 'half_day_am' then '有給（午前半休）'
    when 'half_day_pm' then '有給（午後半休）'
    else '有給（半休）'
  end;

  post_content := concat_ws(E'\n',
    '【有給申請 承認】',
    '申請者：' || employee_name,
    '所属：' || employee_department,
    '取得日：' || to_char(target_request.leave_date, 'YYYY年FMMM月FMDD日'),
    '区分：' || leave_label,
    case
      when nullif(trim(target_request.employee_memo), '') is not null
        then '理由・補足：' || trim(target_request.employee_memo)
      else null
    end,
    '承認者：' || coalesce(actor_name, '管理者'),
    '承認日時：' || to_char(
      coalesce(target_request.approved_at, now()) at time zone 'Asia/Tokyo',
      'YYYY年FMMM月FMDD日 HH24:MI'
    )
  );

  insert into public.gw_posts (
    group_id,
    user_id,
    content,
    attachments,
    parent_id,
    is_pinned
  )
  values (
    target_group_id,
    tsg_user_id,
    post_content,
    '[]'::jsonb,
    null,
    false
  )
  returning id into created_post_id;

  update public.gw_paid_leave_requests
  set management_post_id = created_post_id,
      management_posted_at = now(),
      updated_at = now()
  where id = target_request.id;

  update public.gw_groups
  set updated_at = now()
  where id = target_group_id;

  return approval_result || jsonb_build_object(
    'management_post_id', created_post_id,
    'management_group_id', target_group_id,
    'management_post_created', true
  );
end;
$$;

revoke all on function public.gw_approve_paid_leave_request_with_management_post(uuid, uuid) from public;
grant execute on function public.gw_approve_paid_leave_request_with_management_post(uuid, uuid) to service_role;

comment on column public.gw_paid_leave_requests.management_post_id is
  '管理者承認時にTSGくんが管理職掲示板へ作成した投稿。二重投稿防止にも使用する。';

comment on function public.gw_approve_paid_leave_request_with_management_post(uuid, uuid) is
  '有給申請の承認、残日数引当、管理職掲示板へのTSGくん投稿を同一トランザクションで実行する。';
