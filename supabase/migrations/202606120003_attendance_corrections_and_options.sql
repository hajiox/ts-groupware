-- Attendance correction and clock-out options

ALTER TABLE gw_attendance_punches
  ADD COLUMN IF NOT EXISTS private_vehicle_distance_km NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS break_override_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS break_override_reason TEXT,
  ADD COLUMN IF NOT EXISTS break_override_requested_by UUID REFERENCES gw_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS break_override_requested_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'gw_attendance_punches'
      AND constraint_name = 'gw_attendance_punches_private_vehicle_distance_check'
  ) THEN
    ALTER TABLE gw_attendance_punches
      ADD CONSTRAINT gw_attendance_punches_private_vehicle_distance_check
      CHECK (private_vehicle_distance_km IS NULL OR private_vehicle_distance_km >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'gw_attendance_punches'
      AND constraint_name = 'gw_attendance_punches_break_override_minutes_check'
  ) THEN
    ALTER TABLE gw_attendance_punches
      ADD CONSTRAINT gw_attendance_punches_break_override_minutes_check
      CHECK (break_override_minutes IS NULL OR break_override_minutes IN (0, 30, 45, 60));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gw_attendance_punches_private_vehicle
  ON gw_attendance_punches(work_date, private_vehicle_distance_km)
  WHERE private_vehicle_distance_km IS NOT NULL;

COMMENT ON COLUMN gw_attendance_punches.private_vehicle_distance_km IS 'Private vehicle distance entered at clock-out or by attendance admin.';
COMMENT ON COLUMN gw_attendance_punches.break_override_minutes IS 'Manual break minutes override requested at clock-out or set by attendance admin. 30 means keep the break at 30 minutes instead of the automatic extra break.';
