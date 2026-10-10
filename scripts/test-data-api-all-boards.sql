-- Run after 202610100001_data_all_boards.sql as the database operator.
-- Only random fixtures are written. Every schema/data change in a combined
-- migration dry run must be wrapped in this transaction and rolled back.
BEGIN;
CREATE FUNCTION pg_temp.expect_all_board_data_error(
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
CREATE FUNCTION pg_temp.expect_all_board_admin_error(expected text,actor uuid,action text,args jsonb)
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
  fixture_prefix text := 'All board fixture '||gen_random_uuid();
  own_board uuid := gen_random_uuid();
  new_board uuid := gen_random_uuid();
  private_chat uuid := gen_random_uuid();
  third_board uuid;
  board uuid;
  machine_id uuid := gen_random_uuid();
  machine_name text := 'Fixture_'||replace(gen_random_uuid()::text,'-','');
  bad_machine_name text := 'Missing_'||replace(gen_random_uuid()::text,'-','');
  bot constant uuid := 'f78baef5-d40c-4886-b51d-a02efbf794fe';
  restricted_token text := encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  full_token text := encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  narrow_token text := encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  extra_token text := encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
  restricted_id uuid;
  full_id uuid;
  narrow_id uuid;
  draft uuid;
  changed_draft uuid;
  long_draft uuid;
  post uuid;
  chat_post uuid := gen_random_uuid();
  other_task uuid := gen_random_uuid();
  own_task uuid;
  confirmation uuid;
  old_confirmation uuid;
  old_digest text;
  creation jsonb;
  permissions jsonb;
  r jsonb;
  again jsonb;
  first_page jsonb;
  second_page jsonb;
  args jsonb;
  expected_content text;
  task_version text;
  before_connection public.gw_data_connections;
  current_connection public.gw_data_connections;
  before_sequence bigint;
  before_called boolean;
  key_name text;
  list_operation text;
  function_name text;
  i integer;
BEGIN
  SELECT last_value,is_called INTO before_sequence,before_called FROM public.gw_employee_code_seq;
  INSERT INTO public.gw_users(id,line_user_id,display_name,status,role,department) VALUES
    (actor,'all-boards-rollback-'||actor,fixture_prefix||' owner','pending','executive','製造'),
    (outsider,'all-boards-rollback-'||outsider,fixture_prefix||' other owner','pending','executive','製造');
  -- Create fixture HR rows before approving users: approval must not allocate
  -- nontransactional employee numbers or match real unlinked employees.
  INSERT INTO public.gw_payroll_employees(user_id,employee_code,display_name,department,payroll_status) VALUES
    (actor,'TEST-'||actor,fixture_prefix||' owner','製造','inactive'),
    (outsider,'TEST-'||outsider,fixture_prefix||' other owner','製造','inactive');
  UPDATE public.gw_users SET status='approved' WHERE id IN(actor,outsider);
  INSERT INTO public.gw_groups(id,name,type,created_by) VALUES
    (own_board,fixture_prefix||' 01','board',actor),
    (private_chat,fixture_prefix||' private chat','chat',outsider);
  INSERT INTO public.gw_group_members(group_id,user_id) VALUES(own_board,actor),(private_chat,actor),(private_chat,outsider);
  INSERT INTO public.gw_posts(id,group_id,user_id,content) VALUES(chat_post,private_chat,outsider,fixture_prefix||' private DM content');
  INSERT INTO public.gw_codex_mtg_machines(id,pc_name,token_hash,can_execute_code,created_by,expires_at)
  VALUES(machine_id,machine_name,encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),false,actor,clock_timestamp()+interval '1 day');

  creation := jsonb_build_object('label',fixture_prefix||' restricted','token_hash',restricted_token,
    'principal_user_id',actor,'scopes',jsonb_build_array('boards.list','posts.search','posts.get','drafts.create','drafts.get','posts.publish.prepare','posts.publish.commit'),
    'allowed_group_ids',jsonb_build_array(own_board),'expires_at',clock_timestamp()+interval '1 day','max_limit',20);
  r := public.gw_data_connection_admin(actor,'create',creation);
  restricted_id := (r#>>'{data,connection,id}')::uuid;
  IF r#>>'{data,connection,all_boards}' IS DISTINCT FROM 'false'
    OR r#>>'{data,connection,pc_name}' IS NOT NULL OR (r#>'{data,connection}')?'token_hash' THEN
    RAISE EXCEPTION 'Legacy defaults changed / secret leaked'; END IF;
  PERFORM pg_temp.expect_all_board_admin_error('VALIDATION',actor,'create',creation||jsonb_build_object('token_hash',extra_token,'allowed_group_ids','[]'::jsonb));
  PERFORM pg_temp.expect_all_board_admin_error('VALIDATION',actor,'create',creation||jsonb_build_object('token_hash',extra_token,'all_boards','true'));
  PERFORM pg_temp.expect_all_board_admin_error('FORBIDDEN',actor,'create',creation||jsonb_build_object('token_hash',extra_token,'pc_name',bad_machine_name));
  PERFORM pg_temp.expect_all_board_admin_error('VALIDATION',actor,'create',creation||jsonb_build_object('token_hash',extra_token,'pc_name','bad PC'));
  r := public.gw_data_api_execute(restricted_token,'boards.list','{}',NULL,NULL,NULL,gen_random_uuid());
  IF jsonb_array_length(r#>'{data,boards}')<>1 OR r#>>'{data,boards,0,id}'<>own_board::text
    OR r#>'{data,nextOffset}' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Legacy board restriction changed'; END IF;

  -- Full-board mode does not implicitly grant omitted operations.
  r := public.gw_data_connection_admin(actor,'create',creation||jsonb_build_object('label',fixture_prefix||' narrow full',
    'token_hash',narrow_token,'scopes',jsonb_build_array('boards.list'),'all_boards',true,'allowed_group_ids','[]'::jsonb));
  narrow_id := (r#>>'{data,connection,id}')::uuid;
  PERFORM pg_temp.expect_all_board_data_error('FORBIDDEN',narrow_token,'posts.search','{}');
  r := public.gw_data_connection_admin(actor,'create',creation||jsonb_build_object('label',fixture_prefix||' full',
    'token_hash',full_token,'all_boards',true,'allowed_group_ids','[]'::jsonb,'pc_name',lower(machine_name),
    'scopes',jsonb_build_array('boards.list','posts.search','posts.get','knowledge.search','knowledge.get','drafts.create','drafts.update',
      'drafts.get','drafts.list','tasks.search','tasks.get','tasks.complete','posts.publish.prepare','posts.publish.commit')));
  full_id := (r#>>'{data,connection,id}')::uuid;
  IF r#>>'{data,connection,pc_name}'<>machine_name OR r#>>'{data,connection,all_boards}'<>'true'
    OR jsonb_array_length(r#>'{data,connection,allowed_group_ids}')<>0 THEN RAISE EXCEPTION 'Full-board creation / canonical PC identity failed'; END IF;
  SELECT * INTO before_connection FROM public.gw_data_connections WHERE id=full_id;
  permissions := jsonb_build_object('id',full_id,'scopes',to_jsonb(before_connection.scopes),
    'allowed_group_ids','[]'::jsonb,'all_boards',true,'pc_name',lower(machine_name));
  PERFORM pg_temp.expect_all_board_admin_error('NOT_FOUND',outsider,'permissions',permissions);
  PERFORM pg_temp.expect_all_board_admin_error('VALIDATION',actor,'permissions',permissions||jsonb_build_object('token_hash',restricted_token));
  PERFORM pg_temp.expect_all_board_admin_error('VALIDATION',actor,'permissions',permissions||'{"scopes":["raw.sql"]}');
  PERFORM pg_temp.expect_all_board_admin_error('VALIDATION',actor,'permissions',permissions||'{"scopes":[]}');
  PERFORM pg_temp.expect_all_board_admin_error('VALIDATION',actor,'permissions',permissions||'{"all_boards":false}');
  PERFORM pg_temp.expect_all_board_admin_error('FORBIDDEN',actor,'permissions',permissions||jsonb_build_object('pc_name',bad_machine_name));
  PERFORM public.gw_data_connection_admin(actor,'permissions',permissions);
  SELECT * INTO current_connection FROM public.gw_data_connections WHERE id=full_id;
  IF current_connection.token_hash<>before_connection.token_hash OR current_connection.expires_at<>before_connection.expires_at
    OR current_connection.principal_user_id<>before_connection.principal_user_id OR current_connection.created_by<>before_connection.created_by
    OR current_connection.created_at<>before_connection.created_at THEN RAISE EXCEPTION 'Permissions rotated identity, key or expiry'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.gw_data_audit WHERE connection_id=full_id AND operation='admin.permissions'
      AND actor_user_id=actor AND before_data->>'pc_name'=machine_name AND after_data->>'all_boards'='true') THEN
    RAISE EXCEPTION 'Permissions audit missing'; END IF;
  r := public.gw_data_connection_admin(actor,'list','{}');
  IF NOT (r#>'{data,pcNames}')?machine_name OR r::text LIKE '%'||full_token||'%' OR r::text LIKE '%'||restricted_token||'%' THEN
    RAISE EXCEPTION 'Admin PC list missing / token exposed'; END IF;

  -- New boards appear immediately, even without human board memberships.
  INSERT INTO public.gw_groups(id,name,type,created_by) VALUES(new_board,fixture_prefix||' 02','board',outsider);
  FOR i IN 3..23 LOOP
    board:=gen_random_uuid();
    INSERT INTO public.gw_groups(id,name,type,created_by) VALUES(board,fixture_prefix||' '||lpad(i::text,2,'0'),'board',outsider);
    IF i=3 THEN third_board:=board; END IF;
  END LOOP;
  r := public.gw_data_api_execute(full_token,'boards.list',jsonb_build_object('query',fixture_prefix,'limit',20),NULL,NULL,NULL,gen_random_uuid());
  IF jsonb_array_length(r#>'{data,boards}')<>20 OR r#>>'{data,nextOffset}'<>'20' THEN RAISE EXCEPTION 'All-board page 1 truncated visibility'; END IF;
  r := public.gw_data_api_execute(full_token,'boards.list',jsonb_build_object('query',fixture_prefix,'limit',20,'offset',20),NULL,NULL,NULL,gen_random_uuid());
  IF jsonb_array_length(r#>'{data,boards}')<>3 OR r#>'{data,nextOffset}' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'New boards / board page 2 / terminal cursor failed'; END IF;
  IF EXISTS(SELECT 1 FROM public.gw_group_members WHERE group_id=new_board AND user_id=actor) THEN RAISE EXCEPTION 'Full-board mode inserted human membership'; END IF;
  PERFORM pg_temp.expect_all_board_data_error('FORBIDDEN',restricted_token,'posts.search',jsonb_build_object('group_id',new_board));
  PERFORM pg_temp.expect_all_board_data_error('FORBIDDEN',full_token,'posts.search',jsonb_build_object('group_id',private_chat));
  PERFORM pg_temp.expect_all_board_data_error('FORBIDDEN',full_token,'posts.get',jsonb_build_object('id',chat_post));
  PERFORM pg_temp.expect_all_board_data_error('FORBIDDEN',full_token,'drafts.create',jsonb_build_object('group_id',private_chat,'content','must not post'),'chat-forbidden');
  PERFORM pg_temp.expect_all_board_data_error('VALIDATION',full_token,'boards.list','{"offset":-1}');
  PERFORM pg_temp.expect_all_board_data_error('VALIDATION',full_token,'boards.list','{"offset":10001}');
  PERFORM pg_temp.expect_all_board_data_error('VALIDATION',full_token,'boards.list','{"offset":0.5}');
  PERFORM pg_temp.expect_all_board_data_error('VALIDATION',full_token,'boards.list','{"offset":"1"}');
  PERFORM pg_temp.expect_all_board_data_error('VALIDATION',full_token,'boards.list','{"limit":21}');
  r := public.gw_data_api_execute(full_token,'boards.list','{"offset":10000}',NULL,NULL,NULL,gen_random_uuid());
  IF jsonb_array_length(r#>'{data,boards}')<>0 OR r#>'{data,nextOffset}' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Maximum empty offset failed'; END IF;

  FOR i IN 1..3 LOOP
    post:=gen_random_uuid();
    INSERT INTO public.gw_posts(id,group_id,user_id,content,is_pinned) VALUES(post,new_board,outsider,fixture_prefix||' content '||i,true);
    INSERT INTO public.gw_tasks(id,post_id,group_id,requester_id,assignee_id,due_date)
      VALUES(gen_random_uuid(),post,new_board,outsider,actor,DATE '2099-01-01'+i) RETURNING id INTO own_task;
    PERFORM public.gw_data_api_execute(full_token,'drafts.create',jsonb_build_object('group_id',new_board,'content',fixture_prefix||' draft '||i),
      'fixture-create-'||i,NULL,NULL,gen_random_uuid());
  END LOOP;
  INSERT INTO public.gw_tasks(id,post_id,group_id,requester_id,assignee_id,due_date)
    VALUES(other_task,post,new_board,outsider,outsider,DATE '2099-01-01');
  FOREACH list_operation IN ARRAY ARRAY['posts.search','knowledge.search','drafts.list','tasks.search'] LOOP
    key_name := CASE list_operation WHEN 'posts.search' THEN 'posts' WHEN 'knowledge.search' THEN 'entries' WHEN 'drafts.list' THEN 'drafts' ELSE 'tasks' END;
    args:=jsonb_build_object('group_id',new_board,'limit',1);
    first_page:=public.gw_data_api_execute(full_token,list_operation,args,NULL,NULL,NULL,gen_random_uuid());
    second_page:=public.gw_data_api_execute(full_token,list_operation,args||'{"offset":1}',NULL,NULL,NULL,gen_random_uuid());
    r:=public.gw_data_api_execute(full_token,list_operation,args||'{"offset":2}',NULL,NULL,NULL,gen_random_uuid());
    IF jsonb_array_length(first_page->'data'->key_name)<>1 OR first_page#>>'{data,nextOffset}'<>'1'
      OR second_page#>>'{data,nextOffset}'<>'2' OR first_page->'data'->key_name->0->>'id'=second_page->'data'->key_name->0->>'id'
      OR jsonb_array_length(r->'data'->key_name)<>1 OR r#>'{data,nextOffset}' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'Pagination / isolation failed for %',list_operation; END IF;
  END LOOP;
  PERFORM pg_temp.expect_all_board_data_error('NOT_FOUND',full_token,'tasks.get',jsonb_build_object('id',other_task));
  r:=public.gw_data_api_execute(full_token,'tasks.get',jsonb_build_object('id',own_task),NULL,NULL,NULL,gen_random_uuid());
  task_version:=r#>>'{data,task,version}';
  r:=public.gw_data_api_execute(full_token,'tasks.complete',jsonb_build_object('id',own_task),'fixture-complete-task',task_version,NULL,gen_random_uuid());
  IF r#>>'{data,task,completed_by}'<>actor::text THEN RAISE EXCEPTION 'Bot identity leaked into task actor'; END IF;

  args:=jsonb_build_object('group_id',new_board,'content','業務報告です。'||chr(10)||'確認用本文');
  r:=public.gw_data_api_execute(full_token,'drafts.create',args,'full-create-publish',NULL,NULL,gen_random_uuid());
  draft:=(r#>>'{data,draft,id}')::uuid;
  r:=public.gw_data_api_execute(full_token,'posts.publish.prepare',jsonb_build_object('id',draft),'full-prepare-publish','1',NULL,gen_random_uuid());
  confirmation:=(r#>>'{data,confirmation_id}')::uuid;
  expected_content:='【PC: '||machine_name||'】'||chr(10)||(args->>'content');
  IF r#>>'{data,diff,after,author_id}'<>bot::text OR r#>>'{data,diff,after,content}'<>expected_content
    OR r#>>'{data,requiresApproval}' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'TSG bot preview / prefix / approval contract failed'; END IF;
  -- A registered PC's coordination credential expiry/revocation is independent
  -- of an already-issued business credential. Only configuration rechecks it.
  UPDATE public.gw_codex_mtg_machines SET expires_at=clock_timestamp()-interval '1 second',revoked_at=clock_timestamp() WHERE id=machine_id;
  PERFORM pg_temp.expect_all_board_admin_error('FORBIDDEN',actor,'permissions',permissions);
  PERFORM public.gw_data_connection_admin(actor,'permissions',permissions-'pc_name');
  r:=public.gw_data_api_execute(full_token,'posts.publish.commit',jsonb_build_object('id',draft),'full-commit-publish','1',confirmation,gen_random_uuid());
  again:=public.gw_data_api_execute(full_token,'posts.publish.commit',jsonb_build_object('id',draft),'full-commit-publish','1',confirmation,gen_random_uuid());
  post:=(r#>>'{data,post_id}')::uuid;
  IF r<>again OR NOT EXISTS(SELECT 1 FROM public.gw_posts WHERE id=post AND user_id=bot AND content=expected_content)
    OR (SELECT content FROM public.gw_data_drafts WHERE id=draft)<>args->>'content'
    OR EXISTS(SELECT 1 FROM public.gw_data_confirmations WHERE id=confirmation AND (approved_at IS NOT NULL OR approved_by IS NOT NULL))
    OR NOT EXISTS(SELECT 1 FROM public.gw_data_audit WHERE connection_id=full_id AND operation='posts.publish.commit'
      AND actor_user_id=actor AND after_data#>>'{post,author_id}'=bot::text AND after_data#>>'{post,content}'=expected_content) THEN
    RAISE EXCEPTION 'Exact bot commit / body preservation / principal audit / idempotency failed'; END IF;
  UPDATE public.gw_codex_mtg_machines SET expires_at=clock_timestamp()+interval '1 day',revoked_at=NULL WHERE id=machine_id;

  -- A PC identity change invalidates any frozen old preview. The old optional
  -- approval RPC uses the same publication identity and content as commit.
  r:=public.gw_data_api_execute(full_token,'drafts.create',jsonb_build_object('group_id',new_board,'content','identity fixture'),'identity-draft-create',NULL,NULL,gen_random_uuid());
  changed_draft:=(r#>>'{data,draft,id}')::uuid;
  r:=public.gw_data_api_execute(full_token,'posts.publish.prepare',jsonb_build_object('id',changed_draft),'identity-prepare-old','1',NULL,gen_random_uuid());
  old_confirmation:=(r#>>'{data,confirmation_id}')::uuid;
  old_digest:=r#>>'{data,digest}';
  PERFORM public.gw_data_connection_admin(actor,'permissions',permissions||'{"pc_name":null}');
  PERFORM pg_temp.expect_all_board_data_error('CONFLICT',full_token,'posts.publish.commit',jsonb_build_object('id',changed_draft),'identity-commit-stale','1',old_confirmation);
  PERFORM pg_temp.expect_all_board_admin_error('CONFLICT',actor,'approve_confirmation',jsonb_build_object('id',old_confirmation,'digest',old_digest));
  r:=public.gw_data_api_execute(full_token,'posts.publish.prepare',jsonb_build_object('id',changed_draft),'identity-prepare-new','1',NULL,gen_random_uuid());
  IF r#>>'{data,diff,after,author_id}'<>actor::text OR r#>>'{data,diff,after,content}'<>'identity fixture' THEN
    RAISE EXCEPTION 'Unregistered legacy identity changed'; END IF;
  confirmation:=(r#>>'{data,confirmation_id}')::uuid;
  PERFORM public.gw_data_connection_admin(actor,'approve_confirmation',jsonb_build_object('id',confirmation,'digest',r#>>'{data,digest}'));
  PERFORM public.gw_data_api_execute(full_token,'posts.publish.commit',jsonb_build_object('id',changed_draft),'identity-commit-new','1',confirmation,gen_random_uuid());
  PERFORM public.gw_data_connection_admin(actor,'permissions',permissions);
  r:=public.gw_data_api_execute(full_token,'drafts.create',jsonb_build_object('group_id',third_board,'content','legacy approval bot fixture'),'bot-approval-create',NULL,NULL,gen_random_uuid());
  draft:=(r#>>'{data,draft,id}')::uuid;
  r:=public.gw_data_api_execute(full_token,'posts.publish.prepare',jsonb_build_object('id',draft),'bot-approval-prepare','1',NULL,gen_random_uuid());
  confirmation:=(r#>>'{data,confirmation_id}')::uuid;
  PERFORM public.gw_data_connection_admin(actor,'approve_confirmation',jsonb_build_object('id',confirmation,'digest',r#>>'{data,digest}'));
  UPDATE public.gw_groups SET posting_disabled=true WHERE id=third_board;
  PERFORM pg_temp.expect_all_board_data_error('FORBIDDEN',full_token,'posts.publish.commit',jsonb_build_object('id',draft),'bot-approval-disabled','1',confirmation);
  PERFORM pg_temp.expect_all_board_admin_error('FORBIDDEN',actor,'approve_confirmation',jsonb_build_object('id',confirmation,'digest',r#>>'{data,digest}'));
  UPDATE public.gw_groups SET posting_disabled=false WHERE id=third_board;
  PERFORM public.gw_data_api_execute(full_token,'posts.publish.commit',jsonb_build_object('id',draft),'bot-approval-commit','1',confirmation,gen_random_uuid());

  r:=public.gw_data_api_execute(full_token,'drafts.create',jsonb_build_object('group_id',new_board,'content',repeat('長',4000)),'prefix-max-create',NULL,NULL,gen_random_uuid());
  long_draft:=(r#>>'{data,draft,id}')::uuid;
  PERFORM pg_temp.expect_all_board_data_error('VALIDATION',full_token,'posts.publish.prepare',jsonb_build_object('id',long_draft),'prefix-too-long','1');
  PERFORM public.gw_data_api_execute(full_token,'drafts.update',jsonb_build_object('id',long_draft,
    'content',repeat('長',4000-char_length('【PC: '||machine_name||'】'||chr(10)))),'prefix-max-update','1',NULL,gen_random_uuid());
  r:=public.gw_data_api_execute(full_token,'posts.publish.prepare',jsonb_build_object('id',long_draft),'prefix-max-prepare','2',NULL,gen_random_uuid());
  IF char_length(r#>>'{data,diff,after,content}')<>4000 THEN RAISE EXCEPTION 'Final public content length boundary failed'; END IF;

  -- Restricting a full connection immediately removes old-board access and
  -- replay access; unrelated legacy keys and their selected boards stay intact.
  PERFORM public.gw_data_connection_admin(actor,'permissions',permissions||jsonb_build_object('all_boards',false,'allowed_group_ids',jsonb_build_array(own_board)));
  PERFORM pg_temp.expect_all_board_data_error('FORBIDDEN',full_token,'posts.get',jsonb_build_object('id',post));
  PERFORM pg_temp.expect_all_board_data_error('FORBIDDEN',full_token,'drafts.create',args,'full-create-publish');
  r:=public.gw_data_api_execute(restricted_token,'boards.list','{}',NULL,NULL,NULL,gen_random_uuid());
  IF jsonb_array_length(r#>'{data,boards}')<>1 THEN RAISE EXCEPTION 'Other credential permission changed'; END IF;
  DELETE FROM public.gw_group_members WHERE user_id=actor AND group_id=own_board;
  r:=public.gw_data_api_execute(restricted_token,'boards.list','{}',NULL,NULL,NULL,gen_random_uuid());
  IF jsonb_array_length(r#>'{data,boards}')<>0 THEN RAISE EXCEPTION 'Legacy membership revocation ignored'; END IF;
  PERFORM pg_temp.expect_all_board_admin_error('FORBIDDEN',actor,'permissions',permissions||jsonb_build_object('all_boards',false,'allowed_group_ids',jsonb_build_array(own_board)));
  PERFORM public.gw_data_connection_admin(actor,'permissions',permissions);
  UPDATE public.gw_users SET status='suspended' WHERE id=actor;
  PERFORM pg_temp.expect_all_board_data_error('UNAUTHORIZED',full_token,'boards.list','{}');
  UPDATE public.gw_users SET status='approved' WHERE id=actor;
  UPDATE public.gw_data_connections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=narrow_id;
  PERFORM pg_temp.expect_all_board_data_error('UNAUTHORIZED',narrow_token,'boards.list','{}');
  PERFORM pg_temp.expect_all_board_admin_error('UNAUTHORIZED',actor,'permissions',permissions||jsonb_build_object('id',narrow_id));
  PERFORM public.gw_data_connection_admin(actor,'revoke',jsonb_build_object('id',full_id));
  PERFORM pg_temp.expect_all_board_data_error('UNAUTHORIZED',full_token,'boards.list','{}');
  PERFORM pg_temp.expect_all_board_admin_error('UNAUTHORIZED',actor,'permissions',permissions);

  FOREACH function_name IN ARRAY ARRAY['public.gw_data_api_execute(text,text,jsonb,text,text,uuid,uuid)',
    'public.gw_data_connection_admin(uuid,text,jsonb)','public.gw_data_registered_pc(text)','public.gw_data_publication(text,uuid,text)'] LOOP
    IF has_function_privilege('anon',function_name,'EXECUTE') OR has_function_privilege('authenticated',function_name,'EXECUTE') THEN
      RAISE EXCEPTION 'Unprivileged RPC exposure: %',function_name; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role','public.gw_data_api_execute(text,text,jsonb,text,text,uuid,uuid)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.gw_data_connection_admin(uuid,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'Service role RPC permissions lost'; END IF;
  IF (SELECT last_value FROM public.gw_employee_code_seq)<>before_sequence OR (SELECT is_called FROM public.gw_employee_code_seq)<>before_called THEN
    RAISE EXCEPTION 'Synthetic fixtures consumed real employee number'; END IF;
END;
$$;
ROLLBACK;
SELECT 'All-board SQL regression passed: future boards, five bounded pages, legacy key isolation, owner-only grants, registered PC bot identity, exact prefix/CAS/no approval, task actor/audit, scope/account/revocation/expiry, private helper ACLs; fixtures rolled back' AS result;
