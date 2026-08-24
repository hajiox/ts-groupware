-- Effective 2026-08-11, move Kojima's standard manufacturing shift one hour earlier.
-- Existing day-off, requested leave, company-off and manually assigned alternate times are untouched.
WITH target_employee AS (
  SELECT id, user_id
  FROM public.gw_payroll_employees
  WHERE employee_code = '142'
  LIMIT 1
)
UPDATE public.gw_payroll_employees AS employee
SET raw_payload = jsonb_set(
  COALESCE(employee.raw_payload, '{}'::jsonb),
  '{hr_profile}',
  COALESCE(employee.raw_payload -> 'hr_profile', '{}'::jsonb) || jsonb_build_object(
    'basic_work_start', '11:30',
    'basic_work_end', '16:30',
    'basic_break_minutes', 0,
    'basic_work_effective_from', '2026-08-11'
  ),
  true
),
updated_at = now()
FROM target_employee
WHERE employee.id = target_employee.id
  AND COALESCE(employee.raw_payload -> 'hr_profile' ->> 'basic_work_start', '') IN ('12:30', '11:30')
  AND COALESCE(employee.raw_payload -> 'hr_profile' ->> 'basic_work_end', '') IN ('17:30', '16:30');

WITH target_employee AS (
  SELECT user_id
  FROM public.gw_payroll_employees
  WHERE employee_code = '142'
  LIMIT 1
)
UPDATE public.gw_shift_assignments AS assignment
SET pattern_id = NULL,
    shift_label = '11:30-16:30',
    start_time = '11:30',
    end_time = '16:30',
    break_minutes = 0,
    work_minutes = 300,
    source = 'manual',
    updated_at = now()
FROM target_employee
WHERE assignment.user_id = target_employee.user_id
  AND assignment.work_date >= DATE '2026-08-11'
  AND assignment.assignment_type = 'staff'
  AND assignment.start_time = TIME '12:30'
  AND assignment.end_time = TIME '17:30'
  AND assignment.break_minutes = 0;
