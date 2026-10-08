-- Isolated fixture database only. Never run against an operational project.
BEGIN;
DO $$
DECLARE actor uuid:=gen_random_uuid(); owner uuid; peer uuid; second_peer uuid; source uuid:=gen_random_uuid(); r jsonb; j jsonb; args jsonb;
  token text:=repeat('a',64); token2 text:=repeat('b',64); owner_token text:=repeat('c',64); output_post uuid; n integer;
BEGIN
  IF EXISTS(SELECT 1 FROM public.gw_codex_mtg_machines) THEN RAISE EXCEPTION 'Fixture database must have no machines'; END IF;
  INSERT INTO public.gw_users(id,line_user_id,display_name,status,role) VALUES(actor,'peer-fixture-'||actor,'fixture','approved','executive');
  r:=public.gw_codex_mtg_admin(actor,'register',jsonb_build_object('pcName','TSA','tokenHash',owner_token)); owner:=(r#>>'{data,machine,id}')::uuid;
  r:=public.gw_codex_mtg_admin(actor,'register',jsonb_build_object('pcName','CEO_S','tokenHash',token)); peer:=(r#>>'{data,machine,id}')::uuid;
  r:=public.gw_codex_mtg_admin(actor,'register',jsonb_build_object('pcName','CEO-DOUGA','tokenHash',token2)); second_peer:=(r#>>'{data,machine,id}')::uuid;
  INSERT INTO public.gw_posts(id,group_id,user_id,content) VALUES(source,'a8081dbe-15db-4d41-a18b-b22bb55d2b39',actor,'fixture question');
  IF (SELECT count(*) FROM public.gw_codex_mtg_peer_jobs)<>2 THEN RAISE EXCEPTION 'Fanout incorrect'; END IF;
  BEGIN PERFORM public.gw_codex_mtg_peer(owner_token,'peerClaim','{}'); RAISE EXCEPTION 'Owner accepted'; EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF; END;
  r:=public.gw_codex_mtg_peer(token,'peerClaim','{}'); j:=r#>'{data,job}';
  IF j->>'postId'<>source::text OR (j->>'allowCodeChange')::boolean THEN RAISE EXCEPTION 'Claim invalid'; END IF;
  r:=public.gw_codex_mtg_peer(token,'peerClaim','{}'); IF r#>'{data,job}'<>'null'::jsonb THEN RAISE EXCEPTION 'Concurrent claim'; END IF;
  args:=jsonb_build_object('jobId',j->>'id','leaseToken',j->>'leaseToken');
  BEGIN PERFORM public.gw_codex_mtg_peer(token2,'peerHeartbeat',args); RAISE EXCEPTION 'Other machine lease accepted'; EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF; END;
  PERFORM public.gw_codex_mtg_peer(token,'peerHeartbeat',args);
  args:=args||jsonb_build_object('decision','question','summary','fixture request to owner');
  r:=public.gw_codex_mtg_peer(token,'peerComplete',args); output_post:=(r#>>'{data,postId}')::uuid;
  IF NOT (r->>'ok')::boolean OR output_post IS NULL THEN RAISE EXCEPTION 'Completion failed'; END IF;
  IF EXISTS(SELECT 1 FROM public.gw_codex_mtg_peer_jobs WHERE post_id=output_post) THEN RAISE EXCEPTION 'Automatic response loop'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.gw_codex_mtg_jobs WHERE post_id=output_post AND origin='codex' AND NOT allow_code_change) THEN RAISE EXCEPTION 'Owner question scope'; END IF;
  r:=public.gw_codex_mtg_peer(token,'peerComplete',args); IF NOT (r#>>'{data,duplicate}')::boolean THEN RAISE EXCEPTION 'Duplicate reply'; END IF;
  BEGIN PERFORM public.gw_codex_mtg_peer(token,'peerComplete',args||'{"summary":"changed"}'); RAISE EXCEPTION 'Changed duplicate accepted'; EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'IDEMPOTENCY_CONFLICT' THEN RAISE; END IF; END;
  -- Completing the owner response must enqueue informational delivery only.
  UPDATE public.gw_codex_mtg_jobs SET status='completed' WHERE post_id=source;
  r:=public.gw_codex_mtg_machine(owner_token,'claim','{}'); j:=r#>'{data,job}';
  r:=public.gw_codex_mtg_machine(owner_token,'complete',jsonb_build_object('jobId',j->>'id','leaseToken',j->>'leaseToken','status','completed','summary','fixture answer'));
  IF EXISTS(SELECT 1 FROM public.gw_codex_mtg_peer_jobs WHERE post_id=(r#>>'{data,postId}')::uuid AND may_reply) THEN RAISE EXCEPTION 'Owner reply amplification'; END IF;
  IF (SELECT count(*) FROM public.gw_codex_mtg_peer_jobs WHERE post_id=(r#>>'{data,postId}')::uuid)<>2 THEN RAISE EXCEPTION 'Owner answer not delivered'; END IF;
  -- Edited requests invalidate old leases and create a new revision for both PCs.
  r:=public.gw_codex_mtg_peer(token2,'peerClaim','{}'); j:=r#>'{data,job}';
  UPDATE public.gw_posts SET content='edited fixture question',updated_at=clock_timestamp() WHERE id=source;
  r:=public.gw_codex_mtg_peer(token2,'peerComplete',jsonb_build_object('jobId',j->>'id','leaseToken',j->>'leaseToken','decision','report','summary','stale'));
  IF r->>'code'<>'CONFLICT' THEN RAISE EXCEPTION 'Edited source allowed'; END IF;
  IF (SELECT count(*) FROM public.gw_codex_mtg_peer_jobs WHERE post_id=source AND status='queued')<>2 THEN RAISE EXCEPTION 'Edited revision not queued'; END IF;
  -- Drain informational jobs silently; expire then reclaim the next analysis with a new lease.
  r:=public.gw_codex_mtg_peer(token,'peerClaim','{}'); j:=r#>'{data,job}';
  IF (j->>'mayReply')::boolean THEN RAISE EXCEPTION 'Expected informational answer'; END IF;
  args:=jsonb_build_object('jobId',j->>'id','leaseToken',j->>'leaseToken','decision','report','summary','loop');
  BEGIN PERFORM public.gw_codex_mtg_peer(token,'peerComplete',args); RAISE EXCEPTION 'Informational reply accepted'; EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'FORBIDDEN' THEN RAISE; END IF; END;
  PERFORM public.gw_codex_mtg_peer(token,'peerComplete',args||'{"decision":"silent","summary":""}');
  r:=public.gw_codex_mtg_peer(token,'peerClaim','{}'); j:=r#>'{data,job}';
  UPDATE public.gw_codex_mtg_peer_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=(j->>'id')::uuid;
  r:=public.gw_codex_mtg_peer(token,'peerClaim','{}'); IF r#>>'{data,job,leaseToken}'=j->>'leaseToken' THEN RAISE EXCEPTION 'Lease not rotated'; END IF;
  DELETE FROM public.gw_posts WHERE id=source;
  IF EXISTS(SELECT 1 FROM public.gw_codex_mtg_peer_jobs WHERE id=(j->>'id')::uuid AND status<>'cancelled') THEN RAISE EXCEPTION 'Deletion failed to cancel'; END IF;
  UPDATE public.gw_codex_mtg_machines SET revoked_at=now() WHERE id=peer;
  BEGIN PERFORM public.gw_codex_mtg_peer(token,'peerClaim','{}'); RAISE EXCEPTION 'Revoked key accepted'; EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'UNAUTHORIZED' THEN RAISE; END IF; END;
  IF has_table_privilege('anon','public.gw_codex_mtg_peer_jobs','SELECT') OR has_function_privilege('authenticated','public.gw_codex_mtg_peer(text,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Public grant'; END IF;
END $$;
ROLLBACK;
