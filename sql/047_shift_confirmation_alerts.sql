create table if not exists public.gw_shift_confirmation_alerts (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.gw_shift_periods(id) on delete cascade,
  user_id uuid not null references public.gw_users(id) on delete cascade,
  department text not null check (department in ('フロア', '製造', '道の駅')),
  period_title text not null,
  start_date date not null,
  end_date date not null,
  seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (period_id, user_id)
);

create index if not exists idx_gw_shift_confirmation_alerts_user_unseen
  on public.gw_shift_confirmation_alerts (user_id, created_at desc)
  where seen_at is null;

alter table public.gw_shift_confirmation_alerts enable row level security;

create or replace function public.gw_create_shift_confirmation_alerts(p_period_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period public.gw_shift_periods%rowtype;
  v_inserted integer := 0;
begin
  select *
  into v_period
  from public.gw_shift_periods
  where id = p_period_id;

  if not found
    or v_period.is_test_mode
    or v_period.status not in ('confirmed', 'exported')
  then
    return 0;
  end if;

  insert into public.gw_shift_confirmation_alerts (
    period_id,
    user_id,
    department,
    period_title,
    start_date,
    end_date
  )
  select distinct
    v_period.id,
    users.id,
    v_period.department,
    v_period.title,
    v_period.start_date,
    v_period.end_date
  from public.gw_payroll_employees employees
  join public.gw_users users
    on users.id = employees.user_id
  left join public.gw_shift_period_exclusions exclusions
    on exclusions.period_id = v_period.id
   and exclusions.user_id = users.id
  where employees.payroll_status = 'active'
    and users.status = 'approved'
    and users.department = v_period.department
    and nullif(employees.raw_payload #>> '{hr_profile,deleted_at}', '') is null
    and replace(replace(replace(replace(replace(coalesce(users.display_name, ''), ' ', ''), '　', ''), '（', ''), '）', ''), 'くん', '君') <> 'TSG君'
    and exclusions.user_id is null
  on conflict (period_id, user_id) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

create or replace function public.gw_notify_shift_confirmation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'confirmed'
    and old.status is distinct from 'confirmed'
    and not new.is_test_mode
  then
    perform public.gw_create_shift_confirmation_alerts(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_gw_shift_confirmation_alerts on public.gw_shift_periods;

create trigger trg_gw_shift_confirmation_alerts
after update of status on public.gw_shift_periods
for each row
execute function public.gw_notify_shift_confirmation();

do $$
declare
  v_latest_floor_period uuid;
begin
  select id
  into v_latest_floor_period
  from public.gw_shift_periods
  where department = 'フロア'
    and status in ('confirmed', 'exported')
    and not is_test_mode
  order by confirmed_at desc nulls last, updated_at desc
  limit 1;

  if v_latest_floor_period is not null then
    perform public.gw_create_shift_confirmation_alerts(v_latest_floor_period);
  end if;
end;
$$;
