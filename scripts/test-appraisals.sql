-- Run only in an isolated test database after applying 062_employee_appraisals.sql.
begin;
insert into public.gw_users(id) values ('00000000-0000-0000-0000-000000000001');
insert into public.gw_payroll_employees(id) values ('00000000-0000-0000-0000-000000000002');
do $$
declare ratings jsonb; saved public.gw_employee_appraisals; failed boolean;
begin
  select jsonb_object_agg(key,jsonb_build_object('score',null,'comment','')) into ratings
  from unnest(array['teamwork','instructions','concentration','proficiency','speed','accuracy','cost','tidiness','safety','shift']) key;
  if not public.gw_valid_appraisal_ratings(ratings,false) or public.gw_valid_appraisal_ratings(ratings,true) then raise exception 'draft validation failed'; end if;
  saved := public.gw_save_employee_appraisal('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','2026-09-01','2026-09-11',ratings,'draft',0);
  if saved.version <> 1 or saved.completed_at is not null then raise exception 'draft save failed'; end if;
  failed := false;
  begin
    perform public.gw_save_employee_appraisal(saved.reviewer_id,saved.employee_id,saved.period_month,saved.assessed_on,ratings,'draft',0);
  exception when raise_exception then failed := sqlerrm='APPRAISAL_CONFLICT'; end;
  if not failed then raise exception 'duplicate creation was not rejected'; end if;
  failed := false;
  begin
    perform public.gw_save_employee_appraisal(saved.reviewer_id,saved.employee_id,saved.period_month,saved.assessed_on,ratings,'completed',1);
  exception when check_violation then failed := true; end;
  if not failed then raise exception 'incomplete completion was not rejected'; end if;
  select jsonb_object_agg(key,jsonb_build_object('score',3,'comment','test')) into ratings from jsonb_object_keys(ratings) key;
  saved := public.gw_save_employee_appraisal(saved.reviewer_id,saved.employee_id,saved.period_month,saved.assessed_on,ratings,'completed',1);
  if saved.version <> 2 or saved.completed_at is null then raise exception 'completion failed'; end if;
  failed := false;
  begin
    perform public.gw_save_employee_appraisal(saved.reviewer_id,saved.employee_id,saved.period_month,saved.assessed_on,ratings,'draft',1);
  exception when raise_exception then failed := sqlerrm='APPRAISAL_CONFLICT'; end;
  if not failed then raise exception 'stale update was not rejected'; end if;
  if public.gw_valid_appraisal_ratings(jsonb_set(ratings,'{speed,score}','6'),true) then raise exception 'score validation failed'; end if;
  if has_table_privilege('anon','public.gw_employee_appraisals','SELECT') or has_table_privilege('authenticated','public.gw_employee_appraisals','SELECT') then raise exception 'private table is exposed'; end if;
  if has_function_privilege('anon','public.gw_save_employee_appraisal(uuid,uuid,date,date,jsonb,text,integer)','EXECUTE') then raise exception 'private RPC is exposed'; end if;
  raise notice 'Appraisal SQL: draft/completion, invalid rating, duplicate/stale writes, private grants passed';
end $$;
rollback;
