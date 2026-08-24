-- Payroll calculation profiles inferred from labor-office payroll history.
-- These profiles drive future in-house payroll calculations while keeping
-- imported historical payroll results immutable.

CREATE TABLE IF NOT EXISTS gw_payroll_calculation_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES gw_payroll_employees(id) ON DELETE CASCADE,
  effective_from DATE NOT NULL,
  effective_to DATE,
  calculation_type TEXT NOT NULL
    CHECK (calculation_type IN ('hourly', 'monthly_fixed', 'monthly_with_overtime', 'officer_fixed', 'unknown')),
  monthly_base_amount NUMERIC(12,2),
  hourly_rate NUMERIC(12,2),
  overtime_divisor NUMERIC(8,2),
  weekday_saturday_overtime_multiplier NUMERIC(5,2) NOT NULL DEFAULT 1.25,
  sunday_overtime_multiplier NUMERIC(5,2) NOT NULL DEFAULT 1.35,
  scheduled_minutes INTEGER,
  public_holidays_per_month NUMERIC(5,2),
  paid_leave_mode TEXT,
  taxable_additions JSONB NOT NULL DEFAULT '{}'::jsonb,
  deduction_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  verification JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_gw_payroll_calculation_profiles_employee
  ON gw_payroll_calculation_profiles(employee_id, effective_from DESC);

CREATE INDEX IF NOT EXISTS idx_gw_payroll_calculation_profiles_active
  ON gw_payroll_calculation_profiles(employee_id)
  WHERE effective_to IS NULL;
