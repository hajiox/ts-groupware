ALTER TABLE gw_labor_import_batches
  ADD COLUMN IF NOT EXISTS payroll_kind TEXT NOT NULL DEFAULT 'monthly';

DO $$
BEGIN
  ALTER TABLE gw_labor_import_batches
    ADD CONSTRAINT gw_labor_import_batches_payroll_kind_check
    CHECK (payroll_kind IN ('monthly', 'bonus', 'adjustment'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE gw_payroll_periods
  ADD COLUMN IF NOT EXISTS payroll_kind TEXT NOT NULL DEFAULT 'monthly';

DO $$
BEGIN
  ALTER TABLE gw_payroll_periods
    ADD CONSTRAINT gw_payroll_periods_payroll_kind_check
    CHECK (payroll_kind IN ('monthly', 'bonus', 'adjustment'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE gw_payroll_periods
  DROP CONSTRAINT IF EXISTS gw_payroll_periods_payroll_month_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gw_payroll_periods_month_kind_unique
  ON gw_payroll_periods(payroll_month, payroll_kind);

CREATE INDEX IF NOT EXISTS idx_gw_labor_import_batches_month_kind
  ON gw_labor_import_batches(target_payroll_month, payroll_kind);

NOTIFY pgrst, 'reload schema';
