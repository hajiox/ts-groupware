-- Run only in an isolated PostgreSQL database after the pledge and new-hire pledge migrations.
begin;

insert into public.gw_users (
  id, line_user_id, display_name, real_name, department, status, created_at, onboarding_completed_at
) values
  ('00000000-0000-0000-0000-000000000001', 'line:due', '対象1', '対象1', 'フロア', 'approved', '2026-09-01 00:00:00+09', '2026-09-01 00:00:00+09'),
  ('00000000-0000-0000-0000-000000000002', 'line:waiting', '対象2', '対象2', '製造', 'approved', '2026-09-02 00:00:00+09', '2026-09-02 00:00:00+09'),
  ('00000000-0000-0000-0000-000000000003', 'line:assigned', '対象3', '対象3', '道の駅', 'approved', '2026-09-01 00:00:00+09', '2026-09-01 00:00:00+09'),
  ('00000000-0000-0000-0000-000000000004', 'line:pending', '対象4', '対象4', 'フロア', 'pending', '2026-09-01 00:00:00+09', null),
  ('00000000-0000-0000-0000-000000000099', 'system:tsg', 'TSG君', 'TSG君', '製造', 'approved', '2026-01-01 00:00:00+09', '2026-01-01 00:00:00+09');

insert into public.gw_payroll_employees (id, user_id, payroll_status, hire_date, raw_payload) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'active', '2026-09-01', '{}'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'active', '2026-09-02', '{}'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000003', 'active', '2026-09-01', '{}');

with template as (
  select * from public.gw_pledge_templates where id = '00000000-0000-4000-8000-000000000001'
), delivery as (
  insert into public.gw_pledge_deliveries (
    template_id, title_snapshot, body_snapshot, check_items_snapshot,
    agreement_label_snapshot, company_name_snapshot, target_type, target_label, is_test, sent_at
  )
  select id, title, body, check_items, agreement_label, company_name, 'individual', '対象3', false, '2026-09-01 00:00:00+09'
  from template
  returning id
)
insert into public.gw_pledge_assignments (delivery_id, user_id, recipient_name, recipient_department, status)
select id, '00000000-0000-0000-0000-000000000003', '対象3', '道の駅', 'pending' from delivery;

do $$
declare dispatched integer; failed boolean;
begin
  select count(*) into dispatched
  from public.gw_dispatch_new_hire_pledges('2026-09-08 09:05:00+09');
  if dispatched <> 1 then raise exception 'expected one due pledge, got %', dispatched; end if;

  if not exists (
    select 1
    from public.gw_pledge_assignments assignments
    join public.gw_pledge_deliveries deliveries on deliveries.id = assignments.delivery_id
    where assignments.user_id = '00000000-0000-0000-0000-000000000001'
      and assignments.status = 'pending'
      and deliveries.delivery_kind = 'new_hire_auto'
      and deliveries.automation_user_id = assignments.user_id
  ) then raise exception 'due pledge assignment was not created'; end if;

  select count(*) into dispatched
  from public.gw_dispatch_new_hire_pledges('2026-09-08 09:06:00+09');
  if dispatched <> 0 then raise exception 'idempotent rerun created a duplicate'; end if;

  select count(*) into dispatched
  from public.gw_dispatch_new_hire_pledges('2026-09-09 09:05:00+09');
  if dispatched <> 1 then raise exception 'waiting employee did not become eligible'; end if;

  update public.gw_users set status = 'approved' where id = '00000000-0000-0000-0000-000000000004';
  if (select onboarding_completed_at is null from public.gw_users where id = '00000000-0000-0000-0000-000000000004') then
    raise exception 'approval did not stamp onboarding completion';
  end if;

  failed := false;
  begin
    insert into public.gw_pledge_deliveries (
      title_snapshot, body_snapshot, check_items_snapshot, agreement_label_snapshot,
      company_name_snapshot, target_type, is_test, delivery_kind, automation_user_id
    ) values ('x','x','[]','x','x','all',false,'new_hire_auto','00000000-0000-0000-0000-000000000001');
  exception when check_violation then failed := true; end;
  if not failed then raise exception 'invalid automatic delivery was accepted'; end if;

  if has_function_privilege('anon','public.gw_dispatch_new_hire_pledges(timestamptz)','EXECUTE')
     or has_function_privilege('authenticated','public.gw_dispatch_new_hire_pledges(timestamptz)','EXECUTE') then
    raise exception 'automatic pledge RPC is publicly executable';
  end if;

  raise notice 'New-hire pledge SQL: seven-day boundary, existing assignment exclusion, idempotency, approval stamp and grants passed';
end $$;

rollback;
