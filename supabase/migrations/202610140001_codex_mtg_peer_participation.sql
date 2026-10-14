-- Human/manual posts may invite useful peer participation. Automatic results never restart AI.
BEGIN;

-- Provenance comes only from server-owned receipts. The completion metadata is inserted
-- before gw_posts, while result_post_id on the owner job is assigned afterwards.
CREATE OR REPLACE FUNCTION public.gw_codex_mtg_post_source_type(p public.gw_posts) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT CASE
    WHEN p.group_id IS DISTINCT FROM 'a8081dbe-15db-4d41-a18b-b22bb55d2b39'::uuid THEN 'unknown'
    WHEN EXISTS(SELECT 1 FROM public.gw_codex_mtg_peer_jobs WHERE result_post_id=p.id) THEN 'peer_result'
    WHEN EXISTS(SELECT 1 FROM public.gw_codex_mtg_bot_posts b
      JOIN public.gw_codex_mtg_machines m ON m.id=b.machine_id
      JOIN public.gw_codex_mtg_jobs j ON b.source_key='job-complete:'||j.id
      WHERE b.post_id=p.id AND m.pc_name='TSA' AND m.can_execute_code) THEN 'owner_result'
    WHEN EXISTS(SELECT 1 FROM public.gw_codex_mtg_bot_posts b
      JOIN public.gw_codex_mtg_machines m ON m.id=b.machine_id
      WHERE b.post_id=p.id AND b.source_key NOT LIKE 'job-complete:%' AND b.source_key NOT LIKE 'peer-auto:%'
        AND m.revoked_at IS NULL AND m.expires_at>clock_timestamp()) THEN 'manual_codex'
    WHEN p.user_id<>'f78baef5-d40c-4886-b51d-a02efbf794fe'::uuid AND EXISTS(
      SELECT 1 FROM public.gw_users u JOIN public.gw_group_members gm ON gm.user_id=u.id AND gm.group_id=p.group_id
      WHERE u.id=p.user_id AND u.status='approved' AND u.role IN ('executive','admin')) THEN 'human'
    ELSE 'unknown' END;
$$;

CREATE OR REPLACE FUNCTION public.gw_codex_mtg_peer_enqueue(p public.gw_posts, target uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b public.gw_codex_mtg_bot_posts; sender text; source_type text; reply boolean;
BEGIN
  IF p.group_id<>'a8081dbe-15db-4d41-a18b-b22bb55d2b39' THEN RETURN; END IF;
  -- The trusted completion sets result_post_id BEFORE inserting its post.
  source_type:=public.gw_codex_mtg_post_source_type(p);
  IF source_type NOT IN ('human','manual_codex','owner_result') THEN RETURN; END IF;
  reply:=source_type IN ('human','manual_codex');
  SELECT * INTO b FROM public.gw_codex_mtg_bot_posts WHERE post_id=p.id;
  IF b.post_id IS NOT NULL THEN
    SELECT pc_name INTO sender FROM public.gw_codex_mtg_machines WHERE id=b.machine_id;
  ELSE
    SELECT coalesce(u.real_name,u.display_name,'管理者') INTO sender FROM public.gw_users u
      JOIN public.gw_group_members gm ON gm.user_id=u.id AND gm.group_id=p.group_id
      WHERE u.id=p.user_id AND u.status='approved' AND u.role IN ('executive','admin');
    IF sender IS NULL THEN RETURN; END IF;
  END IF;
  INSERT INTO public.gw_codex_mtg_peer_jobs(machine_id,post_id,source_hash,content_snapshot,origin,requester_name,may_reply)
    SELECT m.id,p.id,public.gw_codex_mtg_source_hash(p),left(coalesce(p.content,''),10000),
      CASE WHEN b.post_id IS NULL THEN 'human' ELSE 'codex' END,sender,reply
    FROM public.gw_codex_mtg_machines m WHERE m.pc_name<>'TSA' AND NOT m.can_execute_code
      AND m.revoked_at IS NULL AND m.expires_at>clock_timestamp() AND (target IS NULL OR target=m.id)
      AND m.id IS DISTINCT FROM b.machine_id
    ON CONFLICT(machine_id,post_id,source_hash) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.gw_codex_mtg_job_valid(j public.gw_codex_mtg_jobs) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.gw_posts p WHERE p.id=j.post_id
    AND p.group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39' AND p.user_id=j.author_id
    AND public.gw_codex_mtg_source_hash(p)=j.source_hash
    -- Do not start previously queued automatic questions; let an active owner lease finish.
    AND (public.gw_codex_mtg_post_source_type(p) IN ('human','manual_codex')
      OR (j.status='claimed' AND j.lease_expires_at>clock_timestamp()))
    AND ((j.origin='human' AND j.allow_code_change AND EXISTS(SELECT 1 FROM public.gw_users u
      JOIN public.gw_group_members gm ON gm.user_id=u.id AND gm.group_id=p.group_id
      WHERE u.id=p.user_id AND u.status='approved' AND u.role IN ('executive','admin')))
    OR (j.origin='codex' AND NOT j.allow_code_change AND p.user_id='f78baef5-d40c-4886-b51d-a02efbf794fe'
      AND EXISTS(SELECT 1 FROM public.gw_codex_mtg_machines m JOIN public.gw_codex_mtg_bot_posts b ON b.machine_id=m.id
        WHERE m.id=j.requester_machine_id AND m.revoked_at IS NULL AND m.expires_at>clock_timestamp()
          AND b.post_id=p.id AND b.kind='request'))));
$$;

CREATE OR REPLACE FUNCTION public.gw_codex_mtg_peer(p_token_hash text,p_action text,p_args jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE m public.gw_codex_mtg_machines; j public.gw_codex_mtg_peer_jobs; p public.gw_posts;
  keys text[]; lease uuid; digest text; body text; post_uuid uuid; v_decision text; auth_result jsonb; source_type text;
BEGIN
  -- Reuse the established active-token check, row lock, rate limit, and heartbeat.
  auth_result:=public.gw_codex_mtg_machine(p_token_hash,'machineHeartbeat','{}');
  SELECT * INTO m FROM public.gw_codex_mtg_machines WHERE token_hash=p_token_hash;
  IF m.pc_name='TSA' OR m.can_execute_code THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
  keys:=CASE p_action WHEN 'peerClaim' THEN ARRAY[]::text[] WHEN 'peerHeartbeat' THEN ARRAY['jobId','leaseToken']
    WHEN 'peerComplete' THEN ARRAY['jobId','leaseToken','decision','summary'] END;
  IF keys IS NULL OR NOT coalesce(public.gw_data_keys(p_args,keys),false)
    OR (SELECT count(*) FROM jsonb_object_keys(p_args))<>cardinality(keys) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
  IF p_action='peerClaim' THEN
    UPDATE public.gw_codex_mtg_machines SET peer_listener_seen_at=clock_timestamp() WHERE id=m.id;
    UPDATE public.gw_codex_mtg_peer_jobs q SET status='cancelled',updated_at=clock_timestamp()
      WHERE machine_id=m.id AND status IN ('queued','claimed') AND NOT public.gw_codex_mtg_peer_valid(q);
    -- Analysis is read-only and publishing is transactional. Expired analysis may be reclaimed safely.
    IF EXISTS(SELECT 1 FROM public.gw_codex_mtg_peer_jobs WHERE machine_id=m.id AND status='claimed' AND lease_expires_at>clock_timestamp()) THEN
      RETURN jsonb_build_object('ok',true,'data',jsonb_build_object('job',NULL)); END IF;
    SELECT * INTO j FROM public.gw_codex_mtg_peer_jobs WHERE machine_id=m.id
      AND (status='queued' OR (status='claimed' AND lease_expires_at<=clock_timestamp()))
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'data',jsonb_build_object('job',NULL)); END IF;
    lease:=gen_random_uuid();
    SELECT * INTO p FROM public.gw_posts WHERE id=j.post_id;
    source_type:=public.gw_codex_mtg_post_source_type(p);
    -- Recheck queued/expired work only. A currently running lease retains its contract.
    UPDATE public.gw_codex_mtg_peer_jobs SET status='claimed',lease_hash=encode(sha256(convert_to(lease::text,'UTF8')),'hex'),
      lease_expires_at=clock_timestamp()+interval '180 seconds',
      may_reply=j.may_reply AND source_type IN ('human','manual_codex'),updated_at=clock_timestamp()
      WHERE id=j.id RETURNING * INTO j;
    RETURN jsonb_build_object('ok',true,'data',jsonb_build_object('job',jsonb_build_object(
      'id',j.id,'postId',j.post_id,'origin',j.origin,'content',j.content_snapshot,'requesterName',j.requester_name,
      'allowCodeChange',false,'mayReply',j.may_reply,'sourceType',source_type,'leaseToken',lease)));
  END IF;
  IF NOT coalesce(jsonb_typeof(p_args->'jobId')='string' AND (p_args->>'jobId') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    AND jsonb_typeof(p_args->'leaseToken')='string' AND (p_args->>'leaseToken') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$',false) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
  SELECT * INTO j FROM public.gw_codex_mtg_peer_jobs WHERE id=(p_args->>'jobId')::uuid FOR UPDATE;
  IF NOT FOUND OR j.machine_id<>m.id OR j.lease_hash IS DISTINCT FROM encode(sha256(convert_to((p_args->>'leaseToken')::uuid::text,'UTF8')),'hex') THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
  IF p_action='peerComplete' THEN
    v_decision:=p_args->>'decision';
    IF NOT coalesce(jsonb_typeof(p_args->'decision')='string' AND v_decision IN ('silent','report','question','needs_operator')
      AND jsonb_typeof(p_args->'summary')='string' AND char_length(p_args->>'summary')<=2000
      AND (v_decision='silent' OR (p_args->>'summary') ~ '[^[:space:]　]'),false) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
    digest:=encode(sha256(convert_to(p_args::text,'UTF8')),'hex');
    IF j.completion_hash IS NOT NULL THEN
      IF j.completion_hash<>digest THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='IDEMPOTENCY_CONFLICT'; END IF;
      RETURN jsonb_build_object('ok',true,'data',jsonb_build_object('jobId',j.id,'decision',j.decision,'postId',j.result_post_id,'duplicate',true));
    END IF;
  END IF;
  IF j.status<>'claimed' OR j.lease_expires_at<=clock_timestamp() OR NOT public.gw_codex_mtg_peer_valid(j) THEN
    RETURN jsonb_build_object('ok',false,'code','CONFLICT'); END IF;
  IF p_action='peerHeartbeat' THEN
    UPDATE public.gw_codex_mtg_machines SET peer_listener_seen_at=clock_timestamp() WHERE id=m.id;
    UPDATE public.gw_codex_mtg_peer_jobs SET lease_expires_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp()
      WHERE id=j.id RETURNING * INTO j;
    RETURN jsonb_build_object('ok',true,'data',jsonb_build_object('leaseExpiresAt',j.lease_expires_at)); END IF;
  IF NOT j.may_reply AND v_decision<>'silent' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
  IF v_decision<>'silent' THEN post_uuid:=gen_random_uuid(); END IF;
  UPDATE public.gw_codex_mtg_peer_jobs SET status='completed',decision=v_decision,completion_hash=digest,
    result_post_id=post_uuid,updated_at=clock_timestamp() WHERE id=j.id;
  IF post_uuid IS NOT NULL THEN
    body:='【PC: '||m.pc_name||'】'||E'\n'||'自動確認 / 元投稿: '||j.post_id||E'\n'||(p_args->>'summary');
    INSERT INTO public.gw_codex_mtg_bot_posts(post_id,machine_id,source_key,kind,request_hash,body_hash)
      VALUES(post_uuid,m.id,'peer-auto:'||j.id,CASE WHEN v_decision='question' THEN 'request' ELSE 'report' END,
        digest,encode(sha256(convert_to(body,'UTF8')),'hex'));
    INSERT INTO public.gw_posts(id,group_id,user_id,content,attachments)
      VALUES(post_uuid,'a8081dbe-15db-4d41-a18b-b22bb55d2b39','f78baef5-d40c-4886-b51d-a02efbf794fe',body,'[]') RETURNING * INTO p;
    -- Questions remain visible to management; only a new human/manual request may restart AI.
    UPDATE public.gw_groups SET updated_at=clock_timestamp() WHERE id=p.group_id;
    PERFORM public.gw_codex_mtg_wake();
  END IF;
  RETURN jsonb_build_object('ok',true,'data',jsonb_build_object('jobId',j.id,'decision',v_decision,'postId',post_uuid,'duplicate',false));
END;
$$;
REVOKE ALL ON FUNCTION public.gw_codex_mtg_post_source_type(public.gw_posts),public.gw_codex_mtg_peer_enqueue(public.gw_posts,uuid),
 public.gw_codex_mtg_job_valid(public.gw_codex_mtg_jobs),public.gw_codex_mtg_peer(text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gw_codex_mtg_peer(text,text,jsonb) TO service_role;
COMMIT;
