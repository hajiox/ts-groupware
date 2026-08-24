alter table public.gw_pledge_assignments
  add column if not exists recipient_name text,
  add column if not exists recipient_department text;

update public.gw_pledge_assignments assignments
set
  recipient_name = coalesce(users.real_name, users.display_name),
  recipient_department = users.department
from public.gw_users users
where assignments.user_id = users.id
  and assignments.recipient_name is null;

alter table public.gw_pledge_assignments
  alter column user_id drop not null;

alter table public.gw_pledge_assignments
  drop constraint if exists gw_pledge_assignments_user_id_fkey;

alter table public.gw_pledge_assignments
  add constraint gw_pledge_assignments_user_id_fkey
  foreign key (user_id) references public.gw_users(id) on delete set null;

comment on column public.gw_pledge_assignments.recipient_name is 'Recipient name snapshot retained after account deletion.';
comment on column public.gw_pledge_assignments.recipient_department is 'Recipient department snapshot retained after account deletion.';
