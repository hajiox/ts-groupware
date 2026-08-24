-- Shared calendar events for TS Groupware.
CREATE TABLE IF NOT EXISTS gw_calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  all_day BOOLEAN NOT NULL DEFAULT false,
  color TEXT NOT NULL DEFAULT '#1a73e8',
  source TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT,
  source_updated_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES gw_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT gw_calendar_events_time_check CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_gw_calendar_events_range
  ON gw_calendar_events(starts_at, ends_at);

CREATE INDEX IF NOT EXISTS idx_gw_calendar_events_created_by
  ON gw_calendar_events(created_by);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gw_calendar_events_source_external
  ON gw_calendar_events(source, external_id);

ALTER TABLE gw_calendar_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'gw_calendar_events'
      AND policyname = 'gw_calendar_events_select_all'
  ) THEN
    CREATE POLICY "gw_calendar_events_select_all" ON gw_calendar_events FOR SELECT USING (true);
  END IF;
END $$;

GRANT ALL PRIVILEGES ON TABLE gw_calendar_events TO service_role;
GRANT SELECT ON TABLE gw_calendar_events TO anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'gw_calendar_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE gw_calendar_events;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
