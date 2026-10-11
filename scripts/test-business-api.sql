-- Database-only synthetic fixtures. No real messages, notifications or business
-- rows are changed. The entire fixture and assertions are rolled back.
BEGIN;
DO $$
DECLARE actor uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); c uuid:=gen_random_uuid();
  pc text:='BusinessTest_'||replace(gen_random_uuid()::text,'-','');
  hash text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  machine_hash text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  digest text:=repeat('a',64); rid uuid:=gen_random_uuid(); r jsonb; v text; n bigint;
BEGIN
  INSERT INTO public.gw_users(id,line_user_id,display_name,status,role) VALUES
    (actor,'business-fixture-'||actor,'Business fixture','pending','executive'),
    (outsider,'business-fixture-'||outsider,'Business fixture outsider','pending','executive');
  -- Avoid consuming the nontransactional employee sequence on approval.
  INSERT INTO public.gw_payroll_employees(user_id,employee_code,display_name,payroll_status) VALUES
    (actor,'TEST-'||actor,'Business fixture','inactive'),(outsider,'TEST-'||outsider,'Business fixture outsider','inactive');
  UPDATE public.gw_users SET status='approved' WHERE id IN(actor,outsider);
  INSERT INTO public.gw_codex_mtg_machines(pc_name,token_hash,can_execute_code,created_by)
    VALUES(pc,machine_hash,false,actor);
  INSERT INTO public.gw_data_connections(id,label,token_hash,principal_user_id,scopes,allowed_group_ids,all_boards,pc_name,expires_at,created_by)
    VALUES(c,'Business fixture',hash,actor,ARRAY['boards.list'],'{}',true,pc,now()+interval '1 hour',actor);
  BEGIN PERFORM public.gw_business_api_authenticate(hash); RAISE EXCEPTION 'Expected denied default grant';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF; END;
  PERFORM public.gw_data_connection_business_access(actor,c,true);
  r:=public.gw_business_api_authenticate(hash);
  IF r->>'principalUserId'<>actor::text OR r->>'pcName'<>pc THEN RAISE EXCEPTION 'Wrong principal'; END IF;
  r:=public.gw_business_api_begin(hash,'fixture.write',digest,'fixture-write-key',rid);
  IF r->>'state'<>'started' THEN RAISE EXCEPTION 'First claim failed'; END IF;
  r:=public.gw_business_api_begin(hash,'fixture.write',digest,'fixture-write-key',gen_random_uuid());
  IF r->>'state'<>'pending' THEN RAISE EXCEPTION 'Pending write was repeated'; END IF;
  BEGIN PERFORM public.gw_business_api_begin(hash,'fixture.write',repeat('b',64),'fixture-write-key',gen_random_uuid()); RAISE EXCEPTION 'Expected hash conflict';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'IDEMPOTENCY_CONFLICT' THEN RAISE; END IF; END;
  BEGIN PERFORM public.gw_business_api_finish(hash,gen_random_uuid(),digest,'{}',200); RAISE EXCEPTION 'Expected owner mismatch';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'CONFLICT' THEN RAISE; END IF; END;
  PERFORM public.gw_business_api_finish(hash,rid,digest,'{"body":{"fixture":true}}',200);
  r:=public.gw_business_api_begin(hash,'fixture.write',digest,'fixture-write-key',gen_random_uuid());
  IF r->>'state'<>'completed' OR r->'response'->'body'->>'fixture'<>'true' THEN RAISE EXCEPTION 'Completed replay failed'; END IF;
  SELECT count(*) INTO n FROM public.gw_data_business_requests WHERE connection_id=c;
  IF n<>1 THEN RAISE EXCEPTION 'Duplicate mutation reservation'; END IF;
  BEGIN PERFORM public.gw_data_connection_business_access(outsider,c,false); RAISE EXCEPTION 'Expected ownership denial';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'NOT_FOUND' THEN RAISE; END IF; END;
  UPDATE public.gw_codex_mtg_machines SET revoked_at=now() WHERE pc_name=pc;
  BEGIN PERFORM public.gw_business_api_authenticate(hash); RAISE EXCEPTION 'Expected machine revocation denial';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF; END;
  UPDATE public.gw_codex_mtg_machines SET revoked_at=NULL WHERE pc_name=pc;
  UPDATE public.gw_data_connections SET expires_at=now()-interval '1 second' WHERE id=c;
  BEGIN PERFORM public.gw_business_api_authenticate(hash); RAISE EXCEPTION 'Expected expired key denial';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'UNAUTHORIZED' THEN RAISE; END IF; END;
  IF has_function_privilege('anon','public.gw_business_api_authenticate(text,text,uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.gw_business_api_begin(text,text,text,text,uuid)','EXECUTE')
    OR has_table_privilege('anon','public.gw_data_business_requests','SELECT')
    OR has_table_privilege('authenticated','public.gw_data_business_uploads','INSERT') THEN RAISE EXCEPTION 'Public access leak'; END IF;
  RAISE NOTICE 'Business MCP database fixtures passed';
END;
$$;
ROLLBACK;
