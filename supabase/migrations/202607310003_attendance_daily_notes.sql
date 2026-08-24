-- Preserve manager notes even when a workday has no physical punches.

CREATE TABLE IF NOT EXISTS public.gw_attendance_daily_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.gw_users(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  memo TEXT NOT NULL,
  created_by UUID REFERENCES public.gw_users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES public.gw_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gw_attendance_daily_notes_user_date_key UNIQUE (user_id, work_date),
  CONSTRAINT gw_attendance_daily_notes_memo_length_check CHECK (char_length(memo) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_gw_attendance_daily_notes_work_date
  ON public.gw_attendance_daily_notes(work_date, user_id);

ALTER TABLE public.gw_attendance_daily_notes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.gw_attendance_daily_notes IS
  'Manager-entered daily attendance notes. Kept independently so notes survive on no-punch days.';

