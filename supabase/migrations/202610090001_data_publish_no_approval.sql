-- User-requested publication needs no second human approval. Preserve exact preview, current permissions and idempotency.
-- Existing pending/approved previews remain valid; never fabricate approval history.
CREATE OR REPLACE FUNCTION public.gw_data_confirmation_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (NEW.id,NEW.connection_id,NEW.draft_id,NEW.draft_version,NEW.diff,NEW.digest,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.connection_id,OLD.draft_id,OLD.draft_version,OLD.diff,OLD.digest,OLD.expires_at,OLD.created_at)
    OR NOT ((OLD.status='pending' AND NEW.status='approved')
      OR (OLD.status IN ('pending','approved') AND NEW.status='committed')) THEN
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

