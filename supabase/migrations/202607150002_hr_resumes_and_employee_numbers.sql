-- Private resume storage metadata and non-reusable sequential employee numbers.

CREATE SEQUENCE IF NOT EXISTS public.gw_employee_code_seq
  AS bigint
  START WITH 1
  INCREMENT BY 1
  NO CYCLE;

DO $$
DECLARE
  current_max bigint;
BEGIN
  SELECT COALESCE(MAX(employee_code::bigint), 0)
  INTO current_max
  FROM public.gw_payroll_employees
  WHERE employee_code ~ '^[0-9]+$';

  IF current_max > 0 THEN
    PERFORM SETVAL('public.gw_employee_code_seq', current_max, true);
  ELSE
    PERFORM SETVAL('public.gw_employee_code_seq', 1, false);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.gw_assign_employee_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_sequence_value bigint;
  numeric_code bigint;
  normalized_name text;
BEGIN
  normalized_name := REGEXP_REPLACE(
    COALESCE(NEW.real_name, NEW.display_name, ''),
    '[[:space:]　]',
    '',
    'g'
  );

  IF NULLIF(BTRIM(NEW.employee_code), '') IS NULL THEN
    IF NEW.payroll_status = 'active'
      AND NEW.user_id IS NOT NULL
      AND normalized_name <> 'TSG君'
    THEN
      NEW.employee_code := NEXTVAL('public.gw_employee_code_seq')::text;
    ELSE
      NEW.employee_code := NULL;
    END IF;
  ELSIF NEW.employee_code ~ '^[0-9]+$' THEN
    numeric_code := NEW.employee_code::bigint;
    SELECT last_value INTO current_sequence_value FROM public.gw_employee_code_seq;
    IF numeric_code > current_sequence_value THEN
      PERFORM SETVAL('public.gw_employee_code_seq', numeric_code, true);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gw_payroll_employees_assign_code ON public.gw_payroll_employees;

CREATE TRIGGER gw_payroll_employees_assign_code
BEFORE INSERT OR UPDATE OF employee_code, user_id, payroll_status, display_name, real_name
ON public.gw_payroll_employees
FOR EACH ROW
EXECUTE FUNCTION public.gw_assign_employee_code();

-- Newest LINE registration receives the first new number (145 in production),
-- followed by older approved human accounts that still lack an employee number.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT employee.id
    FROM public.gw_payroll_employees employee
    WHERE employee.payroll_status = 'active'
      AND employee.user_id IS NOT NULL
      AND NULLIF(BTRIM(employee.employee_code), '') IS NULL
      AND REGEXP_REPLACE(COALESCE(employee.real_name, employee.display_name, ''), '[[:space:]　]', '', 'g') <> 'TSG君'
    ORDER BY
      CASE
        WHEN REGEXP_REPLACE(COALESCE(employee.real_name, employee.display_name, ''), '[[:space:]　]', '', 'g') = '新田奈美'
          THEN 0
        ELSE 1
      END,
      employee.created_at,
      employee.id
  LOOP
    UPDATE public.gw_payroll_employees
    SET employee_code = NULL,
        updated_at = NOW()
    WHERE id = target.id;
  END LOOP;
END;
$$;

CREATE TABLE IF NOT EXISTS public.gw_hr_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.gw_payroll_employees(id) ON DELETE CASCADE,
  document_type text NOT NULL DEFAULT 'resume'
    CHECK (document_type IN ('resume')),
  file_name text NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/pdf',
  file_size bigint NOT NULL DEFAULT 0 CHECK (file_size >= 0),
  drive_file_id text NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  ocr_status text NOT NULL DEFAULT 'pending'
    CHECK (ocr_status IN ('pending', 'processing', 'completed', 'failed')),
  ocr_provider text,
  ocr_model text,
  extracted_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ocr_error text,
  uploaded_by uuid REFERENCES public.gw_users(id) ON DELETE SET NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gw_hr_documents_employee
  ON public.gw_hr_documents(employee_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gw_hr_documents_current_resume
  ON public.gw_hr_documents(employee_id, document_type)
  WHERE is_current;

ALTER TABLE public.gw_hr_documents ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.gw_hr_documents TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.gw_employee_code_seq TO service_role;

COMMENT ON SEQUENCE public.gw_employee_code_seq
IS 'Monotonic employee number source. Values are never reused after retirement or deletion.';

COMMENT ON TABLE public.gw_hr_documents
IS 'Private HR documents stored in Google Drive with Gemini OCR metadata.';
