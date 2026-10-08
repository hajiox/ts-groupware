-- Run in an isolated fixture database, or immediately after migration before
-- registering machines/starting workers. Refuses nonempty operational queues.
-- All fixture rows and role changes roll back. No external payload is sent;
-- the realtime wake signal is empty and optional.
BEGIN;
CREATE FUNCTION pg_temp.expect_mtg_error(expected text,token text,action text,args jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.gw_codex_mtg_machine(token,action,args);
  RAISE EXCEPTION 'Expected %; machine operation unexpectedly succeeded',expected;
EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>expected THEN RAISE; END IF;
END;
$$;
CREATE FUNCTION pg_temp.expect_mtg_admin_error(expected text,actor uuid,action text,args jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.gw_codex_mtg_admin(actor,action,args);
  RAISE EXCEPTION 'Expected %; admin operation unexpectedly succeeded',expected;
EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>expected THEN RAISE; END IF;
END;
$$;
DO $$
DECLARE
  actor uuid:=gen_random_uuid(); manager uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid();
  other_group uuid:=gen_random_uuid(); human_post uuid:=gen_random_uuid(); edited_post uuid:=gen_random_uuid();
  deleted_post uuid:=gen_random_uuid(); retired_post uuid:=gen_random_uuid(); timed_post uuid:=gen_random_uuid();
  token text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  remote_token text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  rotated_token text:=encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  owner uuid; remote uuid; job uuid; lease text; result_post uuid; request_post uuid;
  r jsonb; again jsonb; args jsonb; before_count bigint; seq_before bigint; called_before boolean;
  seq_after bigint; called_after boolean;
BEGIN
  IF EXISTS(SELECT 1 FROM public.gw_codex_mtg_jobs) OR EXISTS(SELECT 1 FROM public.gw_codex_mtg_machines) THEN
    RAISE EXCEPTION 'CodexMTG fixtures require no existing machines or jobs';
  END IF;
  IF to_regclass('public.gw_employee_code_seq') IS NOT NULL THEN
    EXECUTE 'SELECT last_value,is_called FROM public.gw_employee_code_seq' INTO seq_before,called_before;
  END IF;
  INSERT INTO public.gw_users(id,line_user_id,display_name,status,role,department) VALUES
    (actor,'mtg-fixture-'||actor,'MTG fixture executive','pending','executive','製造'),
    (manager,'mtg-fixture-'||manager,'MTG fixture manager','pending','admin','製造'),
    (outsider,'mtg-fixture-'||outsider,'MTG fixture member','pending','member','製造');
  -- Production HR triggers must neither match real people nor consume codes.
  IF to_regclass('public.gw_payroll_employees') IS NOT NULL THEN
    INSERT INTO public.gw_payroll_employees(user_id,employee_code,display_name,department,payroll_status) VALUES
      (actor,'TEST-'||actor,'MTG fixture executive','製造','inactive'),
      (manager,'TEST-'||manager,'MTG fixture manager','製造','inactive'),
      (outsider,'TEST-'||outsider,'MTG fixture member','製造','inactive');
  END IF;
  UPDATE public.gw_users SET status='approved' WHERE id IN (actor,manager,outsider);
  IF (SELECT count(*) FROM public.gw_group_members WHERE group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39' AND user_id IN(actor,manager))<>2 THEN
    RAISE EXCEPTION 'Approved management membership was not synchronized';
  END IF;
  BEGIN
    INSERT INTO public.gw_group_members(group_id,user_id) VALUES('a8081dbe-15db-4d41-a18b-b22bb55d2b39',outsider);
    RAISE EXCEPTION 'Nonmanagement membership was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.expect_mtg_admin_error('FORBIDDEN',outsider,'status','{}');
  PERFORM pg_temp.expect_mtg_admin_error('FORBIDDEN',manager,'register',jsonb_build_object('pcName','TSA','tokenHash',token));
  r:=public.gw_codex_mtg_admin(manager,'status','{}');
  IF r#>>'{data,status,ownerPcName}'<>'TSA' OR (r#>>'{data,status,online}')::boolean THEN RAISE EXCEPTION 'Manager status visibility failed'; END IF;
  r:=public.gw_codex_mtg_admin(actor,'register',jsonb_build_object('pcName','TSA','tokenHash',token)); owner:=(r#>>'{data,machine,id}')::uuid;
  r:=public.gw_codex_mtg_admin(actor,'register',jsonb_build_object('pcName','REMOTE','tokenHash',remote_token)); remote:=(r#>>'{data,machine,id}')::uuid;
  IF (r#>>'{data,machine,canExecuteCode}')::boolean THEN RAISE EXCEPTION 'Remote obtained execution privilege'; END IF;
  BEGIN
    UPDATE public.gw_codex_mtg_machines SET can_execute_code=true WHERE id=remote;
    RAISE EXCEPTION 'Execution check constraint failed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM pg_temp.expect_mtg_error('FORBIDDEN',remote_token,'claim','{}');
  PERFORM pg_temp.expect_mtg_error('VALIDATION',remote_token,'claim','{"pcName":"TSA"}');
  PERFORM pg_temp.expect_mtg_error('UNAUTHORIZED',repeat('0',64),'snapshot','{}');
  PERFORM pg_temp.expect_mtg_error('VALIDATION',token,'sql','{}');
  r:=public.gw_codex_mtg_machine(token,'machineHeartbeat','{}');
  IF r#>>'{data,machine,pcName}'<>'TSA' OR r::text LIKE '%token_hash%' OR r::text LIKE '%'||token||'%' THEN RAISE EXCEPTION 'Machine response leaked credentials'; END IF;

  -- Ordinary group deletion is unaffected by the fixed-group protection.
  INSERT INTO public.gw_groups(id,name,type) VALUES(other_group,'MTG ordinary fixture','chat');
  DELETE FROM public.gw_groups WHERE id=other_group;
  IF EXISTS(SELECT 1 FROM public.gw_groups WHERE id=other_group) THEN RAISE EXCEPTION 'Ordinary group deletion was blocked'; END IF;
  BEGIN
    UPDATE public.gw_groups SET type='board' WHERE id='a8081dbe-15db-4d41-a18b-b22bb55d2b39';
    RAISE EXCEPTION 'Fixed Chat identity was mutable';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.gw_posts(group_id,user_id,content) VALUES('a8081dbe-15db-4d41-a18b-b22bb55d2b39','f78baef5-d40c-4886-b51d-a02efbf794fe','【PC: TSA】 forged');
    RAISE EXCEPTION 'Bot PC prefix without authenticated metadata was accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF;
  END;

  INSERT INTO public.gw_posts(group_id,user_id,content,attachments)
  VALUES('a8081dbe-15db-4d41-a18b-b22bb55d2b39',actor,NULL,'[{"name":"synthetic-attachment"}]');
  IF NOT EXISTS(SELECT 1 FROM public.gw_codex_mtg_jobs WHERE author_id=actor AND content_snapshot=''
    AND status='needs_operator' AND summary='本文で依頼内容を入力してください') THEN
    RAISE EXCEPTION 'Attachment-only request would block the execution queue';
  END IF;

  INSERT INTO public.gw_posts(id,group_id,user_id,content) VALUES(human_post,'a8081dbe-15db-4d41-a18b-b22bb55d2b39',actor,'Synthetic human request');
  r:=public.gw_codex_mtg_machine(token,'claim','{}'); job:=(r#>>'{data,job,id}')::uuid; lease:=r#>>'{data,job,leaseToken}';
  IF r#>>'{data,job,origin}'<>'human' OR NOT (r#>>'{data,job,allowCodeChange}')::boolean OR (r#>>'{data,job,postId}')::uuid<>human_post THEN
    RAISE EXCEPTION 'Human request claim failed';
  END IF;
  r:=public.gw_codex_mtg_machine(token,'claim','{}');
  IF r#>'{data,job}'<>'null'::jsonb THEN RAISE EXCEPTION 'A second simultaneous owner job was claimed'; END IF;
  PERFORM pg_temp.expect_mtg_error('FORBIDDEN',token,'heartbeat',jsonb_build_object('jobId',job,'leaseToken',gen_random_uuid()));
  r:=public.gw_codex_mtg_machine(token,'heartbeat',jsonb_build_object('jobId',job,'leaseToken',lease));
  IF r#>>'{data,leaseExpiresAt}' IS NULL THEN RAISE EXCEPTION 'Heartbeat did not extend the lease'; END IF;
  args:=jsonb_build_object('jobId',job,'leaseToken',lease,'status','completed','summary','Synthetic completion');
  r:=public.gw_codex_mtg_machine(token,'complete',args); result_post:=(r#>>'{data,postId}')::uuid;
  again:=public.gw_codex_mtg_machine(token,'complete',args);
  IF NOT (again#>>'{data,duplicate}')::boolean OR (again#>>'{data,postId}')::uuid<>result_post THEN RAISE EXCEPTION 'Completion replay was not idempotent'; END IF;
  IF (SELECT count(*) FROM public.gw_codex_mtg_jobs)<>2 THEN RAISE EXCEPTION 'Completion report recursively created a job'; END IF;
  PERFORM pg_temp.expect_mtg_error('IDEMPOTENCY_CONFLICT',token,'complete',args||'{"summary":"Changed completion"}');

  before_count:=(SELECT count(*) FROM public.gw_codex_mtg_jobs);
  args:='{"sourceKey":"fixture-report","content":"Synthetic report","kind":"report"}';
  r:=public.gw_codex_mtg_machine(remote_token,'post',args); result_post:=(r#>>'{data,postId}')::uuid;
  again:=public.gw_codex_mtg_machine(remote_token,'post',args);
  IF NOT (again#>>'{data,duplicate}')::boolean OR (again#>>'{data,postId}')::uuid<>result_post THEN RAISE EXCEPTION 'Post replay was not idempotent'; END IF;
  IF (SELECT content FROM public.gw_posts WHERE id=result_post)<>E'【PC: REMOTE】\nSynthetic report'
    OR (SELECT user_id FROM public.gw_posts WHERE id=result_post)<>'f78baef5-d40c-4886-b51d-a02efbf794fe'::uuid THEN RAISE EXCEPTION 'Server PC/author binding failed'; END IF;
  IF (SELECT count(*) FROM public.gw_codex_mtg_jobs)<>before_count THEN RAISE EXCEPTION 'Bot report caused a response loop'; END IF;
  PERFORM pg_temp.expect_mtg_error('IDEMPOTENCY_CONFLICT',remote_token,'post',args||'{"content":"Different report"}');
  BEGIN
    UPDATE public.gw_posts SET content='【PC: TSA】 forged' WHERE id=result_post;
    RAISE EXCEPTION 'Bot metadata/prefix was editable';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF;
  END;
  DELETE FROM public.gw_posts WHERE id=result_post;
  again:=public.gw_codex_mtg_machine(remote_token,'post',args);
  IF NOT (again#>>'{data,duplicate}')::boolean OR EXISTS(SELECT 1 FROM public.gw_posts WHERE id=result_post) THEN RAISE EXCEPTION 'Retry recreated a deleted post'; END IF;

  r:=public.gw_codex_mtg_machine(remote_token,'post','{"sourceKey":"fixture-request","content":"Synthetic readonly request","kind":"request"}');
  request_post:=(r#>>'{data,postId}')::uuid;
  r:=public.gw_codex_mtg_machine(token,'claim','{}'); job:=(r#>>'{data,job,id}')::uuid; lease:=r#>>'{data,job,leaseToken}';
  IF r#>>'{data,job,origin}'<>'codex' OR (r#>>'{data,job,allowCodeChange}')::boolean OR (r#>>'{data,job,postId}')::uuid<>request_post THEN
    RAISE EXCEPTION 'Codex request received human/code authority';
  END IF;
  r:=public.gw_codex_mtg_machine(token,'complete',jsonb_build_object('jobId',job,'leaseToken',lease,'status','completed','summary','Readonly request answered'));

  INSERT INTO public.gw_posts(id,group_id,user_id,content) VALUES(edited_post,'a8081dbe-15db-4d41-a18b-b22bb55d2b39',actor,'Synthetic editable request');
  r:=public.gw_codex_mtg_machine(token,'claim','{}'); job:=(r#>>'{data,job,id}')::uuid; lease:=r#>>'{data,job,leaseToken}';
  UPDATE public.gw_posts SET content='Edited fixture request',updated_at=clock_timestamp() WHERE id=edited_post;
  r:=public.gw_codex_mtg_machine(token,'heartbeat',jsonb_build_object('jobId',job,'leaseToken',lease));
  IF r->>'code'<>'CONFLICT' OR (SELECT status FROM public.gw_codex_mtg_jobs WHERE id=job)<>'needs_operator' THEN RAISE EXCEPTION 'Edited claimed request kept executing'; END IF;
  INSERT INTO public.gw_posts(id,group_id,user_id,content) VALUES(deleted_post,'a8081dbe-15db-4d41-a18b-b22bb55d2b39',actor,'Synthetic deleted request');
  SELECT id INTO job FROM public.gw_codex_mtg_jobs WHERE post_id=deleted_post;
  DELETE FROM public.gw_posts WHERE id=deleted_post;
  IF (SELECT status FROM public.gw_codex_mtg_jobs WHERE id=job)<>'needs_operator' THEN RAISE EXCEPTION 'Deleted request was not cancelled'; END IF;
  INSERT INTO public.gw_posts(id,group_id,user_id,content) VALUES(retired_post,'a8081dbe-15db-4d41-a18b-b22bb55d2b39',manager,'Synthetic role-change request');
  UPDATE public.gw_users SET role='member' WHERE id=manager;
  IF EXISTS(SELECT 1 FROM public.gw_group_members WHERE group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39' AND user_id=manager)
    OR (SELECT status FROM public.gw_codex_mtg_jobs WHERE post_id=retired_post)<>'needs_operator' THEN RAISE EXCEPTION 'Management revocation did not remove access/work'; END IF;
  PERFORM pg_temp.expect_mtg_admin_error('FORBIDDEN',manager,'status','{}');
  UPDATE public.gw_users SET role='admin' WHERE id=manager;

  INSERT INTO public.gw_posts(id,group_id,user_id,content) VALUES(timed_post,'a8081dbe-15db-4d41-a18b-b22bb55d2b39',actor,'Synthetic timeout request');
  r:=public.gw_codex_mtg_machine(token,'claim','{}'); job:=(r#>>'{data,job,id}')::uuid; lease:=r#>>'{data,job,leaseToken}';
  UPDATE public.gw_codex_mtg_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=job;
  r:=public.gw_codex_mtg_machine(token,'claim','{}');
  IF r#>'{data,job}'<>'null'::jsonb OR (SELECT status FROM public.gw_codex_mtg_jobs WHERE id=job)<>'needs_operator' THEN RAISE EXCEPTION 'Expired job was automatically replayed'; END IF;
  r:=public.gw_codex_mtg_machine(token,'complete',jsonb_build_object('jobId',job,'leaseToken',lease,'status','completed','summary','Late completion'));
  IF r->>'code'<>'CONFLICT' THEN RAISE EXCEPTION 'Expired lease completed'; END IF;
  r:=public.gw_codex_mtg_admin(actor,'register',jsonb_build_object('pcName','TSA','tokenHash',rotated_token));
  PERFORM pg_temp.expect_mtg_error('UNAUTHORIZED',token,'snapshot','{}');
  r:=public.gw_codex_mtg_machine(rotated_token,'snapshot','{}');
  IF r#>>'{data,group,id}'<>'a8081dbe-15db-4d41-a18b-b22bb55d2b39' OR r::text LIKE '%'||rotated_token||'%' THEN RAISE EXCEPTION 'Snapshot boundary failed'; END IF;
  r:=public.gw_codex_mtg_admin(actor,'revoke',jsonb_build_object('machineId',remote));
  PERFORM pg_temp.expect_mtg_error('UNAUTHORIZED',remote_token,'snapshot','{}');
  IF has_function_privilege('anon','public.gw_codex_mtg_machine(text,text,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.gw_codex_mtg_admin(uuid,text,jsonb)','EXECUTE')
    OR has_table_privilege('anon','public.gw_codex_mtg_jobs','SELECT')
    OR NOT has_function_privilege('service_role','public.gw_codex_mtg_machine(text,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'RPC/table privilege boundary failed'; END IF;
  IF seq_before IS NOT NULL THEN
    EXECUTE 'SELECT last_value,is_called FROM public.gw_employee_code_seq' INTO seq_after,called_after;
    IF seq_before<>seq_after OR called_before<>called_after THEN RAISE EXCEPTION 'Fixtures consumed a real employee code'; END IF;
  END IF;
  RAISE NOTICE 'CodexMTG SQL fixtures passed';
END;
$$;
ROLLBACK;
