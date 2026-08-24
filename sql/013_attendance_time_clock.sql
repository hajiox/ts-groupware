-- TSG attendance time clock
-- 勤務先Wi-Fi判定はアプリ側で TSG_ATTENDANCE_ALLOWED_IPS / TSG_ATTENDANCE_ALLOWED_NETWORKS を照合する。

CREATE TABLE IF NOT EXISTS gw_attendance_punches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES gw_users(id) ON DELETE CASCADE,
  punch_type TEXT NOT NULL CHECK (punch_type IN ('clock_in', 'clock_out')),
  work_date DATE NOT NULL,
  punched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_ip INET,
  network_label TEXT,
  ip_allowed BOOLEAN NOT NULL DEFAULT true,
  user_agent TEXT,
  memo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gw_attendance_punches_user_date
  ON gw_attendance_punches(user_id, work_date, punched_at);

CREATE INDEX IF NOT EXISTS idx_gw_attendance_punches_work_date
  ON gw_attendance_punches(work_date, punched_at);

ALTER TABLE gw_attendance_punches ENABLE ROW LEVEL SECURITY;

GRANT ALL PRIVILEGES ON TABLE gw_attendance_punches TO service_role;

COMMENT ON TABLE gw_attendance_punches IS 'TSG attendance raw punch logs for clock in/out.';
COMMENT ON COLUMN gw_attendance_punches.work_date IS 'Business date in Asia/Tokyo.';
