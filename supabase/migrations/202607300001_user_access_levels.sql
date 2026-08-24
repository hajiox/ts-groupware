-- TSGアカウント権限を「役員・管理者・ユーザー」の3階級へ統一する。
-- グループ内の role (admin/member) は別概念のため変更しない。

ALTER TABLE public.gw_users
  DROP CONSTRAINT IF EXISTS gw_users_role_check;

ALTER TABLE public.gw_users
  ADD CONSTRAINT gw_users_role_check
  CHECK (role IN ('executive', 'admin', 'member'));

UPDATE public.gw_users
SET
  role = 'executive',
  updated_at = now()
WHERE regexp_replace(COALESCE(real_name, display_name, ''), '[[:space:]　]+', '', 'g')
  IN ('佐藤正彦', '佐藤ちさと');
