-- Persist monthly attendance review checks.

CREATE TABLE IF NOT EXISTS public.gw_attendance_monthly_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_month DATE NOT NULL,
  user_id UUID NOT NULL REFERENCES public.gw_users(id) ON DELETE CASCADE,
  checked_by UUID REFERENCES public.gw_users(id) ON DELETE SET NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (check_month, user_id),
  CHECK (date_trunc('month', check_month)::date = check_month)
);

CREATE INDEX IF NOT EXISTS idx_gw_attendance_monthly_checks_month
  ON public.gw_attendance_monthly_checks(check_month, checked_at);

CREATE INDEX IF NOT EXISTS idx_gw_attendance_monthly_checks_user
  ON public.gw_attendance_monthly_checks(user_id, check_month);

ALTER TABLE public.gw_attendance_monthly_checks ENABLE ROW LEVEL SECURITY;

GRANT ALL PRIVILEGES ON TABLE public.gw_attendance_monthly_checks TO service_role;

COMMENT ON TABLE public.gw_attendance_monthly_checks IS 'Monthly attendance review completion state per staff member.';

INSERT INTO public.gw_attendance_monthly_checks (check_month, user_id, checked_by, checked_at, note)
SELECT DATE '2026-06-01', users.id, NULL, now(), 'Recovered from June local monthly attendance checks.'
FROM public.gw_users users
WHERE users.status = 'approved'
  AND users.department IN ('フロア', '製造', '道の駅')
ON CONFLICT (check_month, user_id) DO NOTHING;
