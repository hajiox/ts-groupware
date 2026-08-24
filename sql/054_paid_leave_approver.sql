delete from public.gw_feature_roles
where feature_key = 'paid_leave_approval'
  and role_key = 'approver';

insert into public.gw_feature_roles (feature_key, role_key, user_id, note)
select
  'paid_leave_approval',
  'approver',
  users.id,
  '有給申請の承認・却下を行う責任者'
from public.gw_users users
where users.status = 'approved'
  and regexp_replace(coalesce(users.real_name, users.display_name, ''), '[[:space:]　]+', '', 'g') = '佐藤正彦'
on conflict (feature_key, role_key, user_id) do update
set note = excluded.note;
