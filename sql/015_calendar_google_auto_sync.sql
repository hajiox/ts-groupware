-- Google Calendar auto sync status for TS Groupware calendar.
CREATE TABLE IF NOT EXISTS gw_calendar_sync_status (
  sync_key TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  range_start TIMESTAMPTZ NOT NULL,
  range_end TIMESTAMPTZ NOT NULL,
  last_attempted_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  last_imported INTEGER NOT NULL DEFAULT 0,
  last_deleted INTEGER NOT NULL DEFAULT 0,
  last_colored INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gw_calendar_sync_status_calendar
  ON gw_calendar_sync_status(calendar_id, range_start, range_end);

CREATE INDEX IF NOT EXISTS idx_gw_calendar_sync_status_synced
  ON gw_calendar_sync_status(last_synced_at);

ALTER TABLE gw_calendar_sync_status ENABLE ROW LEVEL SECURITY;

GRANT ALL PRIVILEGES ON TABLE gw_calendar_sync_status TO service_role;

NOTIFY pgrst, 'reload schema';
