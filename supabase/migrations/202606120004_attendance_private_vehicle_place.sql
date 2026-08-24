-- Private vehicle place for attendance clock-out records

ALTER TABLE gw_attendance_punches
  ADD COLUMN IF NOT EXISTS private_vehicle_place TEXT;

CREATE INDEX IF NOT EXISTS idx_gw_attendance_punches_private_vehicle_place
  ON gw_attendance_punches(work_date, private_vehicle_place)
  WHERE private_vehicle_place IS NOT NULL AND private_vehicle_place <> '';

COMMENT ON COLUMN gw_attendance_punches.private_vehicle_place IS 'Private vehicle destination/place entered at clock-out or by attendance admin.';
