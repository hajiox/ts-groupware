begin;

alter table public.gw_bereavement_leave_requests
  add column if not exists counting_method text not null default 'confirmed_workdays'
    check (counting_method in ('calendar_days', 'confirmed_workdays'));

create table if not exists public.gw_bereavement_leave_request_days (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.gw_bereavement_leave_requests(id) on delete cascade,
  work_date date not null,
  shift_period_id uuid references public.gw_shift_periods(id) on delete set null,
  shift_assignment_id uuid references public.gw_shift_assignments(id) on delete set null,
  shift_label_snapshot text,
  scheduled_minutes_snapshot integer
    check (scheduled_minutes_snapshot is null or scheduled_minutes_snapshot >= 0),
  created_at timestamptz not null default now(),
  unique (request_id, work_date)
);

create index if not exists gw_bereavement_leave_request_days_date_idx
  on public.gw_bereavement_leave_request_days(work_date, request_id);

alter table public.gw_bereavement_leave_request_days enable row level security;
grant all on public.gw_bereavement_leave_request_days to service_role;

create or replace function public.gw_sync_bereavement_leave_resolutions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_day record;
  existing_resolution public.gw_workday_resolutions%rowtype;
  target_count integer;
begin
  if new.request_status = 'approved'
     and old.request_status is distinct from 'approved' then
    select count(*)
    into target_count
    from public.gw_bereavement_leave_request_days
    where request_id = new.id;

    if target_count <> new.requested_days then
      raise exception '忌引き対象勤務日の件数が申請日数と一致しません';
    end if;

    for target_day in
      select *
      from public.gw_bereavement_leave_request_days
      where request_id = new.id
      order by work_date
    loop
      select *
      into existing_resolution
      from public.gw_workday_resolutions
      where employee_id = new.employee_id
        and work_date = target_day.work_date
        and resolution_status <> 'voided'
      limit 1
      for update;

      if found and existing_resolution.resolution_type in ('paid_leave_full', 'paid_leave_half') then
        raise exception '%には承認済みまたは処理中の有給があります', target_day.work_date;
      end if;

      if found then
        update public.gw_workday_resolutions
        set user_id = new.user_id,
            shift_period_id = target_day.shift_period_id,
            shift_assignment_id = target_day.shift_assignment_id,
            scheduled_minutes_snapshot = target_day.scheduled_minutes_snapshot,
            resolution_type = 'bereavement_leave',
            resolution_status = 'admin_confirmed',
            paid_leave_request_id = null,
            confirmed_by = new.approved_by,
            confirmed_at = coalesce(new.approved_at, now()),
            manager_memo = new.manager_memo,
            source_key = 'bereavement-request:' || new.id::text || ':' || target_day.work_date::text,
            raw_payload = coalesce(existing_resolution.raw_payload, '{}'::jsonb)
              || jsonb_build_object(
                'bereavement_request_id', new.id,
                'relationship_code', new.relationship_code,
                'relationship_label', new.relationship_label
              ),
            updated_at = now()
        where id = existing_resolution.id;
      else
        insert into public.gw_workday_resolutions (
          employee_id,
          user_id,
          work_date,
          shift_period_id,
          shift_assignment_id,
          scheduled_minutes_snapshot,
          resolution_type,
          resolution_status,
          confirmed_by,
          confirmed_at,
          manager_memo,
          source_key,
          raw_payload
        )
        values (
          new.employee_id,
          new.user_id,
          target_day.work_date,
          target_day.shift_period_id,
          target_day.shift_assignment_id,
          target_day.scheduled_minutes_snapshot,
          'bereavement_leave',
          'admin_confirmed',
          new.approved_by,
          coalesce(new.approved_at, now()),
          new.manager_memo,
          'bereavement-request:' || new.id::text || ':' || target_day.work_date::text,
          jsonb_build_object(
            'bereavement_request_id', new.id,
            'relationship_code', new.relationship_code,
            'relationship_label', new.relationship_label
          )
        );
      end if;
    end loop;
  elsif old.request_status = 'approved'
        and new.request_status in ('cancelled', 'rejected') then
    update public.gw_workday_resolutions
    set resolution_status = 'voided',
        manager_memo = coalesce(new.manager_memo, manager_memo),
        updated_at = now()
    where resolution_type = 'bereavement_leave'
      and resolution_status <> 'voided'
      and raw_payload ->> 'bereavement_request_id' = new.id::text;
  end if;

  return new;
end;
$$;

drop trigger if exists gw_bereavement_leave_resolution_sync
  on public.gw_bereavement_leave_requests;

create trigger gw_bereavement_leave_resolution_sync
after update of request_status
on public.gw_bereavement_leave_requests
for each row
execute function public.gw_sync_bereavement_leave_resolutions();

comment on column public.gw_bereavement_leave_requests.counting_method is
  'confirmed_workdays counts only scheduled workdays and skips existing days off.';

comment on table public.gw_bereavement_leave_request_days is
  'Confirmed-shift workday snapshots consumed by each bereavement leave request.';

commit;

