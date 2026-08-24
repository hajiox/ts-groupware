-- Align attendance rounding with historical labor-office payroll data.
-- Past timecard summaries from 2025-08 through 2026-06 use 15-minute units.

ALTER TABLE gw_attendance_periods
  ALTER COLUMN rounding_unit_minutes SET DEFAULT 15;

ALTER TABLE gw_attendance_rounding_rules
  ALTER COLUMN rounding_unit_minutes SET DEFAULT 15;

INSERT INTO gw_attendance_rounding_rules (
  rule_set,
  name,
  rounding_unit_minutes,
  clock_in_method,
  clock_out_method,
  total_minutes_method,
  effective_from,
  effective_to
)
VALUES ('default', '15分丸め', 15, 'nearest', 'nearest', 'nearest', '1900-01-01', NULL)
ON CONFLICT (rule_set, effective_from) DO UPDATE SET
  name = EXCLUDED.name,
  rounding_unit_minutes = EXCLUDED.rounding_unit_minutes,
  clock_in_method = EXCLUDED.clock_in_method,
  clock_out_method = EXCLUDED.clock_out_method,
  total_minutes_method = EXCLUDED.total_minutes_method,
  effective_to = NULL;

UPDATE gw_attendance_periods
SET rounding_unit_minutes = 15,
    updated_at = now()
WHERE rounding_unit_minutes <> 15;

COMMENT ON COLUMN gw_attendance_periods.rounding_unit_minutes IS 'Attendance rounding unit in minutes. Historical labor-office data confirms 15-minute units.';
COMMENT ON COLUMN gw_attendance_rounding_rules.rounding_unit_minutes IS 'Attendance rounding unit in minutes. Historical labor-office data confirms 15-minute units.';
