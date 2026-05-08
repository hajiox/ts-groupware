import { cookies } from 'next/headers'
import { adminClient } from '@/lib/supabase/admin'

/**
 * セッション管理（Cookie ベース）
 *
 * 責務: LINE OAuth 認証後のユーザーセッションを Cookie で管理する。
 * Cookie には user_id のみ保存し、実際のデータは Supabase から都度取得する。
 *
 * セキュリティ:
 * - httpOnly: JS からアクセス不可
 * - secure: 本番では HTTPS のみ
 * - sameSite: lax（OAuthリダイレクトに対応）
 * - 有効期限: 30日
 */

const SESSION_COOKIE_NAME = 'gw_user_session'
const SESSION_MAX_AGE = 60 * 60 * 24 * 30 // 30日

export async function setUserSession(userId: string) {
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE_NAME, userId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  })
}

export async function getUserSession() {
  const cookieStore = await cookies()
  const session = cookieStore.get(SESSION_COOKIE_NAME)
  if (!session?.value) return null

  // DB から user を取得して存在確認
  const { data: user } = await adminClient
    .from('gw_users')
    .select('*')
    .eq('id', session.value)
    .single()

  return user || null
}

export async function clearUserSession() {
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_COOKIE_NAME)
}
