-- Merge the provisional Sugayama employee into the approved LINE account.
-- Keep employee No.149 and all provisional shift data; discard only the
-- automatically-created duplicate employee No.150 after references move.

DO $$
DECLARE
  primary_employee_id uuid := '6bfd32b0-e6b9-4190-8e00-e3fb2d278c5d';
  duplicate_employee_id uuid := 'd21ba96c-132e-41f3-b16c-7ba22abb40d2';
  provisional_user_id uuid := '545433d9-e740-41d8-9007-1ca6731b9d30';
  approved_user_id uuid := 'a23dec75-d9e6-4cf2-bdd2-2fde8a7cb758';
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.gw_payroll_employees
    WHERE id = primary_employee_id
      AND employee_code = '149'
      AND REGEXP_REPLACE(COALESCE(real_name, display_name, ''), '[[:space:]　]', '', 'g') = '菅山紗来'
  ) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.gw_users
    WHERE id = approved_user_id
      AND status = 'approved'
      AND REGEXP_REPLACE(COALESCE(real_name, display_name, ''), '[[:space:]　]', '', 'g') = '菅山紗来'
  ) THEN
    RAISE EXCEPTION 'Approved Sugayama LINE account was not found';
  END IF;

  UPDATE public.gw_attendance_punches
  SET employee_id = primary_employee_id
  WHERE employee_id = duplicate_employee_id;

  UPDATE public.gw_attendance_corrections
  SET employee_id = primary_employee_id
  WHERE employee_id = duplicate_employee_id;

  UPDATE public.gw_attendance_daily_records
  SET employee_id = primary_employee_id
  WHERE employee_id = duplicate_employee_id;

  UPDATE public.gw_shift_assignments
  SET user_id = approved_user_id
  WHERE employee_id = primary_employee_id
    AND user_id = provisional_user_id;

  UPDATE public.gw_shift_requests
  SET user_id = approved_user_id
  WHERE employee_id = primary_employee_id
    AND user_id = provisional_user_id;

  UPDATE public.gw_shift_request_targets
  SET user_id = approved_user_id
  WHERE employee_id = primary_employee_id
    AND user_id = provisional_user_id;

  UPDATE public.gw_shift_request_submissions
  SET user_id = approved_user_id
  WHERE employee_id = primary_employee_id
    AND user_id = provisional_user_id;

  UPDATE public.gw_shift_period_exclusions
  SET user_id = approved_user_id
  WHERE employee_id = primary_employee_id
    AND user_id = provisional_user_id;

  UPDATE public.gw_shift_cell_styles
  SET cell_key = 'user:' || approved_user_id::text,
      updated_at = NOW()
  WHERE cell_key = 'user:' || provisional_user_id::text;

  -- Release the unique user link before assigning the approved account to No.149.
  UPDATE public.gw_payroll_employees
  SET user_id = NULL,
      payroll_status = 'inactive',
      updated_at = NOW()
  WHERE id = duplicate_employee_id;

  UPDATE public.gw_payroll_employees employee
  SET user_id = approved_user_id,
      display_name = '菅山 紗来',
      real_name = '菅山 紗来',
      payroll_status = 'active',
      raw_payload = COALESCE(employee.raw_payload, '{}'::jsonb)
        || JSONB_BUILD_OBJECT(
          'hr_profile',
          COALESCE(employee.raw_payload->'hr_profile', '{}'::jsonb)
            || JSONB_BUILD_OBJECT(
              'provisional_hire', false,
              'request_collection_excluded', false,
              'provisional_shift_user_id', NULL,
              'tsg_linked_at', NOW()
            )
        ),
      updated_at = NOW()
  WHERE employee.id = primary_employee_id;

  DELETE FROM public.gw_payroll_employees
  WHERE id = duplicate_employee_id;

  DELETE FROM public.gw_users
  WHERE id = provisional_user_id
    AND line_user_id LIKE 'provisional:doc-scanner:%';
END;
$$;

