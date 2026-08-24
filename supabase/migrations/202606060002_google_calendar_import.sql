-- Google Calendar import metadata for TS Groupware calendar events.
ALTER TABLE gw_calendar_events
  ADD COLUMN IF NOT EXISTS external_id TEXT;

ALTER TABLE gw_calendar_events
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gw_calendar_events_source_external
  ON gw_calendar_events(source, external_id);

NOTIFY pgrst, 'reload schema';
