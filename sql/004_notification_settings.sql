-- =============================================
-- グループ別通知設定
-- ユーザーがグループごとに通知ON/OFFを切り替え可能にする。
-- デフォルト（レコードなし）= ON として扱い、OFFにしたいグループだけINSERTする。
-- =============================================

CREATE TABLE IF NOT EXISTS gw_notification_settings (
    user_id UUID REFERENCES gw_users(id) ON DELETE CASCADE,
    group_id UUID REFERENCES gw_groups(id) ON DELETE CASCADE,
    muted BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, group_id)
);

ALTER TABLE gw_notification_settings ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_gw_notification_settings_user_id
    ON gw_notification_settings(user_id);
