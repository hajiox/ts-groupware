-- Work style selector for HR management

ALTER TABLE gw_payroll_employees
  ADD COLUMN IF NOT EXISTS work_style TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'gw_payroll_employees'
      AND constraint_name = 'gw_payroll_employees_work_style_check'
  ) THEN
    ALTER TABLE gw_payroll_employees
      ADD CONSTRAINT gw_payroll_employees_work_style_check
      CHECK (
        work_style IS NULL OR work_style IN (
          'regular_5d_8h',
          'regular_6d_6_5h',
          'part_time_under_29_5h',
          'full_time_part',
          'officer'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gw_payroll_employees_work_style
  ON gw_payroll_employees(work_style);

COMMENT ON COLUMN gw_payroll_employees.work_style IS 'HR work style: regular_5d_8h, regular_6d_6_5h, part_time_under_29_5h, full_time_part, officer.';
