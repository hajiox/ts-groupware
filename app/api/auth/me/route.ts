import { NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'

/**
 * GET /api/auth/me
 *
 * 現在ログイン中のユーザー情報を返す。
 * クライアントコンポーネントから fetch して認証状態を確認する。
 */
export async function GET() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ user: null }, { status: 401 })
  }
  return NextResponse.json({ user })
}
