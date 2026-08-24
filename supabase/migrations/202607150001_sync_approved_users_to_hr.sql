-- Keep the HR/payroll employee master in sync with approved TSG users.

CREATE OR REPLACE FUNCTION public.gw_sync_approved_user_to_hr()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  employee_id_value uuid;
  candidate_employee_id uuid;
  candidate_count integer := 0;
  workplace_id_value uuid;
  employee_name_value text;
BEGIN
  IF COALESCE(NEW.status, 'approved') <> 'approved' THEN
    RETURN NEW;
  END IF;

  employee_name_value := COALESCE(
    NULLIF(BTRIM(NEW.real_name), ''),
    NULLIF(BTRIM(NEW.display_name), ''),
    '名称未設定'
  );

  SELECT workplace.id
  INTO workplace_id_value
  FROM public.gw_workplaces workplace
  WHERE workplace.code = CASE NEW.department
    WHEN 'フロア' THEN 'aizu_brandhall'
    WHEN '製造' THEN 'hq'
    WHEN '道の駅' THEN 'michinoeki'
    ELSE NULL
  END
  LIMIT 1;

  SELECT employee.id
  INTO employee_id_value
  FROM public.gw_payroll_employees employee
  WHERE employee.user_id = NEW.id
  LIMIT 1;

  IF employee_id_value IS NULL THEN
    SELECT
      COUNT(*),
      (ARRAY_AGG(employee.id ORDER BY employee.created_at, employee.id))[1]
    INTO candidate_count, candidate_employee_id
    FROM public.gw_payroll_employees employee
    WHERE employee.user_id IS NULL
      AND employee.payroll_status <> 'retired'
      AND REGEXP_REPLACE(
        COALESCE(employee.real_name, employee.display_name),
        '[[:space:]　]',
        '',
        'g'
      ) = REGEXP_REPLACE(employee_name_value, '[[:space:]　]', '', 'g');

    IF candidate_count = 1 THEN
      UPDATE public.gw_payroll_employees
      SET user_id = NEW.id
      WHERE id = candidate_employee_id
      RETURNING id INTO employee_id_value;
    END IF;
  END IF;

  IF employee_id_value IS NULL THEN
    INSERT INTO public.gw_payroll_employees (
      user_id,
      display_name,
      real_name,
      department,
      default_workplace_id,
      source_key,
      raw_payload
    )
    VALUES (
      NEW.id,
      employee_name_value,
      NULLIF(BTRIM(NEW.real_name), ''),
      NEW.department,
      workplace_id_value,
      'gw_users:' || NEW.id::text,
      JSONB_BUILD_OBJECT(
        'source', 'gw_users',
        'line_user_id', NEW.line_user_id
      )
    )
    RETURNING id INTO employee_id_value;
  END IF;

  UPDATE public.gw_payroll_employees employee
  SET display_name = employee_name_value,
      real_name = COALESCE(NULLIF(BTRIM(NEW.real_name), ''), employee.real_name),
      department = COALESCE(NEW.department, employee.department),
      default_workplace_id = COALESCE(workplace_id_value, employee.default_workplace_id),
      raw_payload = COALESCE(employee.raw_payload, '{}'::jsonb) || JSONB_BUILD_OBJECT(
        'tsg_sync', JSONB_BUILD_OBJECT(
          'user_id', NEW.id,
          'line_user_id', NEW.line_user_id,
          'synced_at', NOW()
        )
      ),
      updated_at = NOW()
  WHERE employee.id = employee_id_value;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gw_users_sync_approved_user_to_hr ON public.gw_users;

CREATE TRIGGER gw_users_sync_approved_user_to_hr
AFTER INSERT OR UPDATE OF status, display_name, real_name, department, line_user_id
ON public.gw_users
FOR EACH ROW
EXECUTE FUNCTION public.gw_sync_approved_user_to_hr();

-- Backfill approved accounts created after the original payroll migration.
UPDATE public.gw_users
SET status = status
WHERE status = 'approved';

COMMENT ON FUNCTION public.gw_sync_approved_user_to_hr()
IS 'Creates or links an HR/payroll employee when a TSG user is approved and follows name/department changes.';
