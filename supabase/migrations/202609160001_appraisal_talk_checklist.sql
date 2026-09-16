-- Persist the manager's private checklist of topics explained during each appraisal interview.
create or replace function public.gw_valid_appraisal_talk_checklist(value jsonb)
returns boolean language plpgsql immutable set search_path = public as $$
declare item text;
begin
  if jsonb_typeof(value) is distinct from 'object' then return false; end if;
  if (select count(*) from jsonb_object_keys(value)) <> 5 then return false; end if;
  foreach item in array array['company_teamwork','company_skills','company_cost','requests','harassment'] loop
    if jsonb_typeof(value->item) is distinct from 'boolean' then return false; end if;
  end loop;
  return true;
end $$;

alter table public.gw_employee_appraisals
  add column if not exists talk_checklist jsonb not null default
    '{"company_teamwork":false,"company_skills":false,"company_cost":false,"requests":false,"harassment":false}'::jsonb;

alter table public.gw_employee_appraisals
  drop constraint if exists gw_employee_appraisals_talk_checklist_check;
alter table public.gw_employee_appraisals
  add constraint gw_employee_appraisals_talk_checklist_check
  check (public.gw_valid_appraisal_talk_checklist(talk_checklist));

create or replace function public.gw_save_employee_appraisal(
  p_reviewer uuid, p_employee uuid, p_month date, p_assessed_on date,
  p_ratings jsonb, p_talk_checklist jsonb, p_status text, p_version integer
) returns public.gw_employee_appraisals
language plpgsql set search_path = public as $$
declare saved public.gw_employee_appraisals;
begin
  if p_version = 0 then
    insert into public.gw_employee_appraisals
      (reviewer_id, employee_id, period_month, assessed_on, ratings, talk_checklist, status, completed_at)
    values
      (p_reviewer,p_employee,p_month,p_assessed_on,p_ratings,p_talk_checklist,p_status,case when p_status='completed' then now() end)
    on conflict (reviewer_id,employee_id,period_month) do nothing returning * into saved;
  else
    update public.gw_employee_appraisals set assessed_on=p_assessed_on, ratings=p_ratings,
      talk_checklist=p_talk_checklist, status=p_status,
      completed_at=case when p_status='completed' then now() end, version=version+1,updated_at=now()
    where reviewer_id=p_reviewer and employee_id=p_employee and period_month=p_month and version=p_version
    returning * into saved;
  end if;
  if saved.id is null then raise exception 'APPRAISAL_CONFLICT' using errcode='P0001'; end if;
  return saved;
end $$;

revoke all on function public.gw_valid_appraisal_talk_checklist(jsonb) from public,anon,authenticated;
grant execute on function public.gw_valid_appraisal_talk_checklist(jsonb) to service_role;
revoke all on function public.gw_save_employee_appraisal(uuid,uuid,date,date,jsonb,jsonb,text,integer) from public,anon,authenticated;
grant execute on function public.gw_save_employee_appraisal(uuid,uuid,date,date,jsonb,jsonb,text,integer) to service_role;
