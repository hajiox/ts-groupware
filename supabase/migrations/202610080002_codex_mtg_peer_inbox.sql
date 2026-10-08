-- Durable, read-only delivery to registered peer PCs. Owner implementation jobs are unchanged.
BEGIN;
ALTER TABLE public.gw_codex_mtg_machines ADD COLUMN peer_listener_seen_at timestamptz;
CREATE TABLE public.gw_codex_mtg_peer_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id uuid NOT NULL REFERENCES public.gw_codex_mtg_machines(id),
  post_id uuid REFERENCES public.gw_posts(id) ON DELETE SET NULL,
  source_hash text NOT NULL,
  content_snapshot text NOT NULL,
  origin text NOT NULL CHECK(origin IN ('human','codex')),
  requester_name text NOT NULL,
  may_reply boolean NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','completed','cancelled')),
  decision text CHECK(decision IN ('silent','report','question','needs_operator')),
  lease_hash text, lease_expires_at timestamptz,
  completion_hash text, result_post_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(machine_id,post_id,source_hash)
);
CREATE INDEX gw_codex_mtg_peer_pending ON public.gw_codex_mtg_peer_jobs(machine_id,status,created_at,id);
CREATE INDEX gw_codex_mtg_peer_result ON public.gw_codex_mtg_peer_jobs(result_post_id) WHERE result_post_id IS NOT NULL;
ALTER TABLE public.gw_codex_mtg_peer_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gw_codex_mtg_peer_jobs FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.gw_codex_mtg_peer_jobs TO service_role;

CREATE FUNCTION public.gw_codex_mtg_peer_enqueue(p public.gw_posts, target uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b public.gw_codex_mtg_bot_posts; sender text; reply boolean:=true;
BEGIN
  IF p.group_id<>'a8081dbe-15db-4d41-a18b-b22bb55d2b39' THEN RETURN; END IF;
  -- The trusted completion sets result_post_id BEFORE inserting its post.
  IF EXISTS(SELECT 1 FROM public.gw_codex_mtg_peer_jobs WHERE result_post_id=p.id) THEN RETURN; END IF;
  SELECT * INTO b FROM public.gw_codex_mtg_bot_posts WHERE post_id=p.id;
  IF b.post_id IS NOT NULL THEN
    SELECT pc_name INTO sender FROM public.gw_codex_mtg_machines WHERE id=b.machine_id;
    -- Owner's answer to an automatic peer question is informational only: no AI ping-pong.
    IF EXISTS(SELECT 1 FROM public.gw_codex_mtg_jobs j JOIN public.gw_codex_mtg_peer_jobs q ON q.result_post_id=j.post_id
      WHERE b.source_key='job-complete:'||j.id) THEN reply:=false; END IF;
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
CREATE FUNCTION public.gw_codex_mtg_peer_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' AND OLD.group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39' THEN
    IF TG_OP='UPDATE' AND public.gw_codex_mtg_source_hash(NEW)=public.gw_codex_mtg_source_hash(OLD) THEN RETURN NULL; END IF;
    UPDATE public.gw_codex_mtg_peer_jobs SET status='cancelled',updated_at=clock_timestamp()
      WHERE (post_id=OLD.id OR source_hash=public.gw_codex_mtg_source_hash(OLD)) AND status IN ('queued','claimed');
  END IF;
  IF TG_OP<>'DELETE' THEN PERFORM public.gw_codex_mtg_peer_enqueue(NEW); END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER gw_codex_mtg_peer_capture AFTER INSERT OR UPDATE OR DELETE ON public.gw_posts
FOR EACH ROW EXECUTE FUNCTION public.gw_codex_mtg_peer_capture();

CREATE FUNCTION public.gw_codex_mtg_peer_seed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.gw_posts;
BEGIN
  IF NEW.pc_name='TSA' THEN RETURN NULL; END IF;
  FOR p IN SELECT * FROM public.gw_posts WHERE group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39'
    ORDER BY created_at DESC,id DESC LIMIT 50 LOOP
    PERFORM public.gw_codex_mtg_peer_enqueue(p,NEW.id);
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER gw_codex_mtg_peer_seed AFTER INSERT ON public.gw_codex_mtg_machines
FOR EACH ROW EXECUTE FUNCTION public.gw_codex_mtg_peer_seed();

CREATE FUNCTION public.gw_codex_mtg_peer_valid(j public.gw_codex_mtg_peer_jobs) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.gw_posts p WHERE p.id=j.post_id
    AND p.group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39' AND public.gw_codex_mtg_source_hash(p)=j.source_hash
    AND ((j.origin='human' AND EXISTS(SELECT 1 FROM public.gw_users u JOIN public.gw_group_members gm
      ON gm.user_id=u.id AND gm.group_id=p.group_id WHERE u.id=p.user_id AND u.status='approved' AND u.role IN ('executive','admin')))
    OR (j.origin='codex' AND EXISTS(SELECT 1 FROM public.gw_codex_mtg_bot_posts b JOIN public.gw_codex_mtg_machines m
      ON m.id=b.machine_id WHERE b.post_id=p.id AND m.revoked_at IS NULL AND m.expires_at>clock_timestamp()))));
$$;

CREATE FUNCTION public.gw_codex_mtg_peer(p_token_hash text,p_action text,p_args jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE m public.gw_codex_mtg_machines; j public.gw_codex_mtg_peer_jobs; p public.gw_posts;
  keys text[]; lease uuid; digest text; body text; post_uuid uuid; v_decision text; auth_result jsonb;
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
    UPDATE public.gw_codex_mtg_peer_jobs SET status='claimed',lease_hash=encode(sha256(convert_to(lease::text,'UTF8')),'hex'),
      lease_expires_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() WHERE id=j.id;
    RETURN jsonb_build_object('ok',true,'data',jsonb_build_object('job',jsonb_build_object(
      'id',j.id,'postId',j.post_id,'origin',j.origin,'content',j.content_snapshot,'requesterName',j.requester_name,
      'allowCodeChange',false,'mayReply',j.may_reply,'leaseToken',lease)));
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
    IF v_decision='question' THEN
      INSERT INTO public.gw_codex_mtg_jobs(post_id,author_id,requester_machine_id,origin,allow_code_change,source_hash,content_snapshot,requester_name)
        VALUES(p.id,p.user_id,m.id,'codex',false,public.gw_codex_mtg_source_hash(p),body,m.pc_name);
    END IF;
    UPDATE public.gw_groups SET updated_at=clock_timestamp() WHERE id=p.group_id;
    PERFORM public.gw_codex_mtg_wake();
  END IF;
  RETURN jsonb_build_object('ok',true,'data',jsonb_build_object('jobId',j.id,'decision',v_decision,'postId',post_uuid,'duplicate',false));
END;
$$;
REVOKE ALL ON FUNCTION public.gw_codex_mtg_peer_enqueue(public.gw_posts,uuid),public.gw_codex_mtg_peer_capture(),
 public.gw_codex_mtg_peer_seed(),public.gw_codex_mtg_peer_valid(public.gw_codex_mtg_peer_jobs),
 public.gw_codex_mtg_peer(text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gw_codex_mtg_peer(text,text,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.gw_codex_mtg_machine_view(m public.gw_codex_mtg_machines) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object('id',m.id,'pcName',m.pc_name,'canExecuteCode',m.can_execute_code,
    'lastSeenAt',m.last_seen_at,'revokedAt',m.revoked_at,'expiresAt',m.expires_at,
    'peerListenerSeenAt',m.peer_listener_seen_at);
$$;
DO $$ DECLARE p public.gw_posts; BEGIN
  FOR p IN SELECT * FROM public.gw_posts WHERE group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39'
    ORDER BY created_at DESC,id DESC LIMIT 50 LOOP PERFORM public.gw_codex_mtg_peer_enqueue(p); END LOOP;
END $$;
COMMIT;
