-- Business handlers retain their existing authorization and validation. An
-- explicit grant is separate from the original fourteen board-data scopes.
ALTER TABLE public.gw_data_connections ADD COLUMN IF NOT EXISTS business_access boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.gw_data_business_requests (
  connection_id uuid NOT NULL REFERENCES public.gw_data_connections(id),
  key text NOT NULL CHECK(key ~ '^[A-Za-z0-9:_-]{8,128}$'),
  operation_id text NOT NULL CHECK(char_length(operation_id) BETWEEN 1 AND 120),
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed')),
  response jsonb,
  response_status integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(connection_id,key),
  UNIQUE(connection_id,request_id),
  CHECK ((state='pending' AND response IS NULL AND response_status IS NULL AND completed_at IS NULL)
    OR (state='completed' AND response IS NOT NULL AND response_status IS NOT NULL AND response_status BETWEEN 200 AND 499 AND completed_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS public.gw_data_business_uploads (
  connection_id uuid NOT NULL REFERENCES public.gw_data_connections(id),
  drive_id text NOT NULL CHECK(drive_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id,drive_id)
);
ALTER TABLE public.gw_data_business_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gw_data_business_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gw_data_business_requests,public.gw_data_business_uploads FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.gw_data_business_requests,public.gw_data_business_uploads TO service_role;

CREATE OR REPLACE FUNCTION public.gw_data_connection_view(c public.gw_data_connections) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('id',c.id,'label',c.label,'principal_user_id',c.principal_user_id,
    'scopes',c.scopes,'allowed_group_ids',c.allowed_group_ids,'max_limit',c.max_limit,
    'expires_at',c.expires_at,'revoked_at',c.revoked_at,'created_at',c.created_at,
    'all_boards',c.all_boards,'pc_name',c.pc_name,'business_access',c.business_access);
$$;

CREATE OR REPLACE FUNCTION public.gw_business_api_connection(p_token_hash text)
RETURNS public.gw_data_connections LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.gw_data_connections; u public.gw_users;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION USING MESSAGE='UNAUTHORIZED'; END IF;
  SELECT * INTO c FROM public.gw_data_connections WHERE token_hash=p_token_hash FOR SHARE;
  IF NOT FOUND OR c.revoked_at IS NOT NULL OR c.expires_at<=clock_timestamp() THEN RAISE EXCEPTION USING MESSAGE='UNAUTHORIZED'; END IF;
  SELECT * INTO u FROM public.gw_users WHERE id=c.principal_user_id FOR SHARE;
  IF NOT FOUND OR u.status IS DISTINCT FROM 'approved' OR u.role IS DISTINCT FROM 'executive' THEN RAISE EXCEPTION USING MESSAGE='UNAUTHORIZED'; END IF;
  IF NOT c.business_access OR c.pc_name IS NULL THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
  PERFORM public.gw_data_registered_pc(c.pc_name);
  RETURN c;
END;
$$;

CREATE OR REPLACE FUNCTION public.gw_business_api_authenticate(p_token_hash text,p_operation_id text DEFAULT NULL,p_request_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.gw_data_connections;
BEGIN
  c := public.gw_business_api_connection(p_token_hash);
  IF p_operation_id IS NOT NULL AND p_request_id IS NOT NULL THEN
    INSERT INTO public.gw_data_audit(connection_id,request_id,operation,actor_user_id,after_data)
      VALUES(c.id,p_request_id,'business.authenticate',c.principal_user_id,jsonb_build_object('operation_id',left(p_operation_id,120)));
  END IF;
  RETURN jsonb_build_object('connectionId',c.id,'principalUserId',c.principal_user_id,'pcName',c.pc_name);
END;
$$;

CREATE OR REPLACE FUNCTION public.gw_business_api_begin(
  p_token_hash text,p_operation_id text,p_request_hash text,p_idempotency_key text,p_request_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.gw_data_connections; existing public.gw_data_business_requests; inserted integer;
BEGIN
  c := public.gw_business_api_connection(p_token_hash);
  IF p_operation_id IS NULL OR char_length(p_operation_id) NOT BETWEEN 1 AND 120
    OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
    OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9:_-]{8,128}$' OR p_request_id IS NULL THEN
    RAISE EXCEPTION USING MESSAGE='VALIDATION';
  END IF;
  INSERT INTO public.gw_data_business_requests(connection_id,key,operation_id,request_hash,request_id)
    VALUES(c.id,p_idempotency_key,p_operation_id,p_request_hash,p_request_id) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  SELECT * INTO existing FROM public.gw_data_business_requests WHERE connection_id=c.id AND key=p_idempotency_key FOR UPDATE;
  IF existing.request_hash<>p_request_hash OR existing.operation_id<>p_operation_id THEN RAISE EXCEPTION USING MESSAGE='IDEMPOTENCY_CONFLICT'; END IF;
  INSERT INTO public.gw_data_audit(connection_id,request_id,operation,actor_user_id,after_data)
    VALUES(c.id,p_request_id,'business.write',c.principal_user_id,
      jsonb_build_object('operation_id',p_operation_id,'state',CASE WHEN inserted=1 THEN 'started' ELSE existing.state END,'replayed',inserted=0));
  IF inserted=1 THEN RETURN jsonb_build_object('state','started'); END IF;
  IF existing.state='completed' THEN RETURN jsonb_build_object('state','completed','status',existing.response_status,'response',existing.response); END IF;
  -- A crash may follow a successful external or database effect. Never expire
  -- or automatically release this reservation and repeat the mutation.
  RETURN jsonb_build_object('state','pending');
END;
$$;

CREATE OR REPLACE FUNCTION public.gw_business_api_finish(
  p_token_hash text,p_request_id uuid,p_request_hash text,p_response jsonb,p_status integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.gw_data_connections; existing public.gw_data_business_requests;
BEGIN
  c := public.gw_business_api_connection(p_token_hash);
  SELECT * INTO existing FROM public.gw_data_business_requests
    WHERE connection_id=c.id AND request_id=p_request_id FOR UPDATE;
  IF NOT FOUND OR existing.request_hash IS DISTINCT FROM p_request_hash OR existing.state<>'pending'
    OR p_response IS NULL OR p_status IS NULL OR p_status NOT BETWEEN 200 AND 499 OR octet_length(p_response::text)>10485760 THEN
    RAISE EXCEPTION USING MESSAGE='CONFLICT';
  END IF;
  UPDATE public.gw_data_business_requests SET state='completed',response=p_response,response_status=p_status,completed_at=clock_timestamp()
    WHERE connection_id=c.id AND key=existing.key;
  INSERT INTO public.gw_data_audit(connection_id,request_id,operation,actor_user_id,after_data)
    VALUES(c.id,p_request_id,'business.write',c.principal_user_id,
      jsonb_build_object('operation_id',existing.operation_id,'state','completed','status',p_status));
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.gw_data_connection_business_access(p_actor_id uuid,p_connection_id uuid,p_enabled boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.gw_users; c public.gw_data_connections;
BEGIN
  SELECT * INTO actor FROM public.gw_users WHERE id=p_actor_id FOR SHARE;
  IF NOT FOUND OR actor.status IS DISTINCT FROM 'approved' OR actor.role IS DISTINCT FROM 'executive' THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
  SELECT * INTO c FROM public.gw_data_connections WHERE id=p_connection_id AND created_by=actor.id FOR UPDATE;
  IF NOT FOUND OR p_enabled IS NULL THEN RAISE EXCEPTION USING MESSAGE='NOT_FOUND'; END IF;
  IF p_enabled THEN
    IF c.revoked_at IS NOT NULL OR c.expires_at<=clock_timestamp() OR c.pc_name IS NULL THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
    PERFORM public.gw_data_registered_pc(c.pc_name);
    PERFORM 1 FROM public.gw_users WHERE id=c.principal_user_id AND status='approved' AND role='executive' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='FORBIDDEN'; END IF;
  END IF;
  UPDATE public.gw_data_connections SET business_access=p_enabled,updated_at=clock_timestamp() WHERE id=c.id RETURNING * INTO c;
  INSERT INTO public.gw_data_audit(connection_id,request_id,operation,actor_user_id,after_data)
    VALUES(c.id,gen_random_uuid(),'connection.business_access',actor.id,jsonb_build_object('business_access',p_enabled,'pc_name',c.pc_name));
  RETURN jsonb_build_object('ok',true,'data',jsonb_build_object('connection',public.gw_data_connection_view(c)));
END;
$$;

CREATE OR REPLACE FUNCTION public.gw_data_connection_business_admin(p_actor_id uuid,p_action text,p_args jsonb,p_business_access boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; c public.gw_data_connections;
BEGIN
  IF p_action NOT IN ('create','permissions') THEN RAISE EXCEPTION USING MESSAGE='VALIDATION'; END IF;
  result := public.gw_data_connection_admin(p_actor_id,p_action,p_args);
  SELECT * INTO c FROM public.gw_data_connections WHERE id=(result->'data'->'connection'->>'id')::uuid;
  -- Null preserves existing access on ordinary legacy permission edits.
  IF p_business_access IS NOT NULL THEN
    result := public.gw_data_connection_business_access(p_actor_id,c.id,p_business_access);
  ELSIF c.business_access THEN
    -- Changing a registered PC cannot leave an invalid active business grant.
    PERFORM public.gw_business_api_connection(c.token_hash);
  END IF;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.gw_business_api_connection(text),public.gw_business_api_authenticate(text,text,uuid),
  public.gw_business_api_begin(text,text,text,text,uuid),public.gw_business_api_finish(text,uuid,text,jsonb,integer),
  public.gw_data_connection_business_access(uuid,uuid,boolean),public.gw_data_connection_business_admin(uuid,text,jsonb,boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gw_business_api_authenticate(text,text,uuid),
  public.gw_business_api_begin(text,text,text,text,uuid),public.gw_business_api_finish(text,uuid,text,jsonb,integer),
  public.gw_data_connection_business_access(uuid,uuid,boolean),public.gw_data_connection_business_admin(uuid,text,jsonb,boolean)
  TO service_role;
