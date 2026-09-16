-- Send the current confidentiality pledge once, seven days after onboarding is complete.
alter table public.gw_users
  add column if not exists onboarding_completed_at timestamptz;

create or replace function public.gw_stamp_user_onboarding_completion()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'approved' and new.onboarding_completed_at is null then
    if tg_op = 'INSERT' then
      new.onboarding_completed_at := now();
    elsif old.status is distinct from 'approved' then
      new.onboarding_completed_at := now();
    end if;
  end if;
  return new;
end $$;

drop trigger if exists gw_users_stamp_onboarding_completion on public.gw_users;
create trigger gw_users_stamp_onboarding_completion
before insert or update of status on public.gw_users
for each row execute function public.gw_stamp_user_onboarding_completion();

update public.gw_users users
set onboarding_completed_at = greatest(
  users.created_at,
  coalesce((
    select max(
      case
        when employees.raw_payload #>> '{hr_profile,tsg_linked_at}'
          ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'
        then (employees.raw_payload #>> '{hr_profile,tsg_linked_at}')::timestamptz
      end
    )
    from public.gw_payroll_employees employees
    where employees.user_id = users.id
  ), users.created_at)
)
where users.status = 'approved'
  and users.onboarding_completed_at is null
  and users.line_user_id not like 'provisional:%';

alter table public.gw_pledge_templates
  add column if not exists new_hire_auto_send boolean not null default false;

update public.gw_pledge_templates
set new_hire_auto_send = true
where id = '00000000-0000-4000-8000-000000000001';

alter table public.gw_pledge_deliveries
  add column if not exists delivery_kind text not null default 'manual',
  add column if not exists automation_user_id uuid;

alter table public.gw_pledge_deliveries
  drop constraint if exists gw_pledge_deliveries_delivery_kind_check;
alter table public.gw_pledge_deliveries
  add constraint gw_pledge_deliveries_delivery_kind_check
  check (delivery_kind in ('manual', 'new_hire_auto'));

alter table public.gw_pledge_deliveries
  drop constraint if exists gw_pledge_deliveries_automation_check;
alter table public.gw_pledge_deliveries
  add constraint gw_pledge_deliveries_automation_check
  check (
    (delivery_kind = 'manual' and automation_user_id is null)
    or (
      delivery_kind = 'new_hire_auto'
      and automation_user_id is not null
      and target_type = 'individual'
      and is_test = false
    )
  );

create unique index if not exists uq_gw_pledge_deliveries_new_hire_user
  on public.gw_pledge_deliveries (template_id, automation_user_id)
  where delivery_kind = 'new_hire_auto';

create or replace function public.gw_dispatch_new_hire_pledges(
  p_run_at timestamptz default now()
)
returns table (
  assignment_id uuid,
  user_id uuid,
  template_id uuid,
  pledge_title text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  candidate record;
  saved_delivery_id uuid;
begin
  for candidate in
    select distinct
      users.id as user_id,
      coalesce(users.real_name, users.display_name) as recipient_name,
      users.department as recipient_department,
      templates.id as template_id,
      templates.title,
      templates.body,
      templates.check_items,
      templates.agreement_label,
      templates.company_name
    from public.gw_payroll_employees employees
    join public.gw_users users on users.id = employees.user_id
    cross join public.gw_pledge_templates templates
    where employees.payroll_status = 'active'
      and employees.hire_date is not null
      and users.status = 'approved'
      and users.onboarding_completed_at is not null
      and users.line_user_id not like 'provisional:%'
      and regexp_replace(coalesce(users.real_name, users.display_name), '\s|　', '', 'g') <> 'TSG君'
      and greatest(
        users.onboarding_completed_at,
        employees.hire_date::timestamp at time zone 'Asia/Tokyo'
      ) + interval '7 days' <= coalesce(p_run_at, now())
      and templates.is_active = true
      and templates.new_hire_auto_send = true
      and not exists (
        select 1
        from public.gw_pledge_assignments assignments
        join public.gw_pledge_deliveries deliveries on deliveries.id = assignments.delivery_id
        where assignments.user_id = users.id
          and deliveries.template_id = templates.id
          and deliveries.is_test = false
      )
  loop
    saved_delivery_id := null;
    insert into public.gw_pledge_deliveries (
      template_id,
      title_snapshot,
      body_snapshot,
      check_items_snapshot,
      agreement_label_snapshot,
      company_name_snapshot,
      target_type,
      target_label,
      is_test,
      sent_by,
      sent_at,
      created_at,
      delivery_kind,
      automation_user_id
    )
    values (
      candidate.template_id,
      candidate.title,
      candidate.body,
      candidate.check_items,
      candidate.agreement_label,
      candidate.company_name,
      'individual',
      candidate.recipient_name,
      false,
      (
        select sender.id
        from public.gw_users sender
        where sender.status = 'approved'
          and regexp_replace(coalesce(sender.real_name, sender.display_name), '\s|　', '', 'g') = 'TSG君'
        order by sender.created_at, sender.id
        limit 1
      ),
      coalesce(p_run_at, now()),
      coalesce(p_run_at, now()),
      'new_hire_auto',
      candidate.user_id
    )
    on conflict (template_id, automation_user_id)
      where delivery_kind = 'new_hire_auto'
      do nothing
    returning id into saved_delivery_id;

    if saved_delivery_id is null then
      continue;
    end if;

    insert into public.gw_pledge_assignments (
      delivery_id,
      user_id,
      recipient_name,
      recipient_department,
      status,
      created_at,
      updated_at
    )
    values (
      saved_delivery_id,
      candidate.user_id,
      candidate.recipient_name,
      candidate.recipient_department,
      'pending',
      coalesce(p_run_at, now()),
      coalesce(p_run_at, now())
    )
    returning id into assignment_id;

    user_id := candidate.user_id;
    template_id := candidate.template_id;
    pledge_title := candidate.title;
    return next;
  end loop;
end;
$$;

revoke all on function public.gw_stamp_user_onboarding_completion() from public, anon, authenticated;
grant execute on function public.gw_stamp_user_onboarding_completion() to service_role;
revoke all on function public.gw_dispatch_new_hire_pledges(timestamptz) from public, anon, authenticated;
grant execute on function public.gw_dispatch_new_hire_pledges(timestamptz) to service_role;

comment on column public.gw_users.onboarding_completed_at is
  'First time the real TSG account became approved; starts the new-hire follow-up wait.';
comment on column public.gw_pledge_templates.new_hire_auto_send is
  'When true, sends this active template once to each eligible new hire after seven days.';
comment on function public.gw_dispatch_new_hire_pledges(timestamptz) is
  'Idempotently creates pending pledge assignments seven days after onboarding and hire date.';
