import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { setUserSession } from '@/lib/session'

/**
 * GET /api/auth/line/callback
 *
 * 責務: LINE OAuth コールバック処理。
 * 1. state 検証（CSRF防止）
 * 2. 認可コードをアクセストークンに交換
 * 3. LINE プロフィール取得
 * 4. gw_users テーブルで line_user_id を検索 → 既存 or 新規登録
 * 5. セッション Cookie を発行
 * 6. グループ一覧へリダイレクト
 */

export async function GET(request: NextRequest) {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'

  try {
    const searchParams = request.nextUrl.searchParams
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const error = searchParams.get('error')

    // LINE がエラーを返した場合（ユーザーが拒否した等）
    if (error) {
      console.error('[LINE callback] LINE auth error:', error)
      return NextResponse.redirect(`${siteUrl}/login?error=cancelled`)
    }

    if (!code || !state) {
      return NextResponse.redirect(`${siteUrl}/login?error=invalid_request`)
    }

    // --- CSRF state 検証 ---
    const savedState = request.cookies.get('line_oauth_state')?.value
    if (!savedState || savedState !== state) {
      console.error('[LINE callback] State mismatch')
      return NextResponse.redirect(`${siteUrl}/login?error=state_mismatch`)
    }

    // --- アクセストークン取得 ---
    const redirectUri = `${siteUrl}/api/auth/line/callback`
    const tokenResponse = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: process.env.LINE_CHANNEL_ID!,
        client_secret: process.env.LINE_CHANNEL_SECRET!,
      }),
    })

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text()
      console.error('[LINE callback] Token exchange failed:', errorBody)
      return NextResponse.redirect(`${siteUrl}/login?error=token_failed`)
    }

    const tokenData = await tokenResponse.json()

    // --- LINE プロフィール取得 ---
    const profileResponse = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })

    if (!profileResponse.ok) {
      console.error('[LINE callback] Profile fetch failed')
      return NextResponse.redirect(`${siteUrl}/login?error=profile_failed`)
    }

    const profile = await profileResponse.json()
    const lineUserId: string = profile.userId
    const displayName: string = profile.displayName
    const pictureUrl: string | null = profile.pictureUrl || null

    const supabase = adminClient

    // --- 既存ユーザー検索 ---
    const { data: existingUser } = await supabase
      .from('gw_users')
      .select('*')
      .eq('line_user_id', lineUserId)
      .single()

    let userId: string

    if (existingUser) {
      // 既存ユーザー → プロフィール更新
      userId = existingUser.id
      await supabase
        .from('gw_users')
        .update({
          display_name: displayName,
          picture_url: pictureUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)
    } else {
      // 新規ユーザー登録
      const { data: newUser, error: insertError } = await supabase
        .from('gw_users')
        .insert({
          line_user_id: lineUserId,
          display_name: displayName,
          picture_url: pictureUrl,
          role: 'member',
        })
        .select()
        .single()

      if (insertError || !newUser) {
        console.error('[LINE callback] User insert failed:', insertError)
        return NextResponse.redirect(`${siteUrl}/login?error=registration_failed`)
      }

      userId = newUser.id
    }

    // --- セッション発行 ---
    // Next.jsの仕様により、cookies().set() ではなく NextResponse に直接セットする
    const response = NextResponse.redirect(`${siteUrl}/groups`)
    response.cookies.set('gw_user_session', userId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30, // 30日
      path: '/',
    })
    response.cookies.delete('line_oauth_state')
    return response

  } catch (err) {
    console.error('[LINE callback] Unexpected error:', err)
    return NextResponse.redirect(`${siteUrl}/login?error=unexpected`)
  }
}
