-- =============================================
-- TS Groupware — Supabase スキーマ
-- 内職管理プロジェクト（zfhswguzqyagmhhlpksq）に同居
-- テーブル名は gw_ プレフィックスで分離
-- =============================================

-- ユーザー（LINE連携）
CREATE TABLE gw_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    line_user_id TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    picture_url TEXT,
    role TEXT DEFAULT 'member' CHECK (role IN ('admin', 'moderator', 'member')),
    status TEXT DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'suspended')),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- グループ
CREATE TABLE gw_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    type TEXT DEFAULT 'board' CHECK (type IN ('board', 'chat')),
    icon TEXT DEFAULT '📢',
    created_by UUID REFERENCES gw_users(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- グループメンバー
CREATE TABLE gw_group_members (
    group_id UUID REFERENCES gw_groups(id) ON DELETE CASCADE,
    user_id UUID REFERENCES gw_users(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    joined_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (group_id, user_id)
);

-- 投稿（掲示板投稿 + チャットメッセージ兼用）
CREATE TABLE gw_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES gw_groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES gw_users(id),
    content TEXT,
    attachments JSONB DEFAULT '[]'::jsonb,
    parent_id UUID REFERENCES gw_posts(id) ON DELETE CASCADE,
    is_pinned BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ
);

-- リアクション
CREATE TABLE gw_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES gw_posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES gw_users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(post_id, user_id, emoji)
);

-- 既読管理
CREATE TABLE gw_read_status (
    user_id UUID REFERENCES gw_users(id) ON DELETE CASCADE,
    group_id UUID REFERENCES gw_groups(id) ON DELETE CASCADE,
    last_read_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, group_id)
);

-- Web Push 通知購読
CREATE TABLE gw_push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES gw_users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- インデックス
-- =============================================
CREATE INDEX idx_gw_posts_group_id ON gw_posts(group_id);
CREATE INDEX idx_gw_posts_parent_id ON gw_posts(parent_id);
CREATE INDEX idx_gw_posts_created_at ON gw_posts(created_at DESC);
CREATE INDEX idx_gw_reactions_post_id ON gw_reactions(post_id);
CREATE INDEX idx_gw_group_members_user_id ON gw_group_members(user_id);
CREATE INDEX idx_gw_users_line_user_id ON gw_users(line_user_id);
CREATE INDEX idx_gw_users_status ON gw_users(status);

-- =============================================
-- RLS ポリシー（service_role でバイパスするため最小限）
-- =============================================
ALTER TABLE gw_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_read_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Realtime用: anon keyからの読み取りを許可（チャットのリアルタイム購読に必要）
CREATE POLICY "gw_posts_select_all" ON gw_posts FOR SELECT USING (true);
CREATE POLICY "gw_reactions_select_all" ON gw_reactions FOR SELECT USING (true);

-- =============================================
-- Realtime 有効化
-- =============================================
ALTER PUBLICATION supabase_realtime ADD TABLE gw_posts;
ALTER PUBLICATION supabase_realtime ADD TABLE gw_reactions;
