BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.gw_users WHERE id='f78baef5-d40c-4886-b51d-a02efbf794fe' AND status='approved') THEN
    RAISE EXCEPTION 'The configured TSG system user is unavailable';
  END IF;
  IF EXISTS (SELECT 1 FROM public.gw_groups WHERE name='CodexMTG' AND id<>'a8081dbe-15db-4d41-a18b-b22bb55d2b39')
    OR EXISTS (SELECT 1 FROM public.gw_groups WHERE id='a8081dbe-15db-4d41-a18b-b22bb55d2b39' AND (name<>'CodexMTG' OR type<>'chat')) THEN
    RAISE EXCEPTION 'CodexMTG group identity conflicts with an existing group';
  END IF;
END;
$$;
INSERT INTO public.gw_groups(id,name,type,icon,description,created_by)
VALUES('a8081dbe-15db-4d41-a18b-b22bb55d2b39','CodexMTG','chat','💻',
  '管理職とCodexの連絡。システム改修はTSA PCのみで実行します。','f78baef5-d40c-4886-b51d-a02efbf794fe')
ON CONFLICT(id) DO NOTHING;

CREATE TABLE public.gw_codex_mtg_machines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pc_name text NOT NULL CHECK(pc_name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  can_execute_code boolean NOT NULL CHECK(can_execute_code=(pc_name='TSA')),
  created_by uuid NOT NULL REFERENCES public.gw_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '90 days'),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.gw_users(id),
  rate_window timestamptz NOT NULL DEFAULT now(),
  rate_count integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX gw_codex_mtg_active_pc ON public.gw_codex_mtg_machines(pc_name) WHERE revoked_at IS NULL;

-- Keep receipts after a displayed post is deleted: retrying must not recreate it.
-- Metadata is inserted before the post in the same RPC transaction so the bot
-- author/prefix guard never trusts client text or a claimed PC name.
CREATE TABLE public.gw_codex_mtg_bot_posts (
  post_id uuid PRIMARY KEY,
  machine_id uuid NOT NULL REFERENCES public.gw_codex_mtg_machines(id),
  source_key text NOT NULL CHECK(char_length(source_key) BETWEEN 1 AND 160),
  kind text NOT NULL CHECK(kind IN ('report','request')),
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  body_hash text NOT NULL CHECK(body_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(machine_id,source_key)
);
CREATE TABLE public.gw_codex_mtg_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid UNIQUE REFERENCES public.gw_posts(id) ON DELETE SET NULL,
  author_id uuid REFERENCES public.gw_users(id) ON DELETE SET NULL,
  requester_machine_id uuid REFERENCES public.gw_codex_mtg_machines(id),
  origin text NOT NULL CHECK(origin IN ('human','codex')),
  allow_code_change boolean NOT NULL CHECK(NOT allow_code_change OR origin='human'),
  source_hash text NOT NULL,
  content_snapshot text NOT NULL,
  requester_name text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','completed','needs_operator','failed')),
  claimed_by uuid REFERENCES public.gw_codex_mtg_machines(id),
  lease_hash text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  completion_hash text,
  result_post_id uuid,
  summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((origin='human' AND requester_machine_id IS NULL) OR (origin='codex' AND requester_machine_id IS NOT NULL))
);
CREATE INDEX gw_codex_mtg_jobs_queue ON public.gw_codex_mtg_jobs(created_at,id) WHERE status='queued';

ALTER TABLE public.gw_codex_mtg_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gw_codex_mtg_bot_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gw_codex_mtg_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gw_codex_mtg_machines,public.gw_codex_mtg_bot_posts,public.gw_codex_mtg_jobs FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.gw_codex_mtg_machines,public.gw_codex_mtg_bot_posts,public.gw_codex_mtg_jobs TO service_role;

CREATE FUNCTION public.gw_codex_mtg_wake() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- A public notification contains no post ID, PC name, content or credential.
  -- It is only a hint; authenticated queue reads are authoritative.
  BEGIN
    PERFORM realtime.send('{}'::jsonb,'wake','codex-mtg-v1',false);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END;
$$;
CREATE FUNCTION public.gw_codex_mtg_source_hash(p public.gw_posts) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('id',p.id,'group',p.group_id,'author',p.user_id,
    'content',p.content,'attachments',p.attachments,'parent',p.parent_id,'reply',p.reply_to_id,
    'updated',p.updated_at AT TIME ZONE 'UTC')::text,'UTF8')),'hex');
$$;
CREATE FUNCTION public.gw_codex_mtg_member_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39' THEN
    PERFORM 1 FROM public.gw_users WHERE id=NEW.user_id AND status='approved'
      AND (role IN ('executive','admin') OR id='f78baef5-d40c-4886-b51d-a02efbf794fe') FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gw_codex_mtg_member_guard BEFORE INSERT OR UPDATE ON public.gw_group_members
FOR EACH ROW EXECUTE FUNCTION public.gw_codex_mtg_member_guard();

CREATE FUNCTION public.gw_codex_mtg_sync_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.status='approved' AND (NEW.role IN ('executive','admin') OR NEW.id='f78baef5-d40c-4886-b51d-a02efbf794fe') THEN
    INSERT INTO public.gw_group_members(group_id,user_id,role)
    VALUES('a8081dbe-15db-4d41-a18b-b22bb55d2b39',NEW.id,'member') ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM public.gw_group_members WHERE group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39' AND user_id=NEW.id;
    UPDATE public.gw_codex_mtg_jobs SET status='needs_operator',summary='依頼者の承認・管理職権限が変更されました',updated_at=clock_timestamp()
      WHERE author_id=NEW.id AND origin='human' AND status IN ('queued','claimed');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gw_codex_mtg_sync_user AFTER INSERT OR UPDATE OF role,status ON public.gw_users
FOR EACH ROW EXECUTE FUNCTION public.gw_codex_mtg_sync_user();
DELETE FROM public.gw_group_members gm WHERE gm.group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39'
  AND NOT EXISTS(SELECT 1 FROM public.gw_users u WHERE u.id=gm.user_id AND u.status='approved'
    AND (u.role IN ('executive','admin') OR u.id='f78baef5-d40c-4886-b51d-a02efbf794fe'));
INSERT INTO public.gw_group_members(group_id,user_id,role)
SELECT 'a8081dbe-15db-4d41-a18b-b22bb55d2b39',id,'member' FROM public.gw_users
WHERE status='approved' AND (role IN ('executive','admin') OR id='f78baef5-d40c-4886-b51d-a02efbf794fe') ON CONFLICT DO NOTHING;

CREATE FUNCTION public.gw_codex_mtg_group_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.id='a8081dbe-15db-4d41-a18b-b22bb55d2b39' THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
    IF NEW.id<>OLD.id OR NEW.name<>'CodexMTG' OR NEW.type<>'chat' THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gw_codex_mtg_group_guard BEFORE UPDATE OR DELETE ON public.gw_groups
FOR EACH ROW EXECUTE FUNCTION public.gw_codex_mtg_group_guard();

CREATE FUNCTION public.gw_codex_mtg_post_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE valid_bot boolean;
BEGIN
  IF TG_OP='UPDATE' AND OLD.group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39' AND NEW.group_id<>OLD.group_id THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN';
  END IF;
  IF NEW.group_id<>'a8081dbe-15db-4d41-a18b-b22bb55d2b39' THEN RETURN NEW; END IF;
  IF NEW.user_id='f78baef5-d40c-4886-b51d-a02efbf794fe' THEN
    IF TG_OP='UPDATE' AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.user_id<>OLD.user_id
      OR NEW.attachments IS DISTINCT FROM OLD.attachments OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
      OR NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id OR NEW.updated_at IS DISTINCT FROM OLD.updated_at) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN';
    END IF;
    SELECT true INTO valid_bot FROM public.gw_codex_mtg_bot_posts b JOIN public.gw_codex_mtg_machines m ON m.id=b.machine_id
      WHERE b.post_id=NEW.id AND b.body_hash=encode(sha256(convert_to(NEW.content,'UTF8')),'hex')
        AND left(NEW.content,char_length('【PC: '||m.pc_name||'】'))='【PC: '||m.pc_name||'】'
        AND NEW.attachments='[]'::jsonb AND NEW.parent_id IS NULL AND NEW.reply_to_id IS NULL;
    IF NOT coalesce(valid_bot,false) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
  ELSE
    PERFORM 1 FROM public.gw_users u JOIN public.gw_group_members gm ON gm.user_id=u.id AND gm.group_id=NEW.group_id
      WHERE u.id=NEW.user_id AND u.status='approved' AND u.role IN ('executive','admin') FOR SHARE OF u,gm;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
    IF TG_OP='UPDATE' AND OLD.user_id='f78baef5-d40c-4886-b51d-a02efbf794fe' THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gw_codex_mtg_post_guard BEFORE INSERT OR UPDATE ON public.gw_posts
FOR EACH ROW EXECUTE FUNCTION public.gw_codex_mtg_post_guard();

CREATE FUNCTION public.gw_codex_mtg_capture_post() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39' THEN
    IF NEW.user_id<>'f78baef5-d40c-4886-b51d-a02efbf794fe' THEN
      INSERT INTO public.gw_codex_mtg_jobs(post_id,author_id,origin,allow_code_change,source_hash,content_snapshot,requester_name,status,summary)
      SELECT NEW.id,u.id,'human',true,public.gw_codex_mtg_source_hash(NEW),coalesce(NEW.content,''),coalesce(u.real_name,u.display_name),
        CASE WHEN coalesce(NEW.content ~ '[^[:space:]　]',false) THEN 'queued' ELSE 'needs_operator' END,
        CASE WHEN coalesce(NEW.content ~ '[^[:space:]　]',false) THEN NULL ELSE '本文で依頼内容を入力してください' END
      FROM public.gw_users u WHERE u.id=NEW.user_id AND u.status='approved' AND u.role IN ('executive','admin')
      ON CONFLICT(post_id) DO NOTHING;
    END IF;
    PERFORM public.gw_codex_mtg_wake();
  ELSIF TG_OP IN ('UPDATE','DELETE') AND OLD.group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39' THEN
    IF TG_OP='DELETE' OR public.gw_codex_mtg_source_hash(NEW)<>public.gw_codex_mtg_source_hash(OLD) THEN
      UPDATE public.gw_codex_mtg_jobs SET status='needs_operator',summary='元の依頼が編集・削除されました',updated_at=clock_timestamp()
        WHERE (post_id=OLD.id OR source_hash=public.gw_codex_mtg_source_hash(OLD)) AND status IN ('queued','claimed');
    END IF;
    PERFORM public.gw_codex_mtg_wake();
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER gw_codex_mtg_capture_post AFTER INSERT OR UPDATE OR DELETE ON public.gw_posts
FOR EACH ROW EXECUTE FUNCTION public.gw_codex_mtg_capture_post();

CREATE FUNCTION public.gw_codex_mtg_job_valid(j public.gw_codex_mtg_jobs) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.gw_posts p WHERE p.id=j.post_id
    AND p.group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39' AND p.user_id=j.author_id
    AND public.gw_codex_mtg_source_hash(p)=j.source_hash
    AND ((j.origin='human' AND j.allow_code_change AND EXISTS(SELECT 1 FROM public.gw_users u
      JOIN public.gw_group_members gm ON gm.user_id=u.id AND gm.group_id=p.group_id
      WHERE u.id=p.user_id AND u.status='approved' AND u.role IN ('executive','admin')))
    OR (j.origin='codex' AND NOT j.allow_code_change AND p.user_id='f78baef5-d40c-4886-b51d-a02efbf794fe'
      AND EXISTS(SELECT 1 FROM public.gw_codex_mtg_machines m JOIN public.gw_codex_mtg_bot_posts b ON b.machine_id=m.id
        WHERE m.id=j.requester_machine_id AND m.revoked_at IS NULL AND m.expires_at>clock_timestamp()
          AND b.post_id=p.id AND b.kind='request'))));
$$;
CREATE FUNCTION public.gw_codex_mtg_machine_view(m public.gw_codex_mtg_machines) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object('id',m.id,'pcName',m.pc_name,'canExecuteCode',m.can_execute_code,
    'lastSeenAt',m.last_seen_at,'revokedAt',m.revoked_at,'expiresAt',m.expires_at);
$$;

CREATE FUNCTION public.gw_codex_mtg_machine(p_token_hash text,p_action text,p_args jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  m public.gw_codex_mtg_machines;
  j public.gw_codex_mtg_jobs;
  b public.gw_codex_mtg_bot_posts;
  p public.gw_posts;
  keys text[];
  result jsonb;
  body text;
  digest text;
  post_uuid uuid;
  job_uuid uuid;
  lease uuid;
  completion_source_key text;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHORIZED'; END IF;
  SELECT * INTO m FROM public.gw_codex_mtg_machines WHERE token_hash=p_token_hash FOR UPDATE;
  IF NOT FOUND OR m.revoked_at IS NOT NULL OR m.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHORIZED';
  END IF;
  IF m.rate_window<clock_timestamp()-interval '1 minute' THEN m.rate_window:=clock_timestamp(); m.rate_count:=0; END IF;
  IF m.rate_count>=180 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='RATE_LIMITED'; END IF;
  UPDATE public.gw_codex_mtg_machines SET last_seen_at=clock_timestamp(),rate_window=m.rate_window,rate_count=m.rate_count+1
    WHERE id=m.id RETURNING * INTO m;
  keys:=CASE p_action WHEN 'snapshot' THEN ARRAY[]::text[] WHEN 'machineHeartbeat' THEN ARRAY[]::text[]
    WHEN 'claim' THEN ARRAY[]::text[] WHEN 'post' THEN ARRAY['sourceKey','content','kind']
    WHEN 'heartbeat' THEN ARRAY['jobId','leaseToken'] WHEN 'complete' THEN ARRAY['jobId','leaseToken','status','summary'] END;
  IF keys IS NULL OR NOT coalesce(public.gw_data_keys(p_args,keys),false)
    OR (SELECT count(*) FROM jsonb_object_keys(p_args))<>cardinality(keys) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
  END IF;
  IF p_action IN ('snapshot','machineHeartbeat') THEN
    result:=jsonb_build_object('machine',public.gw_codex_mtg_machine_view(m));
    IF p_action='snapshot' THEN
      result:=result||jsonb_build_object('group',jsonb_build_object('id','a8081dbe-15db-4d41-a18b-b22bb55d2b39','name','CodexMTG',
        'url','/chat/a8081dbe-15db-4d41-a18b-b22bb55d2b39'),'posts',(
        SELECT coalesce(jsonb_agg(v ORDER BY v.created_at,v.id),'[]') FROM (
          SELECT snapshot_post.id,snapshot_post.user_id,left(snapshot_post.content,10000) AS content,snapshot_post.created_at,
            CASE WHEN snapshot_bot.post_id IS NULL THEN 'human' ELSE 'codex' END AS origin,mx.pc_name AS "pcName"
          FROM public.gw_posts snapshot_post LEFT JOIN public.gw_codex_mtg_bot_posts snapshot_bot ON snapshot_bot.post_id=snapshot_post.id
          LEFT JOIN public.gw_codex_mtg_machines mx ON mx.id=snapshot_bot.machine_id
          WHERE snapshot_post.group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39' ORDER BY snapshot_post.created_at DESC,snapshot_post.id DESC LIMIT 50
        ) v));
    END IF;
  ELSIF p_action='post' THEN
    IF NOT coalesce(jsonb_typeof(p_args->'sourceKey')='string' AND (p_args->>'sourceKey') ~ '^[A-Za-z0-9:_-]{1,128}$'
      AND (p_args->>'sourceKey') NOT LIKE 'job-complete:%' AND jsonb_typeof(p_args->'content')='string'
      AND char_length(p_args->>'content') BETWEEN 1 AND 10000 AND (p_args->>'content') ~ '[^[:space:]　]'
      AND jsonb_typeof(p_args->'kind')='string' AND (p_args->>'kind') IN ('report','request'),false) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
    END IF;
    digest:=encode(sha256(convert_to(p_args::text,'UTF8')),'hex');
    SELECT * INTO b FROM public.gw_codex_mtg_bot_posts WHERE machine_id=m.id AND source_key=p_args->>'sourceKey';
    IF FOUND THEN
      IF b.request_hash<>digest THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='IDEMPOTENCY_CONFLICT'; END IF;
      result:=jsonb_build_object('postId',b.post_id,'duplicate',true);
    ELSE
      post_uuid:=gen_random_uuid(); body:='【PC: '||m.pc_name||'】'||E'\n'||(p_args->>'content');
      INSERT INTO public.gw_codex_mtg_bot_posts(post_id,machine_id,source_key,kind,request_hash,body_hash)
      VALUES(post_uuid,m.id,p_args->>'sourceKey',p_args->>'kind',digest,encode(sha256(convert_to(body,'UTF8')),'hex'));
      INSERT INTO public.gw_posts(id,group_id,user_id,content,attachments)
      VALUES(post_uuid,'a8081dbe-15db-4d41-a18b-b22bb55d2b39','f78baef5-d40c-4886-b51d-a02efbf794fe',body,'[]') RETURNING * INTO p;
      IF p_args->>'kind'='request' THEN
        INSERT INTO public.gw_codex_mtg_jobs(post_id,author_id,requester_machine_id,origin,allow_code_change,source_hash,content_snapshot,requester_name)
        VALUES(p.id,p.user_id,m.id,'codex',false,public.gw_codex_mtg_source_hash(p),body,m.pc_name);
      END IF;
      UPDATE public.gw_groups SET updated_at=clock_timestamp() WHERE id=p.group_id;
      PERFORM public.gw_codex_mtg_wake();
      result:=jsonb_build_object('postId',post_uuid,'duplicate',false);
    END IF;
  ELSE
    IF m.pc_name<>'TSA' OR NOT m.can_execute_code THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
    IF p_action='claim' THEN
      -- Never automatically replay a job whose worker may already have changed files.
      UPDATE public.gw_codex_mtg_jobs SET status='needs_operator',summary='実行端末の応答期限が切れました。実行内容を確認してください',updated_at=clock_timestamp()
        WHERE status='claimed' AND lease_expires_at<=clock_timestamp();
      UPDATE public.gw_codex_mtg_jobs q SET status='needs_operator',summary='元の依頼または権限を確認してください',updated_at=clock_timestamp()
        WHERE status='queued' AND NOT public.gw_codex_mtg_job_valid(q);
      -- Only one project-changing session may run on the owner at a time.
      IF EXISTS(SELECT 1 FROM public.gw_codex_mtg_jobs WHERE status='claimed') THEN
        result:=jsonb_build_object('job',NULL);
      ELSE
        SELECT * INTO j FROM public.gw_codex_mtg_jobs WHERE status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
        IF NOT FOUND THEN result:=jsonb_build_object('job',NULL);
        ELSE
          lease:=gen_random_uuid();
          UPDATE public.gw_codex_mtg_jobs SET status='claimed',claimed_by=m.id,
            lease_hash=encode(sha256(convert_to(lease::text,'UTF8')),'hex'),lease_expires_at=clock_timestamp()+interval '180 seconds',
            heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
          result:=jsonb_build_object('job',jsonb_build_object('id',j.id,'postId',j.post_id,'content',j.content_snapshot,
            'requesterName',j.requester_name,'origin',j.origin,'allowCodeChange',j.allow_code_change,'leaseToken',lease));
        END IF;
      END IF;
    ELSE
      IF NOT coalesce(jsonb_typeof(p_args->'jobId')='string' AND (p_args->>'jobId') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        AND jsonb_typeof(p_args->'leaseToken')='string' AND (p_args->>'leaseToken') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$',false) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
      END IF;
      job_uuid:=(p_args->>'jobId')::uuid;
      SELECT * INTO j FROM public.gw_codex_mtg_jobs WHERE id=job_uuid FOR UPDATE;
      IF NOT FOUND OR j.claimed_by IS DISTINCT FROM m.id OR j.lease_hash IS DISTINCT FROM encode(sha256(convert_to((p_args->>'leaseToken')::uuid::text,'UTF8')),'hex') THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN';
      END IF;
      IF p_action='complete' THEN
        IF NOT coalesce(jsonb_typeof(p_args->'status')='string' AND (p_args->>'status') IN ('completed','needs_operator','failed')
          AND jsonb_typeof(p_args->'summary')='string' AND char_length(p_args->>'summary') BETWEEN 1 AND 10000
          AND (p_args->>'summary') ~ '[^[:space:]　]',false) THEN
          RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
        END IF;
        digest:=encode(sha256(convert_to(p_args::text,'UTF8')),'hex');
        IF j.completion_hash IS NOT NULL THEN
          IF j.completion_hash<>digest THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='IDEMPOTENCY_CONFLICT'; END IF;
          RETURN jsonb_build_object('ok',true,'data',jsonb_build_object('jobId',j.id,'status',j.status,'postId',j.result_post_id,'duplicate',true));
        END IF;
      END IF;
      IF j.status<>'claimed' OR j.lease_expires_at<=clock_timestamp() OR NOT public.gw_codex_mtg_job_valid(j) THEN
        UPDATE public.gw_codex_mtg_jobs SET status='needs_operator',summary=coalesce(summary,'依頼・権限・端末の応答期限を確認してください'),updated_at=clock_timestamp()
          WHERE id=j.id AND status IN ('queued','claimed');
        RETURN jsonb_build_object('ok',false,'code','CONFLICT');
      END IF;
      IF p_action='heartbeat' THEN
        UPDATE public.gw_codex_mtg_jobs SET heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp()
          WHERE id=j.id RETURNING * INTO j;
        result:=jsonb_build_object('leaseExpiresAt',j.lease_expires_at);
      ELSE
        post_uuid:=gen_random_uuid(); completion_source_key:='job-complete:'||j.id;
        body:='【PC: '||m.pc_name||'】'||E'\n'||CASE p_args->>'status' WHEN 'completed' THEN '完了' WHEN 'needs_operator' THEN '確認待ち' ELSE '失敗' END
          ||E'\n'||(p_args->>'summary');
        INSERT INTO public.gw_codex_mtg_bot_posts(post_id,machine_id,source_key,kind,request_hash,body_hash)
        VALUES(post_uuid,m.id,completion_source_key,'report',digest,encode(sha256(convert_to(body,'UTF8')),'hex'));
        INSERT INTO public.gw_posts(id,group_id,user_id,content,attachments)
        VALUES(post_uuid,'a8081dbe-15db-4d41-a18b-b22bb55d2b39','f78baef5-d40c-4886-b51d-a02efbf794fe',body,'[]');
        UPDATE public.gw_codex_mtg_jobs SET status=p_args->>'status',summary=p_args->>'summary',completion_hash=digest,
          result_post_id=post_uuid,updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
        UPDATE public.gw_groups SET updated_at=clock_timestamp() WHERE id='a8081dbe-15db-4d41-a18b-b22bb55d2b39';
        result:=jsonb_build_object('jobId',j.id,'status',j.status,'postId',post_uuid,'duplicate',false);
      END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('ok',true,'data',result);
END;
$$;

CREATE FUNCTION public.gw_codex_mtg_admin(p_actor_id uuid,p_action text,p_args jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  actor public.gw_users;
  m public.gw_codex_mtg_machines;
  result jsonb;
  pc text;
  seen timestamptz;
BEGIN
  SELECT u.* INTO actor FROM public.gw_users u JOIN public.gw_group_members gm ON gm.user_id=u.id
    AND gm.group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39'
    WHERE u.id=p_actor_id AND u.status='approved' AND u.role IN ('executive','admin') FOR SHARE OF u,gm;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
  IF p_action='status' THEN
    IF NOT coalesce(public.gw_data_keys(p_args,ARRAY[]::text[]),false) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
    UPDATE public.gw_codex_mtg_jobs SET status='needs_operator',summary='実行端末の応答期限が切れました。実行内容を確認してください',updated_at=clock_timestamp()
      WHERE status='claimed' AND lease_expires_at<=clock_timestamp();
    SELECT max(last_seen_at) INTO seen FROM public.gw_codex_mtg_machines WHERE pc_name='TSA' AND revoked_at IS NULL AND expires_at>clock_timestamp();
    result:=jsonb_build_object('status',jsonb_build_object('ownerPcName','TSA','online',coalesce(seen>clock_timestamp()-interval '2 minutes',false),
      'lastSeenAt',seen,'pendingCount',(SELECT count(*) FROM public.gw_codex_mtg_jobs WHERE status='queued'),
      'runningCount',(SELECT count(*) FROM public.gw_codex_mtg_jobs WHERE status='claimed'),
      'needsOperatorCount',(SELECT count(*) FROM public.gw_codex_mtg_jobs WHERE status='needs_operator')),
      'machines',(SELECT coalesce(jsonb_agg(public.gw_codex_mtg_machine_view(mx) ORDER BY mx.created_at DESC),'[]') FROM public.gw_codex_mtg_machines mx),
      'jobs',(SELECT coalesce(jsonb_agg(v ORDER BY v."createdAt" DESC,v.id),'[]') FROM (
        SELECT id,status,created_at AS "createdAt",summary,post_id AS "postId" FROM public.gw_codex_mtg_jobs ORDER BY created_at DESC,id LIMIT 50) v));
  ELSE
    IF actor.role<>'executive' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
    IF p_action='register' THEN
      IF NOT coalesce(public.gw_data_keys(p_args,ARRAY['pcName','tokenHash']),false)
        OR NOT coalesce(jsonb_typeof(p_args->'pcName')='string' AND (p_args->>'pcName') ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
        AND jsonb_typeof(p_args->'tokenHash')='string' AND (p_args->>'tokenHash') ~ '^[0-9a-f]{64}$',false) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
      END IF;
      pc:=p_args->>'pcName';
      PERFORM pg_advisory_xact_lock(hashtextextended('gw-codex-mtg-register:'||pc,0));
      UPDATE public.gw_codex_mtg_machines SET revoked_at=clock_timestamp(),revoked_by=actor.id WHERE pc_name=pc AND revoked_at IS NULL;
      UPDATE public.gw_codex_mtg_jobs SET status='needs_operator',summary='実行端末の接続キーが変更されました',updated_at=clock_timestamp()
        WHERE status='claimed' AND claimed_by IN (SELECT id FROM public.gw_codex_mtg_machines WHERE pc_name=pc AND revoked_at IS NOT NULL);
      INSERT INTO public.gw_codex_mtg_machines(pc_name,token_hash,can_execute_code,created_by)
      VALUES(pc,p_args->>'tokenHash',pc='TSA',actor.id) RETURNING * INTO m;
    ELSIF p_action='revoke' THEN
      IF NOT coalesce(public.gw_data_keys(p_args,ARRAY['machineId']),false)
        OR NOT coalesce(jsonb_typeof(p_args->'machineId')='string' AND (p_args->>'machineId') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$',false) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
      END IF;
      UPDATE public.gw_codex_mtg_machines SET revoked_at=coalesce(revoked_at,clock_timestamp()),revoked_by=actor.id
        WHERE id=(p_args->>'machineId')::uuid RETURNING * INTO m;
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND'; END IF;
      UPDATE public.gw_codex_mtg_jobs SET status='needs_operator',summary='端末の接続キーが失効しました',updated_at=clock_timestamp()
        WHERE status IN ('queued','claimed') AND (claimed_by=m.id OR requester_machine_id=m.id);
    ELSE RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
    END IF;
    result:=jsonb_build_object('machine',public.gw_codex_mtg_machine_view(m));
  END IF;
  RETURN jsonb_build_object('ok',true,'data',result);
END;
$$;

REVOKE ALL ON FUNCTION public.gw_codex_mtg_wake(),public.gw_codex_mtg_source_hash(public.gw_posts),
  public.gw_codex_mtg_member_guard(),public.gw_codex_mtg_sync_user(),public.gw_codex_mtg_group_guard(),
  public.gw_codex_mtg_post_guard(),public.gw_codex_mtg_capture_post(),public.gw_codex_mtg_job_valid(public.gw_codex_mtg_jobs),
  public.gw_codex_mtg_machine_view(public.gw_codex_mtg_machines),public.gw_codex_mtg_machine(text,text,jsonb),
  public.gw_codex_mtg_admin(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gw_codex_mtg_machine(text,text,jsonb),public.gw_codex_mtg_admin(uuid,text,jsonb) TO service_role;
COMMIT;
