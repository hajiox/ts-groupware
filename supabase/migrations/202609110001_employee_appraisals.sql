-- Confidential monthly appraisals. All access goes through the authorized server API.
create table if not exists public.gw_appraisal_assignments (
  reviewer_id uuid not null references public.gw_users(id),
  employee_id uuid not null references public.gw_payroll_employees(id),
  assigned_by uuid not null references public.gw_users(id),
  created_at timestamptz not null default now(),
  primary key (reviewer_id, employee_id)
);
alter table public.gw_appraisal_assignments enable row level security;
revoke all on public.gw_appraisal_assignments from public, anon, authenticated;
grant all on public.gw_appraisal_assignments to service_role;

create or replace function public.gw_valid_appraisal_ratings(value jsonb, require_complete boolean)
returns boolean language plpgsql immutable set search_path = public as $$
declare item text; rating jsonb;
begin
  if jsonb_typeof(value) is distinct from 'object' then return false; end if;
  if (select count(*) from jsonb_object_keys(value)) <> 10 then return false; end if;
  foreach item in array array['teamwork','instructions','concentration','proficiency','speed','accuracy','cost','tidiness','safety','shift'] loop
    rating := value->item;
    if rating is null or jsonb_typeof(rating) is distinct from 'object' then return false; end if;
    if jsonb_typeof(rating->'comment') is distinct from 'string' or length(rating->>'comment') > 2000 then return false; end if;
    if not (rating ? 'score') then return false; end if;
    if rating->'score' = 'null'::jsonb then
      if require_complete then return false; end if;
    elsif jsonb_typeof(rating->'score') is distinct from 'number' or (rating->>'score') !~ '^[1-5]$' then return false;
    end if;
  end loop;
  return true;
end $$;

create table if not exists public.gw_employee_appraisals (
  id uuid primary key default gen_random_uuid(),
  reviewer_id uuid not null references public.gw_users(id),
  employee_id uuid not null references public.gw_payroll_employees(id),
  period_month date not null check (extract(day from period_month) = 1),
  assessed_on date not null,
  ratings jsonb not null,
  status text not null check (status in ('draft','completed')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (reviewer_id, employee_id, period_month),
  check (public.gw_valid_appraisal_ratings(ratings, status = 'completed')),
  check ((status = 'completed') = (completed_at is not null))
);
alter table public.gw_employee_appraisals enable row level security;
revoke all on public.gw_employee_appraisals from public, anon, authenticated;
grant all on public.gw_employee_appraisals to service_role;
create index if not exists gw_employee_appraisals_month_idx on public.gw_employee_appraisals(period_month);

create or replace function public.gw_save_employee_appraisal(
  p_reviewer uuid, p_employee uuid, p_month date, p_assessed_on date,
  p_ratings jsonb, p_status text, p_version integer
) returns public.gw_employee_appraisals
language plpgsql set search_path = public as $$
declare saved public.gw_employee_appraisals;
begin
  if p_version = 0 then
    insert into public.gw_employee_appraisals (reviewer_id, employee_id, period_month, assessed_on, ratings, status, completed_at)
    values (p_reviewer,p_employee,p_month,p_assessed_on,p_ratings,p_status,case when p_status='completed' then now() end)
    on conflict (reviewer_id,employee_id,period_month) do nothing returning * into saved;
  else
    update public.gw_employee_appraisals set assessed_on=p_assessed_on, ratings=p_ratings,status=p_status,
      completed_at=case when p_status='completed' then now() end, version=version+1,updated_at=now()
    where reviewer_id=p_reviewer and employee_id=p_employee and period_month=p_month and version=p_version
    returning * into saved;
  end if;
  if saved.id is null then raise exception 'APPRAISAL_CONFLICT' using errcode='P0001'; end if;
  return saved;
end $$;
revoke all on function public.gw_save_employee_appraisal(uuid,uuid,date,date,jsonb,text,integer) from public,anon,authenticated;
grant execute on function public.gw_save_employee_appraisal(uuid,uuid,date,date,jsonb,text,integer) to service_role;
revoke all on function public.gw_valid_appraisal_ratings(jsonb,boolean) from public,anon,authenticated;
grant execute on function public.gw_valid_appraisal_ratings(jsonb,boolean) to service_role;
