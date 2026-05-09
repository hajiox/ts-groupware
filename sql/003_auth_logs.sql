-- =============================================
-- TS Groupware — LINE認証診断ログ
-- 個人識別子は保存せず、OAuthの到達段階だけを記録する
-- =============================================

CREATE TABLE IF NOT EXISTS gw_auth_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event TEXT NOT NULL,
    flow_id TEXT,
    detail TEXT,
    user_agent TEXT,
    referer TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gw_auth_logs_created_at ON gw_auth_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gw_auth_logs_flow_id ON gw_auth_logs(flow_id);
