alter table public.gw_home_company_messages
  add column if not exists new_hire_auto_send boolean not null default false;

alter table public.gw_home_company_message_recipients
  add column if not exists delivery_kind text not null default 'broadcast',
  add column if not exists delivery_date date;

alter table public.gw_home_company_message_recipients
  drop constraint if exists gw_home_company_message_recipients_delivery_kind_check;

alter table public.gw_home_company_message_recipients
  add constraint gw_home_company_message_recipients_delivery_kind_check
  check (delivery_kind in ('broadcast', 'new_hire_auto'));

alter table public.gw_home_company_message_recipients
  drop constraint if exists gw_home_company_message_recipients_delivery_date_check;

alter table public.gw_home_company_message_recipients
  add constraint gw_home_company_message_recipients_delivery_date_check
  check (
    (delivery_kind = 'broadcast' and delivery_date is null)
    or (delivery_kind = 'new_hire_auto' and delivery_date is not null)
  );

create index if not exists idx_gw_home_company_messages_new_hire_sequence
  on public.gw_home_company_messages (created_at, id)
  where new_hire_auto_send = true;

create unique index if not exists uq_gw_home_company_message_recipients_new_hire_day
  on public.gw_home_company_message_recipients (user_id, delivery_date)
  where delivery_kind = 'new_hire_auto';

create or replace function public.gw_dispatch_new_hire_company_messages(
  p_run_date date default ((now() at time zone 'Asia/Tokyo')::date)
)
returns table (user_id uuid, message_id uuid)
language sql
security definer
set search_path = public
as $$
  with eligible_users as (
    select distinct users.id as user_id
    from public.gw_payroll_employees employees
    join public.gw_users users on users.id = employees.user_id
    where employees.payroll_status = 'active'
      and employees.hire_date is not null
      and employees.hire_date + 7 <= p_run_date
      and users.status = 'approved'
      and regexp_replace(coalesce(users.real_name, users.display_name), '\s|　', '', 'g') <> 'TSG君'
  ),
  users_due_today as (
    select eligible.user_id
    from eligible_users eligible
    where not exists (
      select 1
      from public.gw_home_company_message_recipients delivered
      where delivered.user_id = eligible.user_id
        and delivered.delivery_kind = 'new_hire_auto'
        and delivered.delivery_date = p_run_date
    )
  ),
  next_messages as (
    select due.user_id, next_message.id as message_id
    from users_due_today due
    cross join lateral (
      select messages.id
      from public.gw_home_company_messages messages
      where messages.new_hire_auto_send = true
        and not exists (
          select 1
          from public.gw_home_company_message_recipients previous
          where previous.user_id = due.user_id
            and previous.message_id = messages.id
        )
      order by messages.created_at asc, messages.id asc
      limit 1
    ) next_message
  )
  insert into public.gw_home_company_message_recipients (
    message_id,
    user_id,
    delivery_kind,
    delivery_date
  )
  select
    next_messages.message_id,
    next_messages.user_id,
    'new_hire_auto',
    p_run_date
  from next_messages
  on conflict do nothing
  returning
    gw_home_company_message_recipients.user_id,
    gw_home_company_message_recipients.message_id;
$$;

revoke all on function public.gw_dispatch_new_hire_company_messages(date) from public;
revoke all on function public.gw_dispatch_new_hire_company_messages(date) from anon;
revoke all on function public.gw_dispatch_new_hire_company_messages(date) from authenticated;
grant execute on function public.gw_dispatch_new_hire_company_messages(date) to service_role;
