-- Explicit full-board grants; existing connections retain their original limits and identity.
ALTER TABLE public.gw_data_connections ADD COLUMN IF NOT EXISTS all_boards boolean NOT NULL DEFAULT false;
ALTER TABLE public.gw_data_connections ADD COLUMN IF NOT EXISTS pc_name text;
ALTER TABLE public.gw_data_connections DROP CONSTRAINT IF EXISTS gw_data_connections_allowed_group_ids_check;
ALTER TABLE public.gw_data_connections ADD CONSTRAINT gw_data_connections_allowed_group_ids_check CHECK(cardinality(allowed_group_ids)<=20 AND (all_boards OR cardinality(allowed_group_ids)>=1));
ALTER TABLE public.gw_data_connections DROP CONSTRAINT IF EXISTS gw_data_connections_pc_name_check;
ALTER TABLE public.gw_data_connections ADD CONSTRAINT gw_data_connections_pc_name_check CHECK(pc_name IS NULL OR pc_name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$');

CREATE OR REPLACE FUNCTION public.gw_data_connection_view(c public.gw_data_connections) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('id',c.id,'label',c.label,'principal_user_id',c.principal_user_id,
    'scopes',c.scopes,'allowed_group_ids',c.allowed_group_ids,'max_limit',c.max_limit,
    'expires_at',c.expires_at,'revoked_at',c.revoked_at,'created_at',c.created_at,'all_boards',c.all_boards,'pc_name',c.pc_name);
$$;

CREATE OR REPLACE FUNCTION public.gw_data_registered_pc(p_name text) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE machine record; canonical_name text; matches integer := 0;
BEGIN
  IF p_name IS NULL THEN RETURN NULL; END IF;
  IF p_name !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
  FOR machine IN SELECT m.pc_name FROM public.gw_codex_mtg_machines m WHERE lower(m.pc_name)=lower(p_name)
    AND m.revoked_at IS NULL AND m.expires_at>clock_timestamp() ORDER BY m.id FOR SHARE OF m LOOP
    matches:=matches+1; canonical_name:=machine.pc_name;
  END LOOP;
  IF matches<>1 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
  RETURN canonical_name;
END;
$$;

CREATE OR REPLACE FUNCTION public.gw_data_publication(p_pc_name text,p_principal uuid,p_body text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE author uuid := p_principal; content text := p_body;
BEGIN
  IF p_pc_name IS NOT NULL THEN
    author:='f78baef5-d40c-4886-b51d-a02efbf794fe'::uuid;
    PERFORM 1 FROM public.gw_users WHERE id=author AND status='approved' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
    content:='【PC: '||p_pc_name||'】'||chr(10)||p_body;
  END IF;
  IF char_length(content) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
  RETURN jsonb_build_object('author_id',author,'content',content);
END;
$$;

CREATE OR REPLACE FUNCTION public.gw_data_api_execute(
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
  page_offset integer := 0;
  list_key text;
  page_values jsonb;
  publication jsonb;
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
    WHEN p_operation='boards.list' THEN ARRAY['query','limit','offset']
    WHEN p_operation IN ('posts.search','knowledge.search','tasks.search') THEN ARRAY['group_id','query','limit','offset']
    WHEN p_operation='drafts.list' THEN ARRAY['group_id','limit','offset']
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
  IF p_args ? 'offset' THEN
    IF jsonb_typeof(p_args->'offset')<>'number' OR (p_args->>'offset') !~ '^(0|[1-9][0-9]{0,4})$' OR (p_args->>'offset')::integer>10000 THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
    END IF;
    page_offset := (p_args->>'offset')::integer;
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
  IF c.all_boards THEN
    -- Explicit all-board grants include future boards without adding human memberships.
    FOR member IN SELECT g.id AS group_id FROM public.gw_groups g WHERE g.type='board' ORDER BY g.id FOR SHARE OF g LOOP
      board_ids := array_append(board_ids,member.group_id);
    END LOOP;
  ELSE
  FOR member IN SELECT gm.group_id FROM public.gw_group_members gm
    JOIN public.gw_groups g ON g.id=gm.group_id
    WHERE gm.user_id=c.principal_user_id AND gm.group_id=ANY(c.allowed_group_ids) AND g.type='board'
    ORDER BY gm.group_id FOR SHARE OF gm,g LOOP
    board_ids := array_append(board_ids,member.group_id);
  END LOOP;
  END IF;
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
      ORDER BY g.name,g.id LIMIT take_count+1 OFFSET page_offset
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
      ORDER BY q.created_at DESC,q.id DESC LIMIT take_count+1 OFFSET page_offset
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
      ORDER BY q.created_at DESC,q.id DESC LIMIT take_count+1 OFFSET page_offset
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
      ORDER BY q.due_date,q.id LIMIT take_count+1 OFFSET page_offset
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
    publication := public.gw_data_publication(c.pc_name,c.principal_user_id,d.content);
    frozen_diff := jsonb_build_object('before',jsonb_build_object('draft_id',d.id,'post_id',NULL,'status','draft','version',d.version::text),
      'after',jsonb_build_object('draft_id',d.id,'group_id',d.group_id,
        'group_name',(SELECT name FROM public.gw_groups WHERE id=d.group_id),
        'author_id',publication->>'author_id','content',publication->>'content','status','published','version',(d.version+1)::text));
    frozen_digest := encode(sha256(convert_to(jsonb_build_object('connection_id',c.id,'draft_id',d.id,
      'draft_version',d.version::text,'diff',frozen_diff)::text,'UTF8')),'hex');
    IF p_operation='posts.publish.prepare' THEN
      INSERT INTO public.gw_data_confirmations(connection_id,draft_id,draft_version,diff,digest,expires_at)
      VALUES(c.id,d.id,d.version,frozen_diff,frozen_digest,clock_timestamp()+interval '10 minutes') RETURNING * INTO cf;
      result := jsonb_build_object('confirmation_id',cf.id,'draft_id',d.id,'version',d.version::text,
        'diff',cf.diff,'digest',cf.digest,'expires_at',cf.expires_at,'status','pending','requiresApproval',false);
      after_value := result;
    ELSE
      SELECT * INTO cf FROM public.gw_data_confirmations WHERE id=p_confirmation_id AND connection_id=c.id AND draft_id=d.id FOR UPDATE;
      IF NOT FOUND OR cf.status NOT IN ('pending','approved') OR cf.expires_at<=clock_timestamp() THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFIRMATION_REQUIRED';
      END IF;
      IF cf.draft_version<>d.version OR cf.diff<>frozen_diff OR cf.digest<>frozen_digest THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFLICT';
      END IF;
      before_value := jsonb_build_object('draft_id',d.id,'version',d.version::text,'status',d.status,'post',NULL);
      INSERT INTO public.gw_posts(group_id,user_id,content,attachments,is_pinned)
      VALUES(d.group_id,(publication->>'author_id')::uuid,publication->>'content','[]',false) RETURNING id INTO new_post;
      UPDATE public.gw_data_drafts SET status='published',post_id=new_post,version=version+1,updated_at=clock_timestamp()
      WHERE id=d.id RETURNING * INTO d;
      UPDATE public.gw_data_confirmations SET status='committed',committed_at=clock_timestamp() WHERE id=cf.id;
      result := jsonb_build_object('post_id',new_post,'draft_id',d.id,'version',d.version::text,'status',d.status);
      after_value := result || jsonb_build_object('post',frozen_diff->'after');
    END IF;
  END IF;
  list_key := CASE p_operation WHEN 'boards.list' THEN 'boards' WHEN 'posts.search' THEN 'posts'
    WHEN 'knowledge.search' THEN 'entries' WHEN 'drafts.list' THEN 'drafts' WHEN 'tasks.search' THEN 'tasks' ELSE NULL END;
  IF list_key IS NOT NULL THEN
    page_values := result->list_key;
    result := result || jsonb_build_object('nextOffset',CASE WHEN jsonb_array_length(page_values)>take_count AND page_offset+take_count<=10000 THEN page_offset+take_count ELSE NULL END);
    IF jsonb_array_length(page_values)>take_count THEN
      SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]'::jsonb) INTO page_values FROM jsonb_array_elements(page_values) WITH ORDINALITY WHERE ordinality<=take_count;
      result := jsonb_set(result,ARRAY[list_key],page_values,false);
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

CREATE OR REPLACE FUNCTION public.gw_data_connection_admin(p_actor_id uuid,p_action text,p_args jsonb)
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
  desired_all boolean;
  desired_pc text;
  publication jsonb;
  request_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO actor FROM public.gw_users WHERE id=p_actor_id AND status='approved' AND role='executive' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
  IF p_action='create' THEN
    IF NOT coalesce(public.gw_data_keys(p_args,ARRAY['label','token_hash','principal_user_id','scopes','allowed_group_ids','expires_at','max_limit','all_boards','pc_name']),false)
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
    IF p_args ? 'all_boards' AND jsonb_typeof(p_args->'all_boards')<>'boolean' OR p_args ? 'pc_name' AND jsonb_typeof(p_args->'pc_name') NOT IN ('string','null') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
    desired_all := coalesce((p_args->>'all_boards')::boolean,false);
    desired_pc := public.gw_data_registered_pc(p_args->>'pc_name');
    SELECT array_agg(v) INTO scope_values FROM jsonb_array_elements_text(p_args->'scopes') v;
    SELECT coalesce(array_agg(v::uuid),'{}'::uuid[]) INTO board_values FROM jsonb_array_elements_text(p_args->'allowed_group_ids') v;
    IF coalesce(cardinality(scope_values),0) NOT BETWEEN 1 AND 14 OR NOT scope_values<@allowed_ops
      OR cardinality(scope_values)<>(SELECT count(DISTINCT v) FROM unnest(scope_values) v)
      OR cardinality(board_values)>20 OR (NOT desired_all AND cardinality(board_values)<1)
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
        OR c.scopes<>scope_values OR c.allowed_group_ids<>board_values OR c.expires_at<>desired_expiry OR c.max_limit<>desired_limit
        OR c.all_boards<>desired_all OR c.pc_name IS DISTINCT FROM desired_pc THEN
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
    IF NOT desired_all AND board_count<>cardinality(board_values) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
    INSERT INTO public.gw_data_connections(label,token_hash,principal_user_id,scopes,allowed_group_ids,max_limit,expires_at,created_by,all_boards,pc_name)
    VALUES(btrim(p_args->>'label'),p_args->>'token_hash',actor.id,scope_values,board_values,desired_limit,desired_expiry,actor.id,desired_all,desired_pc) RETURNING * INTO c;
    after_value := public.gw_data_connection_view(c);
    response_value := jsonb_build_object('connection',after_value);
  ELSIF p_action='permissions' THEN
    IF NOT coalesce(public.gw_data_keys(p_args,ARRAY['id','scopes','allowed_group_ids','all_boards','pc_name']),false)
      OR jsonb_typeof(p_args->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_args->'scopes') IS DISTINCT FROM 'array'
      OR jsonb_typeof(p_args->'allowed_group_ids') IS DISTINCT FROM 'array'
      OR jsonb_typeof(p_args->'all_boards') IS DISTINCT FROM 'boolean'
      OR (p_args ? 'pc_name' AND jsonb_typeof(p_args->'pc_name') NOT IN ('string','null')) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
    END IF;
    target_id := (p_args->>'id')::uuid;
    SELECT * INTO c FROM public.gw_data_connections WHERE id=target_id AND created_by=actor.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND'; END IF;
    IF c.revoked_at IS NOT NULL OR c.expires_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHORIZED'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_args->'scopes') v WHERE jsonb_typeof(v)<>'string')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_args->'allowed_group_ids') v WHERE jsonb_typeof(v)<>'string') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
    SELECT array_agg(v) INTO scope_values FROM jsonb_array_elements_text(p_args->'scopes') v;
    SELECT coalesce(array_agg(v::uuid),'{}'::uuid[]) INTO board_values FROM jsonb_array_elements_text(p_args->'allowed_group_ids') v;
    desired_all := (p_args->>'all_boards')::boolean;
    desired_pc := CASE WHEN p_args ? 'pc_name' THEN public.gw_data_registered_pc(p_args->>'pc_name') ELSE c.pc_name END;
    IF coalesce(cardinality(scope_values),0) NOT BETWEEN 1 AND 14 OR NOT scope_values<@allowed_ops
      OR cardinality(scope_values)<>(SELECT count(DISTINCT v) FROM unnest(scope_values) v)
      OR cardinality(board_values)>20 OR (NOT desired_all AND cardinality(board_values)<1)
      OR cardinality(board_values)<>(SELECT count(DISTINCT v) FROM unnest(board_values) v) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
    IF NOT desired_all THEN
      board_count := 0;
      FOR member IN SELECT gm.group_id FROM public.gw_group_members gm JOIN public.gw_groups g ON g.id=gm.group_id
        WHERE gm.user_id=c.principal_user_id AND gm.group_id=ANY(board_values) AND g.type='board' ORDER BY gm.group_id FOR SHARE OF gm,g LOOP
        board_count := board_count+1;
      END LOOP;
      IF board_count<>cardinality(board_values) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
    END IF;
    before_value := public.gw_data_connection_view(c);
    UPDATE public.gw_data_connections SET scopes=scope_values,allowed_group_ids=board_values,all_boards=desired_all,pc_name=desired_pc,updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
    after_value := public.gw_data_connection_view(c);
    response_value := jsonb_build_object('connection',after_value);
  ELSIF p_action='list' THEN
    IF NOT coalesce(public.gw_data_keys(p_args,'{}'),false) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
    SELECT jsonb_build_object('connections',coalesce(jsonb_agg(public.gw_data_connection_view(q::public.gw_data_connections)),'[]')) INTO response_value
    FROM (SELECT * FROM public.gw_data_connections WHERE created_by=actor.id ORDER BY created_at DESC,id DESC LIMIT 100) q;
    response_value := response_value || jsonb_build_object('principal',jsonb_build_object('id',actor.id,'name',coalesce(actor.real_name,actor.display_name)),
      'boards',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.name) ORDER BY g.name,g.id),'[]')
        FROM public.gw_groups g JOIN public.gw_group_members gm ON gm.group_id=g.id WHERE gm.user_id=actor.id AND g.type='board'),
      'pcNames',(SELECT coalesce(jsonb_agg(m.pc_name ORDER BY m.pc_name),'[]'::jsonb) FROM public.gw_codex_mtg_machines m WHERE m.revoked_at IS NULL AND m.expires_at>clock_timestamp()));
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
      IF c.all_boards THEN
        PERFORM 1 FROM public.gw_groups g WHERE g.id=d.group_id AND g.type='board' AND NOT g.posting_disabled FOR SHARE OF g;
      ELSE
      PERFORM 1 FROM public.gw_group_members gm JOIN public.gw_groups g ON g.id=gm.group_id
      WHERE gm.user_id=c.principal_user_id AND g.id=d.group_id AND g.id=ANY(c.allowed_group_ids)
        AND g.type='board' AND NOT g.posting_disabled FOR SHARE OF gm,g;
      END IF;
      IF NOT FOUND OR NOT 'posts.publish.commit'=ANY(c.scopes) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
      publication := public.gw_data_publication(c.pc_name,c.principal_user_id,d.content);
      current_diff := jsonb_build_object('before',jsonb_build_object('draft_id',d.id,'post_id',NULL,'status','draft','version',d.version::text),
        'after',jsonb_build_object('draft_id',d.id,'group_id',d.group_id,
          'group_name',(SELECT name FROM public.gw_groups WHERE id=d.group_id),
          'author_id',publication->>'author_id','content',publication->>'content','status','published','version',(d.version+1)::text));
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

REVOKE ALL ON FUNCTION public.gw_data_registered_pc(text),public.gw_data_publication(text,uuid,text),
  public.gw_data_connection_view(public.gw_data_connections),public.gw_data_api_execute(text,text,jsonb,text,text,uuid,uuid),public.gw_data_connection_admin(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gw_data_api_execute(text,text,jsonb,text,text,uuid,uuid),public.gw_data_connection_admin(uuid,text,jsonb) TO service_role;
