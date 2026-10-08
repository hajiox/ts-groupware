-- Initial history is context, not a request to repeat old conversations.
BEGIN;
UPDATE public.gw_codex_mtg_peer_jobs q SET may_reply=false
FROM public.gw_codex_mtg_machines m
WHERE q.machine_id=m.id AND m.peer_listener_seen_at IS NULL AND q.status='queued';
CREATE OR REPLACE FUNCTION public.gw_codex_mtg_peer_seed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.gw_posts;
BEGIN
  IF NEW.pc_name='TSA' THEN RETURN NULL; END IF;
  FOR p IN SELECT * FROM public.gw_posts WHERE group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39'
    ORDER BY created_at DESC,id DESC LIMIT 50 LOOP
    PERFORM public.gw_codex_mtg_peer_enqueue(p,NEW.id);
    UPDATE public.gw_codex_mtg_peer_jobs SET may_reply=false WHERE machine_id=NEW.id AND post_id=p.id AND status='queued';
  END LOOP;
  RETURN NULL;
END;
$$;
COMMIT;
