-- Source copy of supabase/migrations/202608010001_safe_employee_retirement.sql.
-- Retirement suspends login/push delivery while retaining HR, payroll, attendance,
-- posts, and all historical foreign-key links.
create or replace function public.gw_retire_payroll_employee(
  p_employee_id uuid,
  p_resigned_date date,
  p_actor_id uuid default null
)
returns table(employee_id uuid, user_id uuid, resigned_date date, payroll_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user_id uuid;
  target_hire_date date;
begin
  if p_resigned_date is null then raise exception '退職日を入力してください'; end if;
  select employee.user_id, employee.hire_date into target_user_id, target_hire_date
  from public.gw_payroll_employees employee where employee.id = p_employee_id for update;
  if not found then raise exception '従業員が見つかりません'; end if;
  if target_hire_date is not null and p_resigned_date < target_hire_date then
    raise exception '退職日は入社日以降を指定してください';
  end if;
  update public.gw_payroll_employees employee
  set payroll_status = 'retired', resigned_date = p_resigned_date,
      raw_payload = coalesce(employee.raw_payload, '{}'::jsonb) || jsonb_build_object(
        'retirement', jsonb_build_object('resigned_date', p_resigned_date, 'processed_at', now(), 'processed_by', p_actor_id)
      ), updated_at = now()
  where employee.id = p_employee_id;
  if target_user_id is not null then
    update public.gw_users set status = 'suspended', updated_at = now() where id = target_user_id;
    delete from public.gw_push_subscriptions subscriptions where subscriptions.user_id = target_user_id;
  end if;
  return query select employee.id, employee.user_id, employee.resigned_date, employee.payroll_status
  from public.gw_payroll_employees employee where employee.id = p_employee_id;
end;
$$;
revoke all on function public.gw_retire_payroll_employee(uuid, date, uuid) from public;
grant execute on function public.gw_retire_payroll_employee(uuid, date, uuid) to service_role;
