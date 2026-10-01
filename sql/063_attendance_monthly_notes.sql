-- Keep a staff member's labor-office memo independently of review checkboxes.
CREATE TABLE IF NOT EXISTS public.gw_attendance_monthly_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.gw_users(id) ON DELETE CASCADE,
  note_month DATE NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES public.gw_users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES public.gw_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (note_month, user_id),
  CHECK (date_trunc('month', note_month)::date = note_month),
  CHECK (char_length(memo) <= 2000)
);

ALTER TABLE public.gw_attendance_monthly_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gw_attendance_monthly_notes FROM anon, authenticated;
GRANT ALL ON TABLE public.gw_attendance_monthly_notes TO service_role;

CREATE OR REPLACE FUNCTION public.gw_save_attendance_monthly_note(
  p_user_id UUID,
  p_note_month DATE,
  p_memo TEXT,
  p_actor_id UUID,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL
) RETURNS SETOF public.gw_attendance_monthly_notes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  saved public.gw_attendance_monthly_notes;
BEGIN
  IF p_actor_id IS NULL OR p_note_month IS NULL OR p_memo IS NULL
     OR date_trunc('month', p_note_month)::date <> p_note_month
     OR char_length(p_memo) > 2000 THEN
    RAISE EXCEPTION 'Invalid monthly attendance memo' USING ERRCODE = '22023';
  END IF;

  IF p_expected_updated_at IS NULL THEN
    INSERT INTO public.gw_attendance_monthly_notes
      (user_id, note_month, memo, created_by, updated_by)
    VALUES (p_user_id, p_note_month, p_memo, p_actor_id, p_actor_id)
    ON CONFLICT (note_month, user_id) DO NOTHING
    RETURNING * INTO saved;
  ELSE
    UPDATE public.gw_attendance_monthly_notes
    SET memo = p_memo, updated_by = p_actor_id, updated_at = clock_timestamp()
    WHERE user_id = p_user_id AND note_month = p_note_month
      AND updated_at = p_expected_updated_at
    RETURNING * INTO saved;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Monthly attendance memo was updated by another administrator'
      USING ERRCODE = '40001';
  END IF;

  -- The changed submission content needs a fresh review; the memo remains on uncheck.
  DELETE FROM public.gw_attendance_monthly_checks
  WHERE user_id = p_user_id AND check_month = p_note_month;
  RETURN NEXT saved;
END;
$$;

REVOKE ALL ON FUNCTION public.gw_save_attendance_monthly_note(UUID, DATE, TEXT, UUID, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gw_save_attendance_monthly_note(UUID, DATE, TEXT, UUID, TIMESTAMPTZ)
  TO service_role;

COMMENT ON TABLE public.gw_attendance_monthly_notes IS
  'Per-staff, per-month overall memo included in the labor-office attendance workbook.';
