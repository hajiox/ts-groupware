BEGIN;

ALTER TABLE public.gw_codex_mtg_jobs
  ADD COLUMN IF NOT EXISTS result_dm_post_id uuid REFERENCES public.gw_posts(id) ON DELETE SET NULL;

-- Run inside the existing completion transaction. A retry returns the saved
-- receipt and never inserts a second DM; historical completions are not replayed.
CREATE OR REPLACE FUNCTION public.gw_codex_mtg_completion_dm() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  bot_id constant uuid := 'f78baef5-d40c-4886-b51d-a02efbf794fe';
  recipient public.gw_users;
  direct_key text;
  direct_group uuid;
  group_count integer;
  report_body text;
BEGIN
  IF OLD.completion_hash IS NOT NULL OR NEW.completion_hash IS NULL
    OR NEW.origin <> 'human' OR NOT NEW.allow_code_change OR NEW.status <> 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO recipient FROM public.gw_users
    WHERE id=NEW.author_id AND id<>bot_id AND status='approved' AND role IN ('executive','admin') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
  SELECT content INTO report_body FROM public.gw_posts
    WHERE id=NEW.result_post_id AND group_id='a8081dbe-15db-4d41-a18b-b22bb55d2b39' AND user_id=bot_id;
  IF NOT FOUND OR report_body IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFLICT'; END IF;

  direct_key := 'direct:' || least(bot_id::text,recipient.id::text) || ':' || greatest(bot_id::text,recipient.id::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(direct_key,0));
  SELECT count(*) INTO group_count FROM public.gw_groups WHERE type='chat' AND description=direct_key;
  IF group_count>1 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFLICT'; END IF;
  SELECT id INTO direct_group FROM public.gw_groups WHERE type='chat' AND description=direct_key FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.gw_groups(name,description,type,icon,created_by)
      VALUES('TSG君 / ' || coalesce(recipient.real_name,recipient.display_name),direct_key,'chat','💬',bot_id)
      RETURNING id INTO direct_group;
  END IF;
  -- Never deliver a private result into a group containing another person.
  IF EXISTS(SELECT 1 FROM public.gw_group_members WHERE group_id=direct_group AND user_id NOT IN (bot_id,recipient.id)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CONFLICT';
  END IF;
  INSERT INTO public.gw_group_members(group_id,user_id,role)
    VALUES(direct_group,bot_id,'member'),(direct_group,recipient.id,'member') ON CONFLICT DO NOTHING;

  NEW.result_dm_post_id := gen_random_uuid();
  INSERT INTO public.gw_posts(id,group_id,user_id,content,attachments)
    VALUES(NEW.result_dm_post_id,direct_group,bot_id,
      report_body || E'\n\n依頼: ' || left(NEW.content_snapshot,200)
      || E'\n詳細: https://v0-line-blush.vercel.app/chat/a8081dbe-15db-4d41-a18b-b22bb55d2b39','[]');
  UPDATE public.gw_groups SET updated_at=clock_timestamp() WHERE id=direct_group;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.gw_codex_mtg_completion_dm() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS gw_codex_mtg_completion_dm ON public.gw_codex_mtg_jobs;
CREATE TRIGGER gw_codex_mtg_completion_dm BEFORE UPDATE OF completion_hash ON public.gw_codex_mtg_jobs
FOR EACH ROW EXECUTE FUNCTION public.gw_codex_mtg_completion_dm();

COMMIT;
