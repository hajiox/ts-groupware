-- TSG attendance terminal devices
-- 本社・道の駅などの専用端末から、従業員名ボタンで出勤/退勤するための拡張。

CREATE TABLE IF NOT EXISTS gw_attendance_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  location TEXT NOT NULL,
  device_key UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE gw_attendance_devices ENABLE ROW LEVEL SECURITY;
GRANT ALL PRIVILEGES ON TABLE gw_attendance_devices TO service_role;

INSERT INTO gw_attendance_devices (code, name, location, sort_order)
VALUES
  ('hq', '本社タイムレコーダー', '本社', 10),
  ('michinoeki', '道の駅タイムレコーダー', '道の駅', 20)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE gw_attendance_punches
  ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES gw_attendance_devices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'terminal',
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_voided BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gw_attendance_punches_source_type_check'
  ) THEN
    ALTER TABLE gw_attendance_punches
      ADD CONSTRAINT gw_attendance_punches_source_type_check
      CHECK (source_type IN ('terminal', 'self', 'admin', 'import'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gw_attendance_devices_active
  ON gw_attendance_devices(is_active, sort_order);

CREATE INDEX IF NOT EXISTS idx_gw_attendance_punches_device_date
  ON gw_attendance_punches(device_id, work_date, punched_at);

CREATE INDEX IF NOT EXISTS idx_gw_attendance_punches_voided
  ON gw_attendance_punches(is_voided, work_date);

COMMENT ON TABLE gw_attendance_devices IS 'TSG fixed attendance terminal devices.';
COMMENT ON COLUMN gw_attendance_devices.device_key IS 'Secret-ish public terminal URL key.';
COMMENT ON COLUMN gw_attendance_punches.is_voided IS 'Voided punches are kept for audit and ignored in attendance state.';
