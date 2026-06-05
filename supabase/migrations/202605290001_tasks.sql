-- Task requests linked to board posts.
CREATE TABLE IF NOT EXISTS gw_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES gw_posts(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES gw_groups(id) ON DELETE CASCADE,
  requester_id UUID NOT NULL REFERENCES gw_users(id) ON DELETE CASCADE,
  assignee_id UUID NOT NULL REFERENCES gw_users(id) ON DELETE CASCADE,
  due_date DATE NOT NULL,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(post_id, assignee_id)
);

CREATE INDEX IF NOT EXISTS idx_gw_tasks_assignee_open
  ON gw_tasks(assignee_id, due_date)
  WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_gw_tasks_post_id ON gw_tasks(post_id);
CREATE INDEX IF NOT EXISTS idx_gw_tasks_group_id ON gw_tasks(group_id);

ALTER TABLE gw_tasks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'gw_tasks'
      AND policyname = 'gw_tasks_select_all'
  ) THEN
    CREATE POLICY "gw_tasks_select_all" ON gw_tasks FOR SELECT USING (true);
  END IF;
END $$;

GRANT ALL PRIVILEGES ON TABLE gw_tasks TO service_role;
GRANT SELECT ON TABLE gw_tasks TO anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'gw_tasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE gw_tasks;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
