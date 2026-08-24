-- Backfill the HR link on punches created during the new-hire synchronization window.
update public.gw_attendance_punches punches
set employee_id = employees.id,
    updated_at = now()
from public.gw_payroll_employees employees
where punches.employee_id is null
  and punches.user_id = employees.user_id
  and employees.payroll_status = 'active';

create or replace function public.gw_fill_attendance_employee_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.employee_id is null and new.user_id is not null then
    select employees.id
    into new.employee_id
    from public.gw_payroll_employees employees
    where employees.user_id = new.user_id
      and employees.payroll_status = 'active'
    order by employees.updated_at desc
    limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_gw_attendance_fill_employee_id
  on public.gw_attendance_punches;
create trigger trg_gw_attendance_fill_employee_id
before insert or update of user_id, employee_id
on public.gw_attendance_punches
for each row
execute function public.gw_fill_attendance_employee_id();

-- Employee 145 joined after the historical labor-office import. Her written
-- employment terms in HR data specify part-time hourly pay of JPY 1,060.
insert into public.gw_pay_rates (
  employee_id,
  workplace_id,
  rate_type,
  amount,
  effective_from,
  note,
  raw_payload
)
select
  employees.id,
  null,
  'hourly',
  1060,
  '2026-07-15',
  '人事情報の採用時雇用条件（時給1,060円）',
  jsonb_build_object('source', 'hr_employment_terms')
from public.gw_payroll_employees employees
where employees.employee_code = '145'
  and employees.payroll_status = 'active'
on conflict (employee_id, rate_type, effective_from)
where workplace_id is null
do update
set amount = excluded.amount,
    effective_to = null,
    note = excluded.note,
    raw_payload = excluded.raw_payload;

insert into public.gw_payroll_calculation_profiles (
  employee_id,
  effective_from,
  effective_to,
  calculation_type,
  hourly_rate,
  taxable_additions,
  deduction_snapshot,
  source_snapshot,
  verification,
  source_note
)
select
  employees.id,
  '2026-07-15',
  null,
  'hourly',
  1060,
  '{}'::jsonb,
  '{}'::jsonb,
  jsonb_build_object('source', 'hr_employment_terms'),
  jsonb_build_object('status', 'pending_first_labor_office_comparison'),
  '人事情報の採用時雇用条件から初期設定。初回労務士計算との照合対象'
from public.gw_payroll_employees employees
where employees.employee_code = '145'
  and employees.payroll_status = 'active'
on conflict (employee_id, effective_from)
do update
set effective_to = null,
    calculation_type = excluded.calculation_type,
    hourly_rate = excluded.hourly_rate,
    source_snapshot = excluded.source_snapshot,
    verification = excluded.verification,
    source_note = excluded.source_note,
    updated_at = now();

revoke all on function public.gw_fill_attendance_employee_id() from public;

