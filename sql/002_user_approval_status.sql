-- =============================================
-- TS Groupware — ユーザー承認ステータス追加
-- 既存ユーザーは現行運用を維持するため approved として扱う
-- =============================================

ALTER TABLE gw_users
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'approved'
CHECK (status IN ('pending', 'approved', 'suspended'));

UPDATE gw_users
SET status = 'approved'
WHERE status IS NULL;

CREATE INDEX IF NOT EXISTS idx_gw_users_status ON gw_users(status);
