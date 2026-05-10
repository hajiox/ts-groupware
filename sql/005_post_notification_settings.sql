-- =============================================
-- 投稿ごとの通知ミュート設定
-- 特定の投稿（スレッド）に関する通知をOFFにする。
-- =============================================

CREATE TABLE IF NOT EXISTS gw_post_notification_settings (
    user_id UUID REFERENCES gw_users(id) ON DELETE CASCADE,
    post_id UUID REFERENCES gw_posts(id) ON DELETE CASCADE,
    muted BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, post_id)
);

ALTER TABLE gw_post_notification_settings ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_gw_post_notification_settings_post_id
    ON gw_post_notification_settings(post_id);
