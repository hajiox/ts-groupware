-- Exercise the actual batch RPC after the half-day constraint migration.
-- Every changed employee / period below is a new random fixture. The fixture
-- period excludes existing users so its confirmation creates only a fixture
-- alert. No existing user, employee or period is updated. The enclosing
-- transaction rolls back every fixture, exclusion, allocation and audit entry.
BEGIN;
DO $$
DECLARE
  fake_user UUID := gen_random_uuid();
  fake_employee UUID := gen_random_uuid();
  fake_period UUID := gen_random_uuid();
  fake_assignment UUID := gen_random_uuid();
  fake_shift_request UUID := gen_random_uuid();
  fake_lot UUID := gen_random_uuid();
  batch_row JSONB;
  sync_result JSONB;
  saved public.gw_paid_leave_requests;
  invalid_row JSONB;
  allocated NUMERIC;
  sequence_before BIGINT;
  sequence_called_before BOOLEAN;
BEGIN
  SELECT last_value, is_called INTO sequence_before, sequence_called_before
  FROM public.gw_employee_code_seq;
  -- Pending status prevents user approval from linking any existing HR row.
  INSERT INTO public.gw_users (id, line_user_id, display_name, status, department)
  VALUES (fake_user, 'codex-half-leave-rollback-' || fake_user,
    'Half leave rollback fixture ' || fake_user, 'pending', '製造');
  INSERT INTO public.gw_payroll_employees (
    id, user_id, employee_code, display_name, department, work_style, hire_date,
    payroll_status, source_key, raw_payload
  ) VALUES (
    fake_employee, fake_user, 'TEST-' || fake_employee,
    'Half leave rollback fixture ' || fake_user,
    '製造', 'full_time_part', DATE '2098-01-01', 'active',
    'codex-half-leave-rollback:' || fake_employee, '{}'
  );
  INSERT INTO public.gw_shift_periods (
    id, department, title, start_date, end_date, status, is_test_mode, created_by
  ) VALUES (
    fake_period, '製造', 'Half leave rollback fixture ' || fake_period,
    DATE '2099-01-01', DATE '2099-01-15', 'editing', false, fake_user
  );
  INSERT INTO public.gw_shift_assignments (
    id, period_id, user_id, employee_id, work_date, shift_label,
    start_time, end_time, break_minutes, work_minutes, created_by, updated_by
  ) VALUES (
    fake_assignment, fake_period, fake_user, fake_employee,
    DATE '2099-01-02', '8:30-12:30', TIME '08:30', TIME '12:30', 0, 240,
    fake_user, fake_user
  );
  INSERT INTO public.gw_shift_requests (
    id, period_id, user_id, employee_id, work_date, request_type, status, is_test
  ) VALUES (
    fake_shift_request, fake_period, fake_user, fake_employee,
    DATE '2099-01-02', 'paid_leave_half', 'submitted', false
  );
  INSERT INTO public.gw_paid_leave_grant_lots (
    id, employee_id, user_id, grant_date, expires_on, granted_days,
    grant_source, grant_status, source_key, created_by
  ) VALUES (
    fake_lot, fake_employee, fake_user, DATE '2098-01-01', DATE '2100-01-01',
    10, 'manual_adjustment', 'granted',
    'codex-half-leave-rollback:' || fake_lot, fake_user
  );
  -- Link only the fixture's existing employee when activating this fake user.
  UPDATE public.gw_users SET status = 'approved' WHERE id = fake_user;
  -- Confirmation normally alerts all department members, so isolate this
  -- freshly created period from every existing user, including administrators.
  INSERT INTO public.gw_shift_period_exclusions (period_id, user_id)
  SELECT fake_period, id FROM public.gw_users WHERE id <> fake_user;

  batch_row := jsonb_build_object(
    'shift_request_id', fake_shift_request,
    'employee_id', fake_employee,
    'user_id', fake_user,
    'work_date', '2099-01-02',
    'leave_unit', 'half_day',
    'shift_assignment_id', fake_assignment,
    'start_time', '08:30',
    'end_time', '12:30',
    'break_minutes', 0,
    'scheduled_minutes_snapshot', 240,
    'hourly_rate_snapshot', 1200,
    'payable_minutes_snapshot', 251,
    'paid_wage_amount', 5010,
    'raw_payload', jsonb_build_object(
      'wage_basis', 'three_month_average_hours', 'included_in_monthly_salary', false
    ),
    'employee_memo', 'Synthetic regression fixture',
    'source_key', 'shift:' || fake_period || ':' || fake_user || ':2099-01-02'
  );
  sync_result := public.gw_sync_shift_paid_leave_batch(
    fake_period, jsonb_build_array(batch_row), fake_user
  );
  SELECT * INTO saved FROM public.gw_paid_leave_requests
  WHERE source_key = batch_row ->> 'source_key';
  SELECT coalesce(sum(allocated_days), 0) INTO allocated
  FROM public.gw_paid_leave_consumption_allocations
  WHERE request_id = saved.id AND voided_at IS NULL;
  IF (sync_result ->> 'synced')::INTEGER <> 1
    OR saved.request_status <> 'approved'
    OR saved.requested_days <> 0.5
    OR saved.scheduled_minutes_snapshot <> 240
    OR saved.payable_minutes_snapshot <> 251
    OR saved.paid_wage_amount <> 5010
    OR saved.shift_assignment_id <> fake_assignment
    OR allocated <> 0.5
    OR (SELECT status FROM public.gw_shift_requests WHERE id = fake_shift_request) <> 'accepted'
    OR (SELECT work_minutes FROM public.gw_shift_assignments WHERE id = fake_assignment) <> 240
    OR (SELECT count(*) FROM public.gw_shift_confirmation_alerts WHERE period_id = fake_period) <> 1 THEN
    RAISE EXCEPTION 'Actual half-day batch / approval / assignment regression failed';
  END IF;

  IF (SELECT status FROM public.gw_shift_periods WHERE id = fake_period) <> 'confirmed'
    OR (SELECT confirmed_at FROM public.gw_shift_periods WHERE id = fake_period) IS NULL
    OR (SELECT count(*) FROM public.gw_shift_confirmation_alerts WHERE period_id = fake_period) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.gw_shift_confirmation_alerts
      WHERE period_id = fake_period AND user_id = fake_user) THEN
    RAISE EXCEPTION 'Fixture confirmation state / isolated notification failed';
  END IF;

  -- The stable source key must update the same request, never consume twice.
  sync_result := public.gw_sync_shift_paid_leave_batch(
    fake_period, jsonb_build_array(batch_row), fake_user
  );
  IF (SELECT count(*) FROM public.gw_paid_leave_requests
      WHERE source_key = batch_row ->> 'source_key') <> 1
    OR (SELECT coalesce(sum(allocated_days), 0)
      FROM public.gw_paid_leave_consumption_allocations
      WHERE grant_lot_id = fake_lot AND voided_at IS NULL) <> 0.5 THEN
    RAISE EXCEPTION 'Repeated half-day batch duplicated the request / consumption';
  END IF;

  invalid_row := jsonb_set(batch_row, '{raw_payload,wage_basis}', '"confirmed_shift"');
  BEGIN
    PERFORM public.gw_sync_shift_paid_leave_batch(
      fake_period, jsonb_build_array(invalid_row), fake_user
    );
    RAISE EXCEPTION 'Actual batch accepted an invalid nonaverage half-day snapshot';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT request_status FROM public.gw_paid_leave_requests WHERE id = saved.id) <> 'approved'
    OR (SELECT coalesce(sum(allocated_days), 0)
      FROM public.gw_paid_leave_consumption_allocations
      WHERE grant_lot_id = fake_lot AND voided_at IS NULL) <> 0.5 THEN
    RAISE EXCEPTION 'Rejected batch changed the previously approved request / consumption';
  END IF;

  UPDATE public.gw_shift_periods SET is_test_mode = true WHERE id = fake_period;
  sync_result := public.gw_sync_shift_paid_leave_batch(
    fake_period, jsonb_build_array(batch_row), fake_user
  );
  IF (sync_result ->> 'synced')::INTEGER <> 0
    OR NOT (sync_result ->> 'skipped_test_mode')::BOOLEAN
    OR (SELECT coalesce(sum(allocated_days), 0)
      FROM public.gw_paid_leave_consumption_allocations
      WHERE grant_lot_id = fake_lot AND voided_at IS NULL) <> 0.5 THEN
    RAISE EXCEPTION 'Test-mode batch changed approved half-day consumption';
  END IF;
  IF (SELECT last_value FROM public.gw_employee_code_seq) <> sequence_before
    OR (SELECT is_called FROM public.gw_employee_code_seq) <> sequence_called_before THEN
    RAISE EXCEPTION 'Fixture changed the nontransactional employee-number sequence';
  END IF;
END;
$$;
ROLLBACK;
SELECT 'Actual half-day batch: approved 0.5 day, preserved 240 working minutes / 5010 wage, confirmed fixture with one isolated alert, repeat safety, rejection rollback and test-mode skip passed; fixtures rolled back' AS result;
