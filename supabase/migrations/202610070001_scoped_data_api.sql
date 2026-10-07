-- Data API credentials are SHA-256 hashes only. This is an additive boundary;
-- existing board/chat/TSG integration endpoints keep their existing contracts.
BEGIN;
-- LINE sessions are checked by server APIs using service_role. Browser UI has
-- no direct table/realtime client. Public SELECT policies must not offer an
-- anonymous path around the scoped connection API.
DROP POLICY IF EXISTS gw_posts_select_all ON public.gw_posts;
DROP POLICY IF EXISTS gw_tasks_select_all ON public.gw_tasks;
REVOKE ALL ON public.gw_groups,public.gw_group_members,public.gw_posts,public.gw_tasks FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.gw_groups,public.gw_group_members,public.gw_posts,public.gw_tasks TO service_role;
-- This legacy workflow can create a management-board post and must remain a
-- server-only RPC; its existing HTTP/Bridge callers use service_role.
REVOKE ALL ON FUNCTION public.gw_approve_paid_leave_request_with_management_post(uuid,uuid),
  public.gw_enforce_group_posting_policy() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gw_approve_paid_leave_request_with_management_post(uuid,uuid),
  public.gw_enforce_group_posting_policy() TO service_role;
-- Audited legacy SECURITY DEFINER workflow RPCs trust an actor UUID supplied
-- by their authenticated server caller. Granting PUBLIC execution would let a
-- bare anon key alter HR/leave/shift state without that server authorization.
REVOKE ALL ON FUNCTION public.gw_approve_paid_leave_request(uuid,uuid),
  public.gw_approve_paid_leave_request_flexible(uuid,uuid),
  public.gw_confirm_workday_resolution(uuid,uuid,text),
  public.gw_create_and_approve_paid_leave_request(jsonb,uuid),
  public.gw_create_shift_confirmation_alerts(uuid),
  public.gw_import_paid_leave_usage(uuid,uuid,numeric,date,text,uuid),
  public.gw_link_paid_leave_request_to_shift(uuid,uuid),
  public.gw_reject_paid_leave_request(uuid,uuid,text),
  public.gw_reopen_workday_resolution(uuid,uuid),
  public.gw_retire_payroll_employee(uuid,date,uuid),
  public.gw_sync_shift_paid_leave_batch(uuid,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gw_approve_paid_leave_request(uuid,uuid),
  public.gw_approve_paid_leave_request_flexible(uuid,uuid),
  public.gw_confirm_workday_resolution(uuid,uuid,text),
  public.gw_create_and_approve_paid_leave_request(jsonb,uuid),
  public.gw_create_shift_confirmation_alerts(uuid),
  public.gw_import_paid_leave_usage(uuid,uuid,numeric,date,text,uuid),
  public.gw_link_paid_leave_request_to_shift(uuid,uuid),
  public.gw_reject_paid_leave_request(uuid,uuid,text),
  public.gw_reopen_workday_resolution(uuid,uuid),
  public.gw_retire_payroll_employee(uuid,date,uuid),
  public.gw_sync_shift_paid_leave_batch(uuid,jsonb,uuid) TO service_role;
CREATE TABLE public.gw_data_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80 AND label ~ '[^[:space:]　]'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  principal_user_id uuid NOT NULL REFERENCES public.gw_users(id),
  scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 14),
  allowed_group_ids uuid[] NOT NULL CHECK (cardinality(allowed_group_ids) BETWEEN 1 AND 20),
  max_limit integer NOT NULL DEFAULT 20 CHECK (max_limit BETWEEN 1 AND 20),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by uuid NOT NULL REFERENCES public.gw_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.gw_data_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.gw_data_connections(id),
  group_id uuid NOT NULL REFERENCES public.gw_groups(id),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000 AND content ~ '[^[:space:]　]'),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  post_id uuid REFERENCES public.gw_posts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gw_data_drafts_connection_created ON public.gw_data_drafts(connection_id,created_at DESC,id);
CREATE TABLE public.gw_data_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.gw_data_connections(id),
  request_id uuid NOT NULL,
  operation text NOT NULL,
  actor_user_id uuid REFERENCES public.gw_users(id),
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gw_data_audit_connection_created ON public.gw_data_audit(connection_id,created_at DESC,id);
CREATE TABLE public.gw_data_idempotency (
  connection_id uuid NOT NULL REFERENCES public.gw_data_connections(id),
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  group_id uuid NOT NULL REFERENCES public.gw_groups(id),
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id,key)
);
CREATE TABLE public.gw_data_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.gw_data_connections(id),
  draft_id uuid NOT NULL REFERENCES public.gw_data_drafts(id),
  draft_version bigint NOT NULL,
  diff jsonb NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','committed')),
  approved_by uuid REFERENCES public.gw_users(id),
  approved_at timestamptz,
  committed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gw_data_confirmations_connection_created ON public.gw_data_confirmations(connection_id,created_at DESC,id);

ALTER TABLE public.gw_data_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gw_data_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gw_data_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gw_data_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gw_data_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gw_data_connections,public.gw_data_drafts,public.gw_data_audit,
  public.gw_data_idempotency,public.gw_data_confirmations FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.gw_data_connections,public.gw_data_drafts,public.gw_data_audit,
  public.gw_data_idempotency,public.gw_data_confirmations TO service_role;

CREATE FUNCTION public.gw_data_keys(p_value jsonb,p_allowed text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  RETURN NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p_value) k WHERE NOT k=ANY(p_allowed));
END;
$$;
CREATE FUNCTION public.gw_data_version(p_value timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT to_char(p_value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;
CREATE FUNCTION public.gw_data_connection_view(c public.gw_data_connections) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('id',c.id,'label',c.label,'principal_user_id',c.principal_user_id,
    'scopes',c.scopes,'allowed_group_ids',c.allowed_group_ids,'max_limit',c.max_limit,
    'expires_at',c.expires_at,'revoked_at',c.revoked_at,'created_at',c.created_at);
$$;
CREATE FUNCTION public.gw_data_confirmation_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (NEW.id,NEW.connection_id,NEW.draft_id,NEW.draft_version,NEW.diff,NEW.digest,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.connection_id,OLD.draft_id,OLD.draft_version,OLD.diff,OLD.digest,OLD.expires_at,OLD.created_at)
    OR NOT ((OLD.status='pending' AND NEW.status='approved')
      OR (OLD.status='approved' AND NEW.status='committed')) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFLICT';
  END IF;
  IF NEW.status='approved' AND (NEW.approved_by IS NULL OR NEW.approved_at IS NULL)
    OR NEW.status='committed' AND ((NEW.approved_by,NEW.approved_at) IS DISTINCT FROM (OLD.approved_by,OLD.approved_at)
      OR NEW.committed_at IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFIRMATION_REQUIRED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gw_data_confirmations_immutable BEFORE UPDATE ON public.gw_data_confirmations
FOR EACH ROW EXECUTE FUNCTION public.gw_data_confirmation_immutable();

CREATE FUNCTION public.gw_data_api_execute(
  p_token_hash text,p_operation text,p_args jsonb,p_idempotency_key text,
  p_expected_version text,p_confirmation_id uuid,p_request_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
DECLARE
  c public.gw_data_connections;
  u public.gw_users;
  d public.gw_data_drafts;
  t public.gw_tasks;
  p public.gw_posts;
  cf public.gw_data_confirmations;
  existing public.gw_data_idempotency;
  allowed_ops constant text[] := ARRAY['boards.list','posts.search','posts.get','knowledge.search','knowledge.get',
    'drafts.create','drafts.update','drafts.get','drafts.list','tasks.search','tasks.get','tasks.complete',
    'posts.publish.prepare','posts.publish.commit'];
  allowed_keys text[];
  board_ids uuid[] := '{}';
  member record;
  target_id uuid;
  target_group uuid;
  requested_group uuid;
  take_count integer;
  search_text text := '';
  new_content text;
  mutation boolean;
  request_hash text;
  result jsonb;
  before_value jsonb;
  after_value jsonb;
  frozen_diff jsonb;
  frozen_digest text;
  new_post uuid;
BEGIN
  IF p_request_id IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHORIZED';
  END IF;
  SELECT * INTO c FROM public.gw_data_connections WHERE token_hash=p_token_hash FOR UPDATE;
  IF NOT FOUND OR c.revoked_at IS NOT NULL OR c.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHORIZED';
  END IF;
  SELECT * INTO u FROM public.gw_users WHERE id=c.principal_user_id FOR SHARE;
  IF NOT FOUND OR u.status IS DISTINCT FROM 'approved' OR u.role IS DISTINCT FROM 'executive' THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHORIZED';
  END IF;
  IF p_operation IS NULL OR NOT p_operation=ANY(allowed_ops) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
  END IF;
  IF NOT p_operation=ANY(c.scopes) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
  allowed_keys := CASE
    WHEN p_operation='boards.list' THEN ARRAY['query','limit']
    WHEN p_operation IN ('posts.search','knowledge.search','tasks.search') THEN ARRAY['group_id','query','limit']
    WHEN p_operation='drafts.list' THEN ARRAY['group_id','limit']
    WHEN p_operation='drafts.create' THEN ARRAY['group_id','content']
    WHEN p_operation='drafts.update' THEN ARRAY['id','content']
    ELSE ARRAY['id'] END;
  IF NOT coalesce(public.gw_data_keys(p_args,allowed_keys),false) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
  END IF;
  take_count := c.max_limit;
  IF p_args ? 'limit' THEN
    IF jsonb_typeof(p_args->'limit')<>'number' OR (p_args->>'limit') !~ '^([1-9]|1[0-9]|20)$' THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
    END IF;
    take_count := (p_args->>'limit')::integer;
    IF take_count>c.max_limit THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
  END IF;
  IF p_args ? 'query' THEN
    IF jsonb_typeof(p_args->'query')<>'string' OR char_length(p_args->>'query')>256 THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
    END IF;
    search_text := btrim(p_args->>'query');
  END IF;
  IF p_args ? 'group_id' THEN
    IF jsonb_typeof(p_args->'group_id')<>'string' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
    requested_group := (p_args->>'group_id')::uuid;
  END IF;
  IF p_args ? 'id' THEN
    IF jsonb_typeof(p_args->'id')<>'string' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
    target_id := (p_args->>'id')::uuid;
  END IF;
  IF p_operation NOT IN ('boards.list','posts.search','knowledge.search','drafts.list','tasks.search','drafts.create')
    AND target_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
  IF p_operation IN ('drafts.create','drafts.update') THEN
    IF jsonb_typeof(p_args->'content') IS DISTINCT FROM 'string'
      OR char_length(p_args->>'content') NOT BETWEEN 1 AND 4000 OR (p_args->>'content') !~ '[^[:space:]　]' THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
    END IF;
    new_content := p_args->>'content';
  END IF;
  mutation := p_operation IN ('drafts.create','drafts.update','tasks.complete','posts.publish.prepare','posts.publish.commit');
  IF NOT mutation AND p_idempotency_key IS NOT NULL
    OR p_operation IN ('boards.list','posts.search','posts.get','knowledge.search','knowledge.get',
      'drafts.create','drafts.get','drafts.list','tasks.search','tasks.get') AND p_expected_version IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
  END IF;
  IF mutation AND (p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9:_-]{8,128}$') THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
  END IF;
  IF mutation AND p_operation<>'drafts.create' AND (p_expected_version IS NULL
    OR char_length(p_expected_version) NOT BETWEEN 1 AND 80 OR p_expected_version !~ '^[!-~]+$') THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
  END IF;
  IF p_operation='posts.publish.commit' AND p_confirmation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFIRMATION_REQUIRED';
  ELSIF p_operation<>'posts.publish.commit' AND p_confirmation_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
  END IF;
  -- Membership and group-policy locks serialize revocation with this call.
  FOR member IN SELECT gm.group_id FROM public.gw_group_members gm
    JOIN public.gw_groups g ON g.id=gm.group_id
    WHERE gm.user_id=c.principal_user_id AND gm.group_id=ANY(c.allowed_group_ids) AND g.type='board'
    ORDER BY gm.group_id FOR SHARE OF gm,g LOOP
    board_ids := array_append(board_ids,member.group_id);
  END LOOP;
  IF requested_group IS NOT NULL AND NOT requested_group=ANY(board_ids) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN';
  END IF;
  IF p_operation='drafts.create' THEN
    IF requested_group IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
    target_group := requested_group;
  ELSIF p_operation IN ('drafts.get','drafts.update','posts.publish.prepare','posts.publish.commit') THEN
    SELECT * INTO d FROM public.gw_data_drafts WHERE id=target_id AND connection_id=c.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND'; END IF;
    target_group := d.group_id;
  ELSIF p_operation IN ('tasks.get','tasks.complete') THEN
    SELECT * INTO t FROM public.gw_tasks WHERE id=target_id AND assignee_id=c.principal_user_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND'; END IF;
    SELECT * INTO p FROM public.gw_posts WHERE id=t.post_id FOR SHARE;
    IF NOT FOUND OR p.group_id<>t.group_id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND'; END IF;
    target_group := t.group_id;
  ELSIF p_operation IN ('posts.get','knowledge.get') THEN
    SELECT * INTO p FROM public.gw_posts WHERE id=target_id FOR SHARE;
    IF NOT FOUND OR p_operation='knowledge.get' AND NOT coalesce(p.is_pinned,false) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND';
    END IF;
    target_group := p.group_id;
  END IF;
  IF target_group IS NOT NULL AND NOT target_group=ANY(board_ids) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN';
  END IF;
  IF mutation THEN
    request_hash := encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'args',p_args,
      'expected_version',p_expected_version,'confirmation_id',p_confirmation_id)::text,'UTF8')),'hex');
    SELECT * INTO existing FROM public.gw_data_idempotency WHERE connection_id=c.id AND key=p_idempotency_key;
    IF FOUND THEN
      IF existing.request_hash<>request_hash THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='IDEMPOTENCY_CONFLICT'; END IF;
      IF NOT existing.group_id=ANY(board_ids) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
      INSERT INTO public.gw_data_audit(connection_id,request_id,operation,actor_user_id,after_data)
      VALUES(c.id,p_request_id,p_operation,c.principal_user_id,jsonb_build_object('replayed',true));
      RETURN existing.response;
    END IF;
  END IF;
  IF p_operation='boards.list' THEN
    SELECT jsonb_build_object('boards',coalesce(jsonb_agg(v),'[]')) INTO result FROM (
      SELECT g.id,g.name,g.description,g.posting_disabled FROM public.gw_groups g
      WHERE g.id=ANY(board_ids) AND (search_text='' OR position(lower(search_text) IN lower(g.name))>0)
      ORDER BY g.name,g.id LIMIT take_count
    ) v;
  ELSIF p_operation IN ('posts.search','knowledge.search') THEN
    SELECT jsonb_build_object(CASE WHEN p_operation='knowledge.search' THEN 'entries' ELSE 'posts' END,
      coalesce(jsonb_agg(v),'[]')) INTO result FROM (
      SELECT q.id,q.group_id,q.user_id AS author_id,q.content,q.is_pinned,q.parent_id,q.created_at,
        public.gw_data_version(coalesce(q.updated_at,q.created_at)) AS version
      FROM public.gw_posts q WHERE q.group_id=ANY(board_ids)
        AND (requested_group IS NULL OR q.group_id=requested_group)
        AND (p_operation='posts.search' OR q.is_pinned=true)
        AND (search_text='' OR position(lower(search_text) IN lower(coalesce(q.content,'')))>0)
      ORDER BY q.created_at DESC,q.id DESC LIMIT take_count
    ) v;
  ELSIF p_operation IN ('posts.get','knowledge.get') THEN
    result := jsonb_build_object(CASE WHEN p_operation='knowledge.get' THEN 'entry' ELSE 'post' END,
      jsonb_build_object('id',p.id,'group_id',p.group_id,'author_id',p.user_id,'content',p.content,
        'is_pinned',p.is_pinned,'parent_id',p.parent_id,'created_at',p.created_at,
        'version',public.gw_data_version(coalesce(p.updated_at,p.created_at))));
  ELSIF p_operation='drafts.list' THEN
    SELECT jsonb_build_object('drafts',coalesce(jsonb_agg(v),'[]')) INTO result FROM (
      SELECT q.id,q.group_id,q.content,q.version::text AS version,q.status,q.post_id,q.created_at,q.updated_at
      FROM public.gw_data_drafts q WHERE q.connection_id=c.id AND q.group_id=ANY(board_ids)
        AND (requested_group IS NULL OR q.group_id=requested_group)
      ORDER BY q.created_at DESC,q.id DESC LIMIT take_count
    ) v;
  ELSIF p_operation IN ('drafts.create','drafts.update','drafts.get') THEN
    IF p_operation='drafts.create' THEN
      INSERT INTO public.gw_data_drafts(connection_id,group_id,content) VALUES(c.id,target_group,new_content) RETURNING * INTO d;
    ELSIF p_operation='drafts.update' THEN
      IF d.status<>'draft' OR d.version::text<>p_expected_version THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFLICT'; END IF;
      before_value := jsonb_build_object('id',d.id,'group_id',d.group_id,'content',d.content,'version',d.version::text,'status',d.status);
      UPDATE public.gw_data_drafts SET content=new_content,version=version+1,updated_at=clock_timestamp() WHERE id=d.id RETURNING * INTO d;
    END IF;
    result := jsonb_build_object('draft',jsonb_build_object('id',d.id,'group_id',d.group_id,'content',d.content,
      'version',d.version::text,'status',d.status,'post_id',d.post_id,'created_at',d.created_at,'updated_at',d.updated_at));
    IF mutation THEN after_value := result->'draft'; END IF;
  ELSIF p_operation='tasks.search' THEN
    SELECT jsonb_build_object('tasks',coalesce(jsonb_agg(v),'[]')) INTO result FROM (
      SELECT q.id,q.post_id,q.group_id,q.due_date,q.completed_at,q.completed_by,q.canceled_at,
        post.content,public.gw_data_version(coalesce(q.updated_at,q.created_at)) AS version
      FROM public.gw_tasks q JOIN public.gw_posts post ON post.id=q.post_id AND post.group_id=q.group_id
      WHERE q.assignee_id=c.principal_user_id AND q.group_id=ANY(board_ids)
        AND (requested_group IS NULL OR q.group_id=requested_group)
        AND (search_text='' OR position(lower(search_text) IN lower(coalesce(post.content,'')))>0)
      ORDER BY q.due_date,q.id LIMIT take_count
    ) v;
  ELSIF p_operation IN ('tasks.get','tasks.complete') THEN
    IF p_operation='tasks.complete' THEN
      IF t.canceled_at IS NOT NULL OR t.completed_at IS NOT NULL
        OR public.gw_data_version(coalesce(t.updated_at,t.created_at)) IS DISTINCT FROM p_expected_version THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFLICT';
      END IF;
      before_value := jsonb_build_object('id',t.id,'completed_at',t.completed_at,'completed_by',t.completed_by,
        'version',public.gw_data_version(coalesce(t.updated_at,t.created_at)));
      UPDATE public.gw_tasks SET completed_at=clock_timestamp(),completed_by=c.principal_user_id,updated_at=clock_timestamp()
      WHERE id=t.id RETURNING * INTO t;
      after_value := jsonb_build_object('id',t.id,'completed_at',t.completed_at,'completed_by',t.completed_by,
        'version',public.gw_data_version(coalesce(t.updated_at,t.created_at)));
    END IF;
    result := jsonb_build_object('task',jsonb_build_object('id',t.id,'post_id',t.post_id,'group_id',t.group_id,
      'due_date',t.due_date,'completed_at',t.completed_at,'completed_by',t.completed_by,'canceled_at',t.canceled_at,
      'content',p.content,'version',public.gw_data_version(coalesce(t.updated_at,t.created_at))));
  ELSIF p_operation IN ('posts.publish.prepare','posts.publish.commit') THEN
    IF d.status<>'draft' OR d.version::text<>p_expected_version THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFLICT'; END IF;
    IF EXISTS(SELECT 1 FROM public.gw_groups WHERE id=d.group_id AND posting_disabled=true) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN';
    END IF;
    frozen_diff := jsonb_build_object('before',jsonb_build_object('draft_id',d.id,'post_id',NULL,'status','draft','version',d.version::text),
      'after',jsonb_build_object('draft_id',d.id,'group_id',d.group_id,
        'group_name',(SELECT name FROM public.gw_groups WHERE id=d.group_id),
        'author_id',c.principal_user_id,'content',d.content,'status','published','version',(d.version+1)::text));
    frozen_digest := encode(sha256(convert_to(jsonb_build_object('connection_id',c.id,'draft_id',d.id,
      'draft_version',d.version::text,'diff',frozen_diff)::text,'UTF8')),'hex');
    IF p_operation='posts.publish.prepare' THEN
      INSERT INTO public.gw_data_confirmations(connection_id,draft_id,draft_version,diff,digest,expires_at)
      VALUES(c.id,d.id,d.version,frozen_diff,frozen_digest,clock_timestamp()+interval '10 minutes') RETURNING * INTO cf;
      result := jsonb_build_object('confirmation_id',cf.id,'draft_id',d.id,'version',d.version::text,
        'diff',cf.diff,'digest',cf.digest,'expires_at',cf.expires_at,'status','pending');
      after_value := result;
    ELSE
      SELECT * INTO cf FROM public.gw_data_confirmations WHERE id=p_confirmation_id AND connection_id=c.id AND draft_id=d.id FOR UPDATE;
      IF NOT FOUND OR cf.status<>'approved' OR cf.expires_at<=clock_timestamp() THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFIRMATION_REQUIRED';
      END IF;
      IF cf.draft_version<>d.version OR cf.diff<>frozen_diff OR cf.digest<>frozen_digest THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFLICT';
      END IF;
      PERFORM 1 FROM public.gw_users WHERE id=cf.approved_by AND role='executive' AND status='approved' FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFIRMATION_REQUIRED'; END IF;
      before_value := jsonb_build_object('draft_id',d.id,'version',d.version::text,'status',d.status,'post',NULL);
      INSERT INTO public.gw_posts(group_id,user_id,content,attachments,is_pinned)
      VALUES(d.group_id,c.principal_user_id,d.content,'[]',false) RETURNING id INTO new_post;
      UPDATE public.gw_data_drafts SET status='published',post_id=new_post,version=version+1,updated_at=clock_timestamp()
      WHERE id=d.id RETURNING * INTO d;
      UPDATE public.gw_data_confirmations SET status='committed',committed_at=clock_timestamp() WHERE id=cf.id;
      result := jsonb_build_object('post_id',new_post,'draft_id',d.id,'version',d.version::text,'status',d.status);
      after_value := result || jsonb_build_object('post',frozen_diff->'after');
    END IF;
  END IF;
  result := jsonb_build_object('ok',true,'data',result);
  INSERT INTO public.gw_data_audit(connection_id,request_id,operation,actor_user_id,before_data,after_data)
  VALUES(c.id,p_request_id,p_operation,c.principal_user_id,before_value,after_value);
  IF mutation THEN
    INSERT INTO public.gw_data_idempotency(connection_id,key,group_id,request_hash,response)
    VALUES(c.id,p_idempotency_key,target_group,request_hash,result);
  END IF;
  RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
END;
$$;

CREATE FUNCTION public.gw_data_connection_admin(p_actor_id uuid,p_action text,p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
DECLARE
  actor public.gw_users;
  c public.gw_data_connections;
  d public.gw_data_drafts;
  cf public.gw_data_confirmations;
  allowed_ops constant text[] := ARRAY['boards.list','posts.search','posts.get','knowledge.search','knowledge.get',
    'drafts.create','drafts.update','drafts.get','drafts.list','tasks.search','tasks.get','tasks.complete',
    'posts.publish.prepare','posts.publish.commit'];
  scope_values text[];
  board_values uuid[];
  board_count integer;
  desired_expiry timestamptz;
  desired_limit integer;
  target_id uuid;
  member record;
  response_value jsonb;
  before_value jsonb;
  after_value jsonb;
  current_diff jsonb;
  current_digest text;
  request_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO actor FROM public.gw_users WHERE id=p_actor_id AND status='approved' AND role='executive' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
  IF p_action='create' THEN
    IF NOT coalesce(public.gw_data_keys(p_args,ARRAY['label','token_hash','principal_user_id','scopes','allowed_group_ids','expires_at','max_limit']),false)
      OR jsonb_typeof(p_args->'label') IS DISTINCT FROM 'string' OR char_length(btrim(p_args->>'label')) NOT BETWEEN 1 AND 80
      OR (p_args->>'label') !~ '[^[:space:]　]'
      OR jsonb_typeof(p_args->'token_hash') IS DISTINCT FROM 'string' OR (p_args->>'token_hash') !~ '^[0-9a-f]{64}$'
      OR (p_args->>'principal_user_id')::uuid IS DISTINCT FROM actor.id
      OR jsonb_typeof(p_args->'scopes') IS DISTINCT FROM 'array'
      OR jsonb_typeof(p_args->'allowed_group_ids') IS DISTINCT FROM 'array'
      OR jsonb_typeof(p_args->'expires_at') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_args->'max_limit') IS DISTINCT FROM 'number' OR (p_args->>'max_limit') !~ '^([1-9]|1[0-9]|20)$' THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_args->'scopes') v WHERE jsonb_typeof(v)<>'string')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_args->'allowed_group_ids') v WHERE jsonb_typeof(v)<>'string') THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
    END IF;
    SELECT array_agg(v) INTO scope_values FROM jsonb_array_elements_text(p_args->'scopes') v;
    SELECT array_agg(v::uuid) INTO board_values FROM jsonb_array_elements_text(p_args->'allowed_group_ids') v;
    IF coalesce(cardinality(scope_values),0) NOT BETWEEN 1 AND 14 OR NOT scope_values<@allowed_ops
      OR cardinality(scope_values)<>(SELECT count(DISTINCT v) FROM unnest(scope_values) v)
      OR coalesce(cardinality(board_values),0) NOT BETWEEN 1 AND 20
      OR cardinality(board_values)<>(SELECT count(DISTINCT v) FROM unnest(board_values) v) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
    END IF;
    desired_expiry := (p_args->>'expires_at')::timestamptz;
    desired_limit := (p_args->>'max_limit')::integer;
    IF desired_expiry<=clock_timestamp() OR desired_expiry>clock_timestamp()+interval '90 days' THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
    END IF;
    -- Serialize issuance per owner so concurrent requests cannot exceed 20.
    PERFORM pg_advisory_xact_lock(hashtextextended('gw-data-issue:'||actor.id,0));
    SELECT * INTO c FROM public.gw_data_connections WHERE token_hash=p_args->>'token_hash' FOR UPDATE;
    IF FOUND THEN
      IF c.created_by<>actor.id OR c.principal_user_id<>actor.id OR c.label<>btrim(p_args->>'label')
        OR c.scopes<>scope_values OR c.allowed_group_ids<>board_values OR c.expires_at<>desired_expiry OR c.max_limit<>desired_limit THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFLICT';
      END IF;
      RETURN jsonb_build_object('ok',true,'data',jsonb_build_object('connection',public.gw_data_connection_view(c)));
    END IF;
    IF (SELECT count(*) FROM public.gw_data_connections WHERE created_by=actor.id AND revoked_at IS NULL AND expires_at>clock_timestamp())>=20 THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
    END IF;
    board_count := 0;
    FOR member IN SELECT gm.group_id FROM public.gw_group_members gm JOIN public.gw_groups g ON g.id=gm.group_id
      WHERE gm.user_id=actor.id AND gm.group_id=ANY(board_values) AND g.type='board' ORDER BY gm.group_id FOR SHARE OF gm,g LOOP
      board_count := board_count+1;
    END LOOP;
    IF board_count<>cardinality(board_values) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
    INSERT INTO public.gw_data_connections(label,token_hash,principal_user_id,scopes,allowed_group_ids,max_limit,expires_at,created_by)
    VALUES(btrim(p_args->>'label'),p_args->>'token_hash',actor.id,scope_values,board_values,desired_limit,desired_expiry,actor.id) RETURNING * INTO c;
    after_value := public.gw_data_connection_view(c);
    response_value := jsonb_build_object('connection',after_value);
  ELSIF p_action='list' THEN
    IF NOT coalesce(public.gw_data_keys(p_args,'{}'),false) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
    SELECT jsonb_build_object('connections',coalesce(jsonb_agg(public.gw_data_connection_view(q::public.gw_data_connections)),'[]')) INTO response_value
    FROM (SELECT * FROM public.gw_data_connections WHERE created_by=actor.id ORDER BY created_at DESC,id DESC LIMIT 100) q;
    response_value := response_value || jsonb_build_object('principal',jsonb_build_object('id',actor.id,'name',coalesce(actor.real_name,actor.display_name)),
      'boards',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name) ORDER BY g.name,g.id),'[]')
        FROM public.gw_groups g JOIN public.gw_group_members gm ON gm.group_id=g.id WHERE gm.user_id=actor.id AND g.type='board'));
  ELSIF p_action IN ('list_confirmations','list_audit') THEN
    IF NOT coalesce(public.gw_data_keys(p_args,ARRAY['limit']),false) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
    desired_limit := 20;
    IF p_args ? 'limit' THEN
      IF jsonb_typeof(p_args->'limit')<>'number' OR (p_args->>'limit') !~ '^([1-9]|1[0-9]|20)$' THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
      END IF;
      desired_limit := (p_args->>'limit')::integer;
    END IF;
    IF p_action='list_confirmations' THEN
      SELECT jsonb_build_object('confirmations',coalesce(jsonb_agg(v),'[]')) INTO response_value FROM (
        SELECT q.id,q.connection_id,cx.label AS connection_label,q.draft_id,q.draft_version::text AS version,
          q.diff,q.digest,q.status,q.expires_at,q.created_at,q.approved_at,q.committed_at
        FROM public.gw_data_confirmations q JOIN public.gw_data_connections cx ON cx.id=q.connection_id
        WHERE cx.created_by=actor.id ORDER BY q.created_at DESC,q.id DESC LIMIT desired_limit
      ) v;
    ELSE
      SELECT jsonb_build_object('audit',coalesce(jsonb_agg(v),'[]')) INTO response_value FROM (
        SELECT q.id,q.connection_id,q.request_id,q.operation,q.actor_user_id,q.before_data,q.after_data,q.created_at
        FROM public.gw_data_audit q JOIN public.gw_data_connections cx ON cx.id=q.connection_id
        WHERE cx.created_by=actor.id ORDER BY q.created_at DESC,q.id DESC LIMIT desired_limit
      ) v;
    END IF;
  ELSIF p_action IN ('revoke','approve_confirmation') THEN
    IF NOT coalesce(public.gw_data_keys(p_args,CASE WHEN p_action='revoke' THEN ARRAY['id'] ELSE ARRAY['id','digest'] END),false)
      OR jsonb_typeof(p_args->'id') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
    target_id := (p_args->>'id')::uuid;
    IF p_action='revoke' THEN
      SELECT * INTO c FROM public.gw_data_connections WHERE id=target_id AND created_by=actor.id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND'; END IF;
      before_value := public.gw_data_connection_view(c);
      UPDATE public.gw_data_connections SET revoked_at=coalesce(revoked_at,clock_timestamp()),updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
      after_value := public.gw_data_connection_view(c);
      response_value := jsonb_build_object('id',c.id,'status','revoked');
    ELSE
      SELECT cx.* INTO c FROM public.gw_data_connections cx JOIN public.gw_data_confirmations q ON q.connection_id=cx.id
      WHERE q.id=target_id AND cx.created_by=actor.id FOR UPDATE OF cx;
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND'; END IF;
      SELECT * INTO cf FROM public.gw_data_confirmations WHERE id=target_id FOR UPDATE;
      SELECT * INTO d FROM public.gw_data_drafts WHERE id=cf.draft_id AND connection_id=c.id FOR UPDATE;
      IF c.revoked_at IS NOT NULL OR c.expires_at<=clock_timestamp() OR cf.expires_at<=clock_timestamp()
        OR cf.status NOT IN ('pending','approved') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFIRMATION_REQUIRED'; END IF;
      IF jsonb_typeof(p_args->'digest') IS DISTINCT FROM 'string' OR p_args->>'digest'<>cf.digest
        OR d.version<>cf.draft_version OR d.status<>'draft' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFLICT'; END IF;
      PERFORM 1 FROM public.gw_users WHERE id=c.principal_user_id AND status='approved' AND role='executive' FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
      PERFORM 1 FROM public.gw_group_members gm JOIN public.gw_groups g ON g.id=gm.group_id
      WHERE gm.user_id=c.principal_user_id AND g.id=d.group_id AND g.id=ANY(c.allowed_group_ids)
        AND g.type='board' AND NOT g.posting_disabled FOR SHARE OF gm,g;
      IF NOT FOUND OR NOT 'posts.publish.commit'=ANY(c.scopes) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
      current_diff := jsonb_build_object('before',jsonb_build_object('draft_id',d.id,'post_id',NULL,'status','draft','version',d.version::text),
        'after',jsonb_build_object('draft_id',d.id,'group_id',d.group_id,
          'group_name',(SELECT name FROM public.gw_groups WHERE id=d.group_id),
          'author_id',c.principal_user_id,'content',d.content,'status','published','version',(d.version+1)::text));
      current_digest := encode(sha256(convert_to(jsonb_build_object('connection_id',c.id,'draft_id',d.id,
        'draft_version',d.version::text,'diff',current_diff)::text,'UTF8')),'hex');
      IF cf.diff<>current_diff OR cf.digest<>current_digest THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFLICT'; END IF;
      IF cf.status='pending' THEN
        before_value := jsonb_build_object('confirmation_id',cf.id,'status',cf.status);
        UPDATE public.gw_data_confirmations SET status='approved',approved_by=actor.id,approved_at=clock_timestamp() WHERE id=cf.id RETURNING * INTO cf;
        after_value := jsonb_build_object('confirmation_id',cf.id,'status',cf.status,'digest',cf.digest,'diff',cf.diff);
      END IF;
      response_value := jsonb_build_object('id',cf.id,'status',cf.status);
    END IF;
  ELSE RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
  END IF;
  IF c.id IS NOT NULL THEN
    INSERT INTO public.gw_data_audit(connection_id,request_id,operation,actor_user_id,before_data,after_data)
    VALUES(c.id,request_id,'admin.'||p_action,actor.id,before_value,after_value);
  END IF;
  RETURN jsonb_build_object('ok',true,'data',response_value);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
END;
$$;

REVOKE ALL ON FUNCTION public.gw_data_keys(jsonb,text[]),public.gw_data_version(timestamptz),
  public.gw_data_connection_view(public.gw_data_connections),public.gw_data_confirmation_immutable(),
  public.gw_data_api_execute(text,text,jsonb,text,text,uuid,uuid),public.gw_data_connection_admin(uuid,text,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gw_data_api_execute(text,text,jsonb,text,text,uuid,uuid),
  public.gw_data_connection_admin(uuid,text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
