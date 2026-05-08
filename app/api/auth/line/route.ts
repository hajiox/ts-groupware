import { NextResponse } from 'next/server'
import crypto from 'crypto'

/**
 * GET /api/auth/line
 *
 * 責務: LINE OAuth 2.0 認可フローを開始する。
 * LINE の認可エンドポイントへリダイレクトし、ユーザーにログイン許可を求める。
 *
 * フロー: ブラウザ → このRoute → LINE認可画面 → /api/auth/line/callback
 */

export async function GET() {
  const channelId = process.env.LINE_CHANNEL_ID
  if (!channelId) {
    return NextResponse.json({ error: 'LINE_CHANNEL_ID が未設定です' }, { status: 500 })
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'
  const redirectUri = `${siteUrl}/api/auth/line/callback`

  // CSRF 防止用のランダム state
  const state = crypto.randomBytes(16).toString('hex')

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: channelId,
    redirect_uri: redirectUri,
    state,
    scope: 'profile', // openid を削除してメアド要求のハードルを下げる
  })

  const authUrl = `https://access.line.me/oauth2/v2.1/authorize?${params.toString()}`

  // state を Cookie に一時保存（callback で検証するため）
  const response = NextResponse.redirect(authUrl)
  response.cookies.set('line_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600, // 10分
    path: '/',
  })

  return response
}
