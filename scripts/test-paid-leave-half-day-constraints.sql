-- Run after the half-day ordinary-wage constraint migration.
-- Copy only structure / checks to a temporary table: no real staff, requests,
-- approval RPCs, triggers, balances, period status, or notifications are touched.
BEGIN;
CREATE TEMP TABLE paid_leave_constraint_regression (
  LIKE public.gw_paid_leave_requests
    INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS
) ON COMMIT DROP;

DO $$
DECLARE
  fake_employee UUID := gen_random_uuid();
  rejected_constraint TEXT;
  sample RECORD;
BEGIN
  INSERT INTO paid_leave_constraint_regression (
    employee_id, leave_date, leave_unit, scheduled_minutes_snapshot,
    payable_minutes_snapshot, paid_wage_amount, wage_method, raw_payload
  ) VALUES
    (fake_employee, DATE '2099-01-01', 'half_day', 240, 251, 5010,
      'ordinary_wage', '{"wage_basis":"three_month_average_hours"}'),
    (fake_employee, DATE '2099-01-02', 'half_day', 240, 250, 5000,
      'ordinary_wage', '{"wage_basis":"three_month_average_hours"}'),
    (fake_employee, DATE '2099-01-03', 'half_day', 480, 240, 4800,
      'ordinary_wage', '{"wage_basis":"confirmed_shift"}'),
    (fake_employee, DATE '2099-01-04', 'full_day', 240, 501, 10020,
      'ordinary_wage', '{"wage_basis":"confirmed_shift"}');

  IF (SELECT count(*) FROM paid_leave_constraint_regression) <> 4
    OR (SELECT requested_days FROM paid_leave_constraint_regression
      WHERE leave_date = DATE '2099-01-01') <> 0.5 THEN
    RAISE EXCEPTION 'Valid ordinary-wage snapshots / half-day units failed';
  END IF;

  FOR sample IN SELECT * FROM (VALUES
    ('ordinary_wage'::TEXT, '{"wage_basis":"confirmed_shift"}'::JSONB),
    ('ordinary_wage'::TEXT, '{}'::JSONB),
    ('ordinary_wage'::TEXT, '{"wage_basis":null}'::JSONB),
    ('average_wage'::TEXT, '{"wage_basis":"three_month_average_hours"}'::JSONB),
    ('standard_monthly_remuneration'::TEXT, '{"wage_basis":"three_month_average_hours"}'::JSONB)
  ) AS cases(method, payload) LOOP
    BEGIN
      INSERT INTO paid_leave_constraint_regression (
        employee_id, leave_date, leave_unit, scheduled_minutes_snapshot,
        payable_minutes_snapshot, paid_wage_amount, wage_method, raw_payload
      ) VALUES (fake_employee, DATE '2099-01-10', 'half_day', 240, 251, 5010,
        sample.method, sample.payload);
      RAISE EXCEPTION 'Unrelated / absent wage basis bypassed the half-day constraint';
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejected_constraint = CONSTRAINT_NAME;
      IF rejected_constraint <> 'gw_paid_leave_requests_half_day_check' THEN
        RAISE EXCEPTION 'Expected half-day check, received %', rejected_constraint;
      END IF;
    END;
  END LOOP;

  FOR sample IN SELECT * FROM (VALUES
    (-1, 251, 5010, 'half_day'::TEXT),
    (240, -1, 5010, 'half_day'::TEXT),
    (240, 251, -1, 'half_day'::TEXT),
    (240, 251, 5010, 'invalid_unit'::TEXT)
  ) AS cases(scheduled, payable, amount, unit) LOOP
    BEGIN
      INSERT INTO paid_leave_constraint_regression (
        employee_id, leave_date, leave_unit, scheduled_minutes_snapshot,
        payable_minutes_snapshot, paid_wage_amount, wage_method, raw_payload
      ) VALUES (fake_employee, DATE '2099-01-11', sample.unit,
        sample.scheduled, sample.payable, sample.amount,
        'ordinary_wage', '{"wage_basis":"three_month_average_hours"}');
      RAISE EXCEPTION 'Average-wage exemption bypassed nonnegative / leave-unit validation';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
END;
$$;
ROLLBACK;
SELECT 'Half-day constraints: average-only exemption, NULL guard, ordinary-wage scope and nonnegative checks passed; rolled back' AS result;
