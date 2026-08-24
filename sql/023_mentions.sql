-- Mention history for Tasks page.
CREATE TABLE IF NOT EXISTS gw_mentions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mentioned_user_id UUID NOT NULL REFERENCES gw_users(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  sender_name TEXT NOT NULL,
  group_id UUID REFERENCES gw_groups(id) ON DELETE CASCADE,
  group_name TEXT,
  post_id UUID NOT NULL REFERENCES gw_posts(id) ON DELETE CASCADE,
  target_post_id UUID REFERENCES gw_posts(id) ON DELETE CASCADE,
  context_type TEXT NOT NULL DEFAULT 'board' CHECK (context_type IN ('board', 'chat', 'dm')),
  context_label TEXT NOT NULL DEFAULT '掲示板',
  content_snippet TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mentioned_user_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_gw_mentions_user_created
  ON gw_mentions(mentioned_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gw_mentions_post
  ON gw_mentions(post_id);

ALTER TABLE gw_mentions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'gw_mentions'
      AND policyname = 'gw_mentions_select_all'
  ) THEN
    CREATE POLICY "gw_mentions_select_all" ON gw_mentions FOR SELECT USING (true);
  END IF;
END $$;

GRANT ALL PRIVILEGES ON TABLE gw_mentions TO service_role;
GRANT SELECT ON TABLE gw_mentions TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
