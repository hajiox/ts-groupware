-- Run as the service/database operator after the scoped Data API migration.
-- All records are random fixtures and rolled back. Existing business records,
-- memberships, roles, drafts, tasks, tokens and employee sequences are unchanged.
BEGIN;
CREATE FUNCTION pg_temp.expect_data_error(
  expected text,token_hash text,operation text,args jsonb,
  idem text DEFAULT NULL,version text DEFAULT NULL,confirmation uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.gw_data_api_execute(token_hash,operation,args,idem,version,confirmation,gen_random_uuid());
  RAISE EXCEPTION 'Expected %, operation unexpectedly succeeded',expected;
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>expected THEN RAISE; END IF;
END;
$$;
CREATE FUNCTION pg_temp.expect_admin_error(expected text,actor uuid,action text,args jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.gw_data_connection_admin(actor,action,args);
  RAISE EXCEPTION 'Expected %, admin action unexpectedly succeeded',expected;
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>expected THEN RAISE; END IF;
END;
$$;

DO $$
DECLARE
  actor uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  fake_board uuid := gen_random_uuid();
  other_board uuid := gen_random_uuid();
  fake_chat uuid := gen_random_uuid();
  post_id uuid := gen_random_uuid();
  hidden_post uuid := gen_random_uuid();
  fake_task uuid := gen_random_uuid();
  other_task uuid := gen_random_uuid();
  fixture_connection uuid;
  second_connection uuid;
  draft_id uuid;
  fresh_draft uuid;
  confirmation_id uuid;
  old_confirmation uuid;
  expired_confirmation uuid;
  group_name_value text;
  token_value text := encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  second_token text := encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  scopes text[] := ARRAY['boards.list','posts.search','posts.get','knowledge.search','knowledge.get',
    'drafts.create','drafts.update','drafts.get','drafts.list','tasks.search','tasks.get','tasks.complete',
    'posts.publish.prepare','posts.publish.commit'];
  creation jsonb;
  r jsonb;
  again jsonb;
  args jsonb;
  task_version text;
  digest_value text;
  sequence_before bigint;
  called_before boolean;
  actual_role text;
  row_name text;
  f text;
BEGIN
  SELECT last_value,is_called INTO sequence_before,called_before FROM public.gw_employee_code_seq;
  INSERT INTO public.gw_users(id,line_user_id,display_name,status,role,department) VALUES
    (actor,'data-api-rollback-'||actor,'Data API fixture '||actor,'pending','executive','製造'),
    (outsider,'data-api-rollback-'||outsider,'Data API fixture '||outsider,'pending','member','製造');
  -- Pre-create only new fixture HR rows before activation to avoid matching a
  -- real unlinked employee or consuming the nontransactional employee sequence.
  INSERT INTO public.gw_payroll_employees(user_id,employee_code,display_name,department,payroll_status) VALUES
    (actor,'TEST-'||actor,'Data API fixture '||actor,'製造','inactive'),
    (outsider,'TEST-'||outsider,'Data API fixture '||outsider,'製造','inactive');
  UPDATE public.gw_users SET status='approved' WHERE id IN (actor,outsider);
  INSERT INTO public.gw_groups(id,name,type,created_by) VALUES
    (fake_board,'Data API fixture board '||fake_board,'board',actor),
    (other_board,'Data API fixture private board '||other_board,'board',outsider),
    (fake_chat,'Data API fixture chat '||fake_chat,'chat',actor);
  INSERT INTO public.gw_group_members(group_id,user_id) VALUES
    (fake_board,actor),(other_board,outsider),(fake_chat,actor);
  INSERT INTO public.gw_posts(id,group_id,user_id,content,is_pinned) VALUES
    (post_id,fake_board,actor,'Synthetic pinned knowledge',true),
    (hidden_post,other_board,outsider,'Private fixture content',true);
  INSERT INTO public.gw_tasks(id,post_id,group_id,requester_id,assignee_id,due_date) VALUES
    (fake_task,post_id,fake_board,actor,actor,DATE '2099-01-01'),
    (other_task,post_id,fake_board,actor,outsider,DATE '2099-01-01');

  creation := jsonb_build_object('label','Regression connection','token_hash',token_value,
    'principal_user_id',actor,'scopes',to_jsonb(scopes),'allowed_group_ids',jsonb_build_array(fake_board),
    'expires_at',clock_timestamp()+interval '1 day','max_limit',20);
  PERFORM pg_temp.expect_admin_error('FORBIDDEN',outsider,'create',creation);
  UPDATE public.gw_users SET display_name='佐藤正彦' WHERE id=outsider;
  PERFORM pg_temp.expect_admin_error('FORBIDDEN',outsider,'create',creation);
  UPDATE public.gw_users SET display_name='Data API fixture '||outsider WHERE id=outsider;
  PERFORM pg_temp.expect_admin_error('VALIDATION',actor,'create',creation||jsonb_build_object('principal_user_id',outsider));
  PERFORM pg_temp.expect_admin_error('FORBIDDEN',actor,'create',creation||jsonb_build_object('allowed_group_ids',jsonb_build_array(other_board)));
  PERFORM pg_temp.expect_admin_error('FORBIDDEN',actor,'create',creation||jsonb_build_object('allowed_group_ids',jsonb_build_array(fake_chat)));
  PERFORM pg_temp.expect_admin_error('VALIDATION',actor,'create',creation||'{"scopes":["raw.sql"]}');
  PERFORM pg_temp.expect_admin_error('VALIDATION',actor,'create',creation||'{"allowed_group_ids":[]}');
  PERFORM pg_temp.expect_admin_error('VALIDATION',actor,'create',creation||jsonb_build_object('expires_at',clock_timestamp()+interval '91 days'));
  PERFORM pg_temp.expect_admin_error('VALIDATION',actor,'create',creation||'{"max_limit":21}');
  r := public.gw_data_connection_admin(actor,'create',creation);
  fixture_connection := (r #>> '{data,connection,id}')::uuid;
  IF fixture_connection IS NULL OR (r #> '{data,connection}') ? 'token_hash' THEN RAISE EXCEPTION 'Connection create exposed a secret / omitted id'; END IF;
  again := public.gw_data_connection_admin(actor,'create',creation);
  IF r<>again THEN RAISE EXCEPTION 'Same credential issuance was not idempotent'; END IF;
  r := public.gw_data_connection_admin(actor,'list','{}');
  IF r::text LIKE '%'||token_value||'%' OR jsonb_array_length(r #> '{data,connections}')<>1
    OR r #>> '{data,principal,id}'<>actor::text THEN RAISE EXCEPTION 'Admin list failed owner isolation / credential redaction'; END IF;

  PERFORM pg_temp.expect_data_error('UNAUTHORIZED',repeat('0',64),'boards.list','{}');
  PERFORM pg_temp.expect_data_error('VALIDATION',token_value,'raw.sql','{}');
  PERFORM pg_temp.expect_data_error('VALIDATION',token_value,'posts.search','{"sql":"select 1"}');
  PERFORM pg_temp.expect_data_error('VALIDATION',token_value,'posts.search','[]');
  PERFORM pg_temp.expect_data_error('VALIDATION',token_value,'posts.search','{"limit":21}');
  PERFORM pg_temp.expect_data_error('VALIDATION',token_value,'posts.search','{"limit":"20"}');
  PERFORM pg_temp.expect_data_error('VALIDATION',token_value,'posts.search','{"limit":1.5}');
  PERFORM pg_temp.expect_data_error('VALIDATION',token_value,'posts.search','{}','read-idem-invalid');
  PERFORM pg_temp.expect_data_error('VALIDATION',token_value,'posts.search','{}',NULL,'unnecessary-version');
  PERFORM pg_temp.expect_data_error('VALIDATION',token_value,'posts.search',jsonb_build_object('query',repeat('a',257)));
  PERFORM pg_temp.expect_data_error('FORBIDDEN',token_value,'posts.search',jsonb_build_object('group_id',other_board));
  PERFORM pg_temp.expect_data_error('FORBIDDEN',token_value,'posts.get',jsonb_build_object('id',hidden_post));
  r := public.gw_data_api_execute(token_value,'boards.list','{}',NULL,NULL,NULL,gen_random_uuid());
  IF jsonb_array_length(r #> '{data,boards}')<>1 OR r #>> '{data,boards,0,id}'<>fake_board::text THEN
    RAISE EXCEPTION 'Board list leaked disallowed boards / chats'; END IF;
  r := public.gw_data_api_execute(token_value,'knowledge.search','{"query":"knowledge"}',NULL,NULL,NULL,gen_random_uuid());
  IF jsonb_array_length(r #> '{data,entries}')<>1 OR r #>> '{data,entries,0,id}'<>post_id::text THEN
    RAISE EXCEPTION 'Pinned knowledge search failed'; END IF;
  UPDATE public.gw_posts SET is_pinned=false WHERE id=post_id;
  PERFORM pg_temp.expect_data_error('NOT_FOUND',token_value,'knowledge.get',jsonb_build_object('id',post_id));
  r := public.gw_data_api_execute(token_value,'knowledge.search','{}',NULL,NULL,NULL,gen_random_uuid());
  IF jsonb_array_length(r #> '{data,entries}')<>0 THEN RAISE EXCEPTION 'Unpinned post leaked into knowledge'; END IF;
  UPDATE public.gw_posts SET is_pinned=true WHERE id=post_id;

  args := jsonb_build_object('group_id',fake_board,'content','Synthetic draft v1');
  PERFORM pg_temp.expect_data_error('VALIDATION',token_value,'drafts.create',args);
  PERFORM pg_temp.expect_data_error('VALIDATION',token_value,'drafts.create',args,'short');
  PERFORM pg_temp.expect_data_error('VALIDATION',token_value,'drafts.create',args||'{"content":"\n\t　"}','invalid-space');
  PERFORM pg_temp.expect_data_error('VALIDATION',token_value,'drafts.create',args||jsonb_build_object('content',repeat('a',4001)),'long-content');
  r := public.gw_data_api_execute(token_value,'drafts.create',args,'create-draft-1',NULL,NULL,gen_random_uuid());
  draft_id := (r #>> '{data,draft,id}')::uuid;
  again := public.gw_data_api_execute(token_value,'drafts.create',args,'create-draft-1',NULL,NULL,gen_random_uuid());
  IF r<>again OR (SELECT count(*) FROM public.gw_data_drafts q WHERE q.connection_id=fixture_connection AND q.id=draft_id)<>1 THEN
    RAISE EXCEPTION 'Draft retry duplicated content / changed response'; END IF;
  PERFORM pg_temp.expect_data_error('IDEMPOTENCY_CONFLICT',token_value,'drafts.create',args||'{"content":"different"}','create-draft-1');
  PERFORM pg_temp.expect_data_error('VALIDATION',token_value,'drafts.update',jsonb_build_object('id',draft_id,'content','v2'),'update-draft-1');
  PERFORM pg_temp.expect_data_error('CONFLICT',token_value,'drafts.update',jsonb_build_object('id',draft_id,'content','v2'),'update-draft-1','0');
  r := public.gw_data_api_execute(token_value,'drafts.update',jsonb_build_object('id',draft_id,'content','Synthetic draft v2'),'update-draft-1','1',NULL,gen_random_uuid());
  IF r #>> '{data,draft,version}'<>'2' THEN RAISE EXCEPTION 'Draft CAS did not advance version'; END IF;
  PERFORM pg_temp.expect_data_error('CONFLICT',token_value,'drafts.update',jsonb_build_object('id',draft_id,'content','stale'),'update-draft-stale','1');
  creation := creation || jsonb_build_object('label','Second fixture connection','token_hash',second_token,
    'scopes',jsonb_build_array('drafts.get','boards.list'),'max_limit',1);
  r := public.gw_data_connection_admin(actor,'create',creation);
  second_connection := (r #>> '{data,connection,id}')::uuid;
  PERFORM pg_temp.expect_data_error('FORBIDDEN',second_token,'posts.get',jsonb_build_object('id',post_id));
  PERFORM pg_temp.expect_data_error('NOT_FOUND',second_token,'drafts.get',jsonb_build_object('id',draft_id));
  PERFORM pg_temp.expect_data_error('VALIDATION',second_token,'boards.list','{"limit":2}');

  PERFORM pg_temp.expect_data_error('NOT_FOUND',token_value,'tasks.get',jsonb_build_object('id',other_task));
  r := public.gw_data_api_execute(token_value,'tasks.search','{}',NULL,NULL,NULL,gen_random_uuid());
  IF jsonb_array_length(r #> '{data,tasks}')<>1 THEN RAISE EXCEPTION 'Other assignee task leaked'; END IF;
  task_version := r #>> '{data,tasks,0,version}';
  PERFORM pg_temp.expect_data_error('CONFLICT',token_value,'tasks.complete',jsonb_build_object('id',fake_task),'complete-task-stale','stale');
  r := public.gw_data_api_execute(token_value,'tasks.complete',jsonb_build_object('id',fake_task),'complete-task-1',task_version,NULL,gen_random_uuid());
  again := public.gw_data_api_execute(token_value,'tasks.complete',jsonb_build_object('id',fake_task),'complete-task-1',task_version,NULL,gen_random_uuid());
  IF r<>again OR r #>> '{data,task,completed_by}'<>actor::text OR r #>> '{data,task,completed_at}' IS NULL THEN
    RAISE EXCEPTION 'Task completion / idempotent retry failed'; END IF;

  r := public.gw_data_api_execute(token_value,'posts.publish.prepare',jsonb_build_object('id',draft_id),'prepare-draft-1','2',NULL,gen_random_uuid());
  old_confirmation := (r #>> '{data,confirmation_id}')::uuid;
  digest_value := r #>> '{data,digest}';
  IF r #>> '{data,diff,after,group_id}'<>fake_board::text OR r #>> '{data,diff,after,content}'<>'Synthetic draft v2'
    OR r #>> '{data,diff,after,group_name}' NOT LIKE 'Data API fixture board %' THEN
    RAISE EXCEPTION 'Immutable approval preview did not include exact destination / content'; END IF;
  PERFORM pg_temp.expect_data_error('CONFIRMATION_REQUIRED',token_value,'posts.publish.commit',jsonb_build_object('id',draft_id),'commit-unapproved','2',old_confirmation);
  PERFORM pg_temp.expect_admin_error('FORBIDDEN',outsider,'approve_confirmation',jsonb_build_object('id',old_confirmation,'digest',digest_value));
  PERFORM pg_temp.expect_admin_error('CONFLICT',actor,'approve_confirmation',jsonb_build_object('id',old_confirmation,'digest',repeat('0',64)));
  PERFORM public.gw_data_connection_admin(actor,'approve_confirmation',jsonb_build_object('id',old_confirmation,'digest',digest_value));
  BEGIN
    UPDATE public.gw_data_confirmations SET diff='{}' WHERE id=old_confirmation;
    RAISE EXCEPTION 'Approved confirmation diff was mutable';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'CONFLICT' THEN RAISE; END IF;
  END;
  INSERT INTO public.gw_data_confirmations(connection_id,draft_id,draft_version,diff,digest,status,approved_by,approved_at,expires_at)
  SELECT q.connection_id,q.draft_id,q.draft_version,q.diff,q.digest,'approved',actor,now(),clock_timestamp()-interval '1 second'
  FROM public.gw_data_confirmations q WHERE q.id=old_confirmation RETURNING id INTO expired_confirmation;
  PERFORM pg_temp.expect_admin_error('CONFIRMATION_REQUIRED',actor,'approve_confirmation',jsonb_build_object('id',expired_confirmation,'digest',digest_value));
  PERFORM pg_temp.expect_data_error('CONFIRMATION_REQUIRED',token_value,'posts.publish.commit',jsonb_build_object('id',draft_id),'commit-expired-preview','2',expired_confirmation);
  PERFORM public.gw_data_api_execute(token_value,'drafts.update',jsonb_build_object('id',draft_id,'content','Synthetic draft v3'),'update-draft-2','2',NULL,gen_random_uuid());
  PERFORM pg_temp.expect_data_error('CONFLICT',token_value,'posts.publish.commit',jsonb_build_object('id',draft_id),'commit-stale-preview','3',old_confirmation);
  r := public.gw_data_api_execute(token_value,'posts.publish.prepare',jsonb_build_object('id',draft_id),'prepare-draft-2','3',NULL,gen_random_uuid());
  confirmation_id := (r #>> '{data,confirmation_id}')::uuid;
  digest_value := r #>> '{data,digest}';
  DELETE FROM public.gw_group_members WHERE group_id=fake_board AND user_id=actor;
  PERFORM pg_temp.expect_admin_error('FORBIDDEN',actor,'approve_confirmation',jsonb_build_object('id',confirmation_id,'digest',digest_value));
  INSERT INTO public.gw_group_members(group_id,user_id) VALUES(fake_board,actor);
  PERFORM public.gw_data_connection_admin(actor,'approve_confirmation',jsonb_build_object('id',confirmation_id,'digest',digest_value));
  SELECT name INTO group_name_value FROM public.gw_groups WHERE id=fake_board;
  UPDATE public.gw_groups SET name='Changed destination preview' WHERE id=fake_board;
  PERFORM pg_temp.expect_data_error('CONFLICT',token_value,'posts.publish.commit',jsonb_build_object('id',draft_id),'commit-changed-destination','3',confirmation_id);
  UPDATE public.gw_groups SET name=group_name_value WHERE id=fake_board;
  UPDATE public.gw_users SET role='member' WHERE id=actor;
  PERFORM pg_temp.expect_data_error('UNAUTHORIZED',token_value,'boards.list','{}');
  PERFORM pg_temp.expect_data_error('UNAUTHORIZED',token_value,'posts.publish.commit',jsonb_build_object('id',draft_id),'commit-demoted-approver','3',confirmation_id);
  UPDATE public.gw_users SET role='executive' WHERE id=actor;
  UPDATE public.gw_groups SET posting_disabled=true WHERE id=fake_board;
  PERFORM pg_temp.expect_data_error('FORBIDDEN',token_value,'posts.publish.commit',jsonb_build_object('id',draft_id),'commit-readonly-board','3',confirmation_id);
  UPDATE public.gw_groups SET posting_disabled=false WHERE id=fake_board;
  r := public.gw_data_api_execute(token_value,'posts.publish.commit',jsonb_build_object('id',draft_id),'commit-draft-1','3',confirmation_id,gen_random_uuid());
  again := public.gw_data_api_execute(token_value,'posts.publish.commit',jsonb_build_object('id',draft_id),'commit-draft-1','3',confirmation_id,gen_random_uuid());
  IF r<>again OR r #>> '{data,status}'<>'published' OR (SELECT count(*) FROM public.gw_posts WHERE group_id=fake_board AND content='Synthetic draft v3')<>1
    OR (SELECT status FROM public.gw_data_confirmations WHERE id=confirmation_id)<>'committed' THEN
    RAISE EXCEPTION 'Approved publication / retry / immutable confirmation failed'; END IF;
  PERFORM pg_temp.expect_data_error('CONFLICT',token_value,'drafts.update',jsonb_build_object('id',draft_id,'content','published edit'),'update-published','4');

  -- Replays must still respect current membership and account state.
  DELETE FROM public.gw_group_members WHERE group_id=fake_board AND user_id=actor;
  PERFORM pg_temp.expect_data_error('FORBIDDEN',token_value,'drafts.create',args,'create-draft-1');
  PERFORM pg_temp.expect_data_error('FORBIDDEN',token_value,'posts.get',jsonb_build_object('id',post_id));
  INSERT INTO public.gw_group_members(group_id,user_id) VALUES(fake_board,actor);
  UPDATE public.gw_users SET status='suspended' WHERE id=actor;
  PERFORM pg_temp.expect_data_error('UNAUTHORIZED',token_value,'boards.list','{}');
  UPDATE public.gw_users SET status='approved' WHERE id=actor;
  UPDATE public.gw_data_connections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=second_connection;
  PERFORM pg_temp.expect_data_error('UNAUTHORIZED',second_token,'drafts.get',jsonb_build_object('id',draft_id));
  PERFORM public.gw_data_connection_admin(actor,'revoke',jsonb_build_object('id',fixture_connection));
  PERFORM pg_temp.expect_data_error('UNAUTHORIZED',token_value,'boards.list','{}');

  r := public.gw_data_connection_admin(actor,'list_audit','{"limit":20}');
  IF r::text LIKE '%'||token_value||'%' OR r::text LIKE '%'||second_token||'%'
    OR NOT EXISTS(SELECT 1 FROM public.gw_data_audit a WHERE a.connection_id=fixture_connection AND a.operation='drafts.update'
      AND a.before_data->>'content'='Synthetic draft v1' AND a.after_data->>'content'='Synthetic draft v2') THEN
    RAISE EXCEPTION 'Audit omitted business before/after or exposed credentials'; END IF;
  FOREACH row_name IN ARRAY ARRAY['gw_data_connections','gw_data_drafts','gw_data_audit','gw_data_idempotency','gw_data_confirmations',
    'gw_groups','gw_group_members','gw_posts','gw_tasks'] LOOP
    IF has_table_privilege('anon','public.'||row_name,'SELECT,INSERT,UPDATE,DELETE')
      OR has_table_privilege('authenticated','public.'||row_name,'SELECT,INSERT,UPDATE,DELETE')
      OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid=('public.'||row_name)::regclass) THEN
      RAISE EXCEPTION 'Data API private table privileges failed for %',row_name; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.gw_data_api_execute(text,text,jsonb,text,text,uuid,uuid)',
    'public.gw_data_connection_admin(uuid,text,jsonb)',
    'public.gw_approve_paid_leave_request_with_management_post(uuid,uuid)',
    'public.gw_approve_paid_leave_request(uuid,uuid)',
    'public.gw_approve_paid_leave_request_flexible(uuid,uuid)',
    'public.gw_confirm_workday_resolution(uuid,uuid,text)',
    'public.gw_create_and_approve_paid_leave_request(jsonb,uuid)',
    'public.gw_create_shift_confirmation_alerts(uuid)',
    'public.gw_import_paid_leave_usage(uuid,uuid,numeric,date,text,uuid)',
    'public.gw_link_paid_leave_request_to_shift(uuid,uuid)',
    'public.gw_reject_paid_leave_request(uuid,uuid,text)',
    'public.gw_reopen_workday_resolution(uuid,uuid)',
    'public.gw_retire_payroll_employee(uuid,date,uuid)',
    'public.gw_sync_shift_paid_leave_batch(uuid,jsonb,uuid)'] LOOP
    IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE')
      OR NOT has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'Data API RPC exposure failed'; END IF;
  END LOOP;
  -- Check actual role failures as well as grant metadata. WHERE false ensures
  -- these negative DML checks cannot change a business row if a grant regresses.
  FOREACH actual_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I',actual_role);
    FOREACH row_name IN ARRAY ARRAY['gw_groups','gw_group_members','gw_posts','gw_tasks',
      'gw_data_connections','gw_data_drafts','gw_data_audit','gw_data_idempotency','gw_data_confirmations'] LOOP
      BEGIN
        EXECUTE format('SELECT 1 FROM public.%I LIMIT 0',row_name);
        RAISE EXCEPTION 'Unprivileged table SELECT unexpectedly succeeded';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE false',row_name);
        RAISE EXCEPTION 'Unprivileged table DELETE unexpectedly succeeded';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    END LOOP;
    BEGIN
      PERFORM public.gw_data_api_execute(repeat('0',64),'boards.list','{}',NULL,NULL,NULL,gen_random_uuid());
      RAISE EXCEPTION 'Unprivileged RPC EXECUTE unexpectedly succeeded';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    EXECUTE 'SET LOCAL ROLE NONE';
  END LOOP;
  IF (SELECT last_value FROM public.gw_employee_code_seq)<>sequence_before
    OR (SELECT is_called FROM public.gw_employee_code_seq)<>called_before THEN RAISE EXCEPTION 'Fixture consumed a real employee number'; END IF;
END;
$$;
ROLLBACK;
SELECT 'Data API SQL regression passed: strict schema, credential/scoped board isolation, pinned knowledge, drafts/CAS/idempotency, assigned tasks, exact approved publication, dynamic revocation and private audit; all fixtures rolled back' AS result;
