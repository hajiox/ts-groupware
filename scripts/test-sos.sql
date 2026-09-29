do $$
declare d uuid; a public.gw_sos_alerts; b public.gw_sos_alerts; n integer;
begin
 select id into d from public.gw_attendance_devices where code='michinoeki' and is_active limit 1;
 if d is null then raise exception 'Missing device'; end if;
 a:=public.gw_create_sos(d); b:=public.gw_create_sos(d);
 if a.id<>b.id then raise exception 'Double tap duplicate'; end if;
 select count(*) into n from public.gw_claim_due_sos(a.id);
 if n<>1 then raise exception 'Initial dispatch missing'; end if;
 select count(*) into n from public.gw_claim_due_sos(a.id);
 if n<>0 then raise exception 'Duplicate dispatch'; end if;
 if not exists(select 1 from public.gw_sos_alerts where id=a.id and next_notification_at=now()+interval '2 minutes') then raise exception 'Retry interval'; end if;
 update public.gw_sos_alerts set next_notification_at=now()-interval '1 second' where id=a.id;
 select count(*) into n from public.gw_claim_due_sos(a.id);
 if n<>1 then raise exception 'Retry missing'; end if;
 update public.gw_sos_alerts set status='acknowledged',next_notification_at=now()-interval '1 second' where id=a.id;
 select count(*) into n from public.gw_claim_due_sos(a.id);
 if n<>0 then raise exception 'Acknowledged dispatched'; end if;
 b:=public.gw_create_sos(d);
 if b.id<>a.id then raise exception 'Active duplicate'; end if;
 update public.gw_sos_alerts set status='resolved' where id=a.id;
 b:=public.gw_create_sos(d);
 if b.id=a.id then raise exception 'New SOS blocked after resolution'; end if;
 if has_function_privilege('anon','public.gw_create_sos(uuid)','EXECUTE') or has_table_privilege('authenticated','public.gw_sos_alerts','SELECT') then raise exception 'Privilege leakage'; end if;
end $$;
