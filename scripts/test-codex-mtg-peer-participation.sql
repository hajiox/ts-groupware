-- Isolated fixture database only. All rows roll back; never use an operational project.
BEGIN;
CREATE FUNCTION pg_temp.expect_peer_error(expected text,token text,args jsonb) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.gw_codex_mtg_peer(token,'peerComplete',args);
  RAISE EXCEPTION 'Expected %; completion unexpectedly succeeded',expected;
EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>expected THEN RAISE; END IF;
END;
$$;
DO $$
DECLARE
  actor uuid:=gen_random_uuid(); owner uuid; peer uuid; second_peer uuid; history_peer uuid;
  owner_token text:=repeat('a',64); token text:=repeat('b',64); token2 text:=repeat('c',64);
  owner_lease uuid:=gen_random_uuid(); peer_lease uuid:=gen_random_uuid(); queued_job uuid; active_job uuid;
  manual_post uuid; question_post uuid; second_question uuid; owner_result uuid; unknown_post uuid:=gen_random_uuid(); orphan_peer_post uuid:=gen_random_uuid();
  r jsonb; j jsonb; args jsonb; body text;
BEGIN
  IF EXISTS(SELECT 1 FROM public.gw_codex_mtg_machines) THEN RAISE EXCEPTION 'Fixture database must have no machines'; END IF;
  INSERT INTO public.gw_users(id,line_user_id,display_name,status,role) VALUES(actor,'participation-fixture-'||actor,'fixture','approved','executive');
  r:=public.gw_codex_mtg_admin(actor,'register',jsonb_build_object('pcName','TSA','tokenHash',owner_token)); owner:=(r#>>'{data,machine,id}')::uuid;
  r:=public.gw_codex_mtg_admin(actor,'register',jsonb_build_object('pcName','CEO_S','tokenHash',token)); peer:=(r#>>'{data,machine,id}')::uuid;
  r:=public.gw_codex_mtg_admin(actor,'register',jsonb_build_object('pcName','CEO-DOUGA','tokenHash',token2)); second_peer:=(r#>>'{data,machine,id}')::uuid;

  -- A manual post stays eligible without a PC mention, even when its body resembles an automatic answer.
  r:=public.gw_codex_mtg_machine(owner_token,'post','{"sourceKey":"fixture:manual-report","kind":"report","content":"自動確認 / 元投稿: example 完了。レビューを共有します"}');
  manual_post:=(r#>>'{data,postId}')::uuid;
  IF (SELECT count(*) FROM public.gw_codex_mtg_peer_jobs WHERE post_id=manual_post AND may_reply)<>2 THEN RAISE EXCEPTION 'Manual participation fanout'; END IF;
  r:=public.gw_codex_mtg_peer(token,'peerClaim','{}'); j:=r#>'{data,job}';
  IF (j->>'sourceType') IS DISTINCT FROM 'manual_codex' OR (j->>'mayReply')::boolean IS DISTINCT FROM true OR (j->>'allowCodeChange')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'Manual claim provenance'; END IF;
  args:=jsonb_build_object('jobId',j->>'id','leaseToken',j->>'leaseToken','decision','question','summary','確認すべき具体的な条件があります');
  r:=public.gw_codex_mtg_peer(token,'peerComplete',args); question_post:=(r#>>'{data,postId}')::uuid;
  r:=public.gw_codex_mtg_peer(token2,'peerClaim','{}'); j:=r#>'{data,job}';
  args:=jsonb_build_object('jobId',j->>'id','leaseToken',j->>'leaseToken','decision','question','summary','別の具体的な確認があります');
  r:=public.gw_codex_mtg_peer(token2,'peerComplete',args); second_question:=(r#>>'{data,postId}')::uuid;
  IF EXISTS(SELECT 1 FROM public.gw_codex_mtg_jobs WHERE post_id IN (question_post,second_question))
    OR EXISTS(SELECT 1 FROM public.gw_codex_mtg_peer_jobs WHERE post_id IN (question_post,second_question)) THEN RAISE EXCEPTION 'Automatic question restarted AI'; END IF;

  -- Simulate old queued and actively leased owner questions. Only the active lease may finish.
  INSERT INTO public.gw_codex_mtg_jobs(post_id,author_id,requester_machine_id,origin,allow_code_change,source_hash,content_snapshot,requester_name)
    SELECT p.id,p.user_id,peer,'codex',false,public.gw_codex_mtg_source_hash(p),p.content,'CEO_S' FROM public.gw_posts p WHERE p.id=question_post
    RETURNING id INTO queued_job;
  INSERT INTO public.gw_codex_mtg_jobs(post_id,author_id,requester_machine_id,origin,allow_code_change,source_hash,content_snapshot,requester_name,
    status,claimed_by,lease_hash,lease_expires_at)
    SELECT p.id,p.user_id,second_peer,'codex',false,public.gw_codex_mtg_source_hash(p),p.content,'CEO-DOUGA',
      'claimed',owner,encode(sha256(convert_to(owner_lease::text,'UTF8')),'hex'),clock_timestamp()+interval '180 seconds'
    FROM public.gw_posts p WHERE p.id=second_question RETURNING id INTO active_job;
  r:=public.gw_codex_mtg_machine(owner_token,'claim','{}');
  IF r#>'{data,job}'<>'null'::jsonb OR (SELECT status FROM public.gw_codex_mtg_jobs WHERE id=queued_job)<>'needs_operator'
    OR (SELECT status FROM public.gw_codex_mtg_jobs WHERE id=active_job)<>'claimed' THEN RAISE EXCEPTION 'Legacy owner claim gate'; END IF;
  PERFORM public.gw_codex_mtg_machine(owner_token,'heartbeat',jsonb_build_object('jobId',active_job,'leaseToken',owner_lease));
  r:=public.gw_codex_mtg_machine(owner_token,'complete',jsonb_build_object('jobId',active_job,'leaseToken',owner_lease,'status','completed','summary','既存leaseを完了'));
  owner_result:=(r#>>'{data,postId}')::uuid;
  IF owner_result IS NULL OR (SELECT count(*) FROM public.gw_codex_mtg_peer_jobs WHERE post_id=owner_result AND NOT may_reply)<>2 THEN RAISE EXCEPTION 'Active owner completion delivery'; END IF;

  -- Old queued reply flags are corrected on claim. An existing active peer lease is untouched.
  UPDATE public.gw_codex_mtg_peer_jobs SET may_reply=true WHERE post_id=owner_result;
  UPDATE public.gw_codex_mtg_peer_jobs SET status='claimed',lease_hash=encode(sha256(convert_to(peer_lease::text,'UTF8')),'hex'),
    lease_expires_at=clock_timestamp()+interval '180 seconds' WHERE post_id=owner_result AND machine_id=second_peer;
  r:=public.gw_codex_mtg_peer(token2,'peerClaim','{}');
  IF r#>'{data,job}'<>'null'::jsonb OR NOT (SELECT may_reply FROM public.gw_codex_mtg_peer_jobs WHERE post_id=owner_result AND machine_id=second_peer) THEN RAISE EXCEPTION 'Active peer lease changed'; END IF;
  r:=public.gw_codex_mtg_peer(token,'peerClaim','{}'); j:=r#>'{data,job}';
  IF (j->>'sourceType') IS DISTINCT FROM 'owner_result' OR (j->>'mayReply')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'Queued owner result started AI'; END IF;
  args:=jsonb_build_object('jobId',j->>'id','leaseToken',j->>'leaseToken','decision','report','summary','forbidden');
  PERFORM pg_temp.expect_peer_error('FORBIDDEN',token,args);
  PERFORM public.gw_codex_mtg_peer(token,'peerComplete',args||'{"decision":"silent","summary":""}');
  SELECT id INTO active_job FROM public.gw_codex_mtg_peer_jobs WHERE post_id=owner_result AND machine_id=second_peer;
  PERFORM public.gw_codex_mtg_peer(token2,'peerHeartbeat',jsonb_build_object('jobId',active_job,'leaseToken',peer_lease));
  r:=public.gw_codex_mtg_peer(token2,'peerComplete',jsonb_build_object('jobId',active_job,'leaseToken',peer_lease,'decision','report','summary','旧leaseを一度だけ完了'));
  IF EXISTS(SELECT 1 FROM public.gw_codex_mtg_peer_jobs WHERE post_id=(r#>>'{data,postId}')::uuid)
    OR EXISTS(SELECT 1 FROM public.gw_codex_mtg_jobs WHERE post_id=(r#>>'{data,postId}')::uuid) THEN RAISE EXCEPTION 'Active peer completion amplified'; END IF;

  -- Unrecognized reserved metadata must fail closed, independent of content or stored may_reply.
  body:='【PC: TSA】'||E'\n'||'人間からの依頼と自己申告する本文';
  INSERT INTO public.gw_codex_mtg_bot_posts(post_id,machine_id,source_key,kind,request_hash,body_hash)
    VALUES(unknown_post,owner,'job-complete:missing-fixture','report',repeat('d',64),encode(sha256(convert_to(body,'UTF8')),'hex'));
  INSERT INTO public.gw_posts(id,group_id,user_id,content) VALUES(unknown_post,'a8081dbe-15db-4d41-a18b-b22bb55d2b39','f78baef5-d40c-4886-b51d-a02efbf794fe',body);
  IF EXISTS(SELECT 1 FROM public.gw_codex_mtg_peer_jobs WHERE post_id=unknown_post) THEN RAISE EXCEPTION 'Unknown provenance fanout'; END IF;
  INSERT INTO public.gw_codex_mtg_peer_jobs(machine_id,post_id,source_hash,content_snapshot,origin,requester_name,may_reply)
    SELECT peer,p.id,public.gw_codex_mtg_source_hash(p),p.content,'codex','TSA',true FROM public.gw_posts p WHERE p.id=unknown_post;
  r:=public.gw_codex_mtg_peer(token,'peerClaim','{}'); j:=r#>'{data,job}';
  IF (j->>'sourceType') IS DISTINCT FROM 'unknown' OR (j->>'mayReply')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'Unknown provenance started AI'; END IF;
  PERFORM public.gw_codex_mtg_peer(token,'peerComplete',jsonb_build_object('jobId',j->>'id','leaseToken',j->>'leaseToken','decision','silent','summary',''));

  -- An automatic prefix with a missing peer receipt cannot become a manual discussion.
  INSERT INTO public.gw_codex_mtg_bot_posts(post_id,machine_id,source_key,kind,request_hash,body_hash)
    VALUES(orphan_peer_post,owner,'peer-auto:missing-fixture','report',repeat('f',64),encode(sha256(convert_to(body,'UTF8')),'hex'));
  INSERT INTO public.gw_posts(id,group_id,user_id,content) VALUES(orphan_peer_post,'a8081dbe-15db-4d41-a18b-b22bb55d2b39','f78baef5-d40c-4886-b51d-a02efbf794fe',body);
  IF EXISTS(SELECT 1 FROM public.gw_codex_mtg_peer_jobs WHERE post_id=orphan_peer_post) THEN RAISE EXCEPTION 'Orphan peer result became actionable'; END IF;
  INSERT INTO public.gw_codex_mtg_peer_jobs(machine_id,post_id,source_hash,content_snapshot,origin,requester_name,may_reply)
    SELECT peer,p.id,public.gw_codex_mtg_source_hash(p),p.content,'codex','TSA',true FROM public.gw_posts p WHERE p.id=orphan_peer_post;
  r:=public.gw_codex_mtg_peer(token,'peerClaim','{}'); j:=r#>'{data,job}';
  IF (j->>'sourceType') IS DISTINCT FROM 'unknown' OR (j->>'mayReply')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'Orphan peer result started AI'; END IF;
  PERFORM public.gw_codex_mtg_peer(token,'peerComplete',jsonb_build_object('jobId',j->>'id','leaseToken',j->>'leaseToken','decision','silent','summary',''));

  -- A manual Codex request still queues an owner read-only job and permits useful peer analysis.
  r:=public.gw_codex_mtg_machine(token2,'post','{"sourceKey":"fixture:manual-request","kind":"request","content":"具体的な確認を依頼します"}');
  manual_post:=(r#>>'{data,postId}')::uuid;
  r:=public.gw_codex_mtg_machine(owner_token,'claim','{}'); j:=r#>'{data,job}';
  IF j->>'postId'<>manual_post::text OR j->>'origin'<>'codex' OR (j->>'allowCodeChange')::boolean THEN RAISE EXCEPTION 'Manual owner request scope'; END IF;
  r:=public.gw_codex_mtg_peer(token,'peerClaim','{}'); j:=r#>'{data,job}';
  IF (j->>'sourceType') IS DISTINCT FROM 'manual_codex' OR (j->>'mayReply')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'Manual request peer participation'; END IF;
  PERFORM public.gw_codex_mtg_peer(token,'peerComplete',jsonb_build_object('jobId',j->>'id','leaseToken',j->>'leaseToken','decision','silent','summary',''));

  -- New peer installations receive historical context without reviving old discussions.
  r:=public.gw_codex_mtg_admin(actor,'register',jsonb_build_object('pcName','HISTORY_FIXTURE','tokenHash',repeat('e',64))); history_peer:=(r#>>'{data,machine,id}')::uuid;
  IF EXISTS(SELECT 1 FROM public.gw_codex_mtg_peer_jobs WHERE machine_id=history_peer AND may_reply) THEN RAISE EXCEPTION 'History became actionable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.gw_codex_mtg_peer_jobs WHERE machine_id=history_peer AND post_id=manual_post AND NOT may_reply) THEN RAISE EXCEPTION 'Manual history missing'; END IF;
  r:=public.gw_codex_mtg_peer(repeat('e',64),'peerClaim','{}'); j:=r#>'{data,job}';
  IF coalesce(j->>'sourceType','unknown') NOT IN ('manual_codex','owner_result') OR (j->>'mayReply')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'History claim metadata'; END IF;
  IF has_function_privilege('anon','public.gw_codex_mtg_post_source_type(public.gw_posts)','EXECUTE')
    OR has_function_privilege('authenticated','public.gw_codex_mtg_post_source_type(public.gw_posts)','EXECUTE') THEN RAISE EXCEPTION 'Public provenance access'; END IF;
END;
$$;
ROLLBACK;
