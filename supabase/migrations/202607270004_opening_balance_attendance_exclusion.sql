-- Opening-balance usage adjustments affect only paid-leave balances.
-- They must not block physical attendance or behave as paid work.

create or replace function public.gw_guard_paid_leave_allocation_against_punch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_request public.gw_paid_leave_requests%rowtype;
begin
  select *
  into target_request
  from public.gw_paid_leave_requests
  where id = new.request_id;

  if target_request.leave_unit = 'full_day'
     and target_request.raw_payload ->> 'opening_balance_adjustment' is distinct from 'true'
     and exists (
       select 1
       from public.gw_attendance_punches punches
       where punches.work_date = target_request.leave_date
         and punches.is_voided = false
         and (
           (
             target_request.employee_id is not null
             and punches.employee_id = target_request.employee_id
           )
           or (
             target_request.user_id is not null
             and punches.user_id = target_request.user_id
           )
         )
     )
  then
    raise exception '有給（全休）の日に実打刻があります。有給取消または打刻修正後に承認してください';
  end if;

  return new;
end;
$$;

create or replace function public.gw_guard_attendance_punch_against_paid_leave()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_voided = false
     and exists (
       select 1
       from public.gw_paid_leave_requests requests
       where requests.leave_date = new.work_date
         and requests.leave_unit = 'full_day'
         and requests.request_status in ('approved', 'consumed')
         and requests.raw_payload ->> 'opening_balance_adjustment' is distinct from 'true'
         and (
           (
             new.employee_id is not null
             and requests.employee_id = new.employee_id
           )
           or (
             new.user_id is not null
             and requests.user_id = new.user_id
           )
         )
     )
  then
    raise exception '有給（全休）が承認済みのため打刻できません。先に有給を取消してください';
  end if;

  return new;
end;
$$;

revoke all on function public.gw_guard_paid_leave_allocation_against_punch() from public;
revoke all on function public.gw_guard_attendance_punch_against_paid_leave() from public;
