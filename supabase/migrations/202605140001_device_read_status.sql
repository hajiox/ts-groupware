-- Device-scoped read status for stable per-device unread badges.

CREATE TABLE IF NOT EXISTS gw_device_read_status (
  user_id UUID REFERENCES gw_users(id) ON DELETE CASCADE,
  group_id UUID REFERENCES gw_groups(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  last_read_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, group_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_gw_device_read_status_user_device
  ON gw_device_read_status(user_id, device_id);

ALTER TABLE gw_device_read_status ENABLE ROW LEVEL SECURITY;

ALTER TABLE gw_push_subscriptions
  ADD COLUMN IF NOT EXISTS device_id TEXT;

CREATE INDEX IF NOT EXISTS idx_gw_push_subscriptions_user_device
  ON gw_push_subscriptions(user_id, device_id);
