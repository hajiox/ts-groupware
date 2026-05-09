import { NextRequest, NextResponse } from 'next/server'
import { getAuthFlowId, logAuthEvent } from '@/lib/auth-log'
import { adminClient } from '@/lib/supabase/admin'
import { verifyLineOAuthState } from '@/lib/line-oauth-state'

/**
 * GET /api/auth/line/callback
 *
 * 責務: LINE OAuth コールバック処理。
 * 1. state 検証（CSRF防止）
 * 2. 認可コードをアクセストークンに交換
 * 3. LINE プロフィール取得
 * 4. gw_users テーブルで line_user_id を検索 → 既存 or 承認待ち登録
 * 5. 承認済みユーザーのみセッション Cookie を発行
 * 6. グループ一覧へリダイレクト
 */

export async function GET(request: NextRequest) {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || request.nextUrl.origin

  try {
    const searchParams = request.nextUrl.searchParams
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const error = searchParams.get('error')
    const flowId = getAuthFlowId(state)

    await logAuthEvent({
      event: 'line_callback_received',
      flowId,
      detail: `has_code=${!!code};has_state=${!!state};has_error=${!!error}`,
      request,
    })

    // LINE がエラーを返した場合（ユーザーが拒否した等）
    if (error) {
      console.error('[LINE callback] LINE auth error:', error)
      await logAuthEvent({ event: 'line_callback_line_error', flowId, detail: error, request })
      return NextResponse.redirect(`${siteUrl}/login?error=cancelled`)
    }

    if (!code || !state) {
      await logAuthEvent({ event: 'line_callback_invalid_request', flowId, request })
      return NextResponse.redirect(`${siteUrl}/login?error=invalid_request`)
    }

    // --- CSRF state 検証 ---
    const savedState = request.cookies.get('line_oauth_state')?.value
    const channelSecret = process.env.LINE_CHANNEL_SECRET!
    const isCookieStateValid = !!savedState && savedState === state
    const isSignedStateValid = verifyLineOAuthState(state, channelSecret)
    if (!isCookieStateValid && !isSignedStateValid) {
      console.error('[LINE callback] State mismatch')
      await logAuthEvent({
        event: 'line_callback_state_mismatch',
        flowId,
        detail: `cookie=${isCookieStateValid};signed=${isSignedStateValid}`,
        request,
      })
      return NextResponse.redirect(`${siteUrl}/login?error=state_mismatch`)
    }

    await logAuthEvent({
      event: 'line_callback_state_ok',
      flowId,
      detail: `cookie=${isCookieStateValid};signed=${isSignedStateValid}`,
      request,
    })

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
      await logAuthEvent({
        event: 'line_callback_token_failed',
        flowId,
        detail: errorBody.slice(0, 500),
        request,
      })
      return NextResponse.redirect(`${siteUrl}/login?error=token_failed`)
    }

    const tokenData = await tokenResponse.json()
    await logAuthEvent({ event: 'line_callback_token_ok', flowId, request })

    // --- LINE プロフィール取得 ---
    const profileResponse = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })

    if (!profileResponse.ok) {
      console.error('[LINE callback] Profile fetch failed')
      await logAuthEvent({
        event: 'line_callback_profile_failed',
        flowId,
        detail: `status=${profileResponse.status}`,
        request,
      })
      return NextResponse.redirect(`${siteUrl}/login?error=profile_failed`)
    }

    const profile = await profileResponse.json()
    const lineUserId: string = profile.userId
    const displayName: string = profile.displayName
    const pictureUrl: string | null = profile.pictureUrl || null
    await logAuthEvent({ event: 'line_callback_profile_ok', flowId, request })

    const supabase = adminClient

    // --- 既存ユーザー検索 ---
    const { data: existingUser } = await supabase
      .from('gw_users')
      .select('*')
      .eq('line_user_id', lineUserId)
      .single()

    let userId: string
    let userStatus = 'pending'

    if (existingUser) {
      // 既存ユーザー → プロフィール更新
      userId = existingUser.id
      userStatus = existingUser.status || 'approved'
      await supabase
        .from('gw_users')
        .update({
          display_name: displayName,
          picture_url: pictureUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)
      await logAuthEvent({
        event: 'line_callback_existing_user',
        flowId,
        detail: `status=${userStatus}`,
        request,
      })
    } else {
      // 新規ユーザー登録。管理者が承認するまでログインセッションは発行しない。
      const { data: newUser, error: insertError } = await supabase
        .from('gw_users')
        .insert({
          line_user_id: lineUserId,
          display_name: displayName,
          picture_url: pictureUrl,
          role: 'member',
          status: 'pending',
        })
        .select()
        .single()

      if (insertError || !newUser) {
        console.error('[LINE callback] User insert failed:', insertError)
        await logAuthEvent({
          event: 'line_callback_user_insert_failed',
          flowId,
          detail: insertError?.message?.slice(0, 500),
          request,
        })
        return NextResponse.redirect(`${siteUrl}/login?error=registration_failed`)
      }

      userId = newUser.id
      userStatus = newUser.status || 'pending'
      await logAuthEvent({
        event: 'line_callback_user_inserted',
        flowId,
        detail: `status=${userStatus}`,
        request,
      })
    }

    if (userStatus === 'pending') {
      await logAuthEvent({ event: 'line_callback_pending_redirect', flowId, request })
      const response = NextResponse.redirect(`${siteUrl}/login?error=approval_pending`)
      response.cookies.delete('line_oauth_state')
      response.cookies.delete('gw_user_session')
      return response
    }

    if (userStatus === 'suspended') {
      await logAuthEvent({ event: 'line_callback_suspended_redirect', flowId, request })
      const response = NextResponse.redirect(`${siteUrl}/login?error=account_suspended`)
      response.cookies.delete('line_oauth_state')
      response.cookies.delete('gw_user_session')
      return response
    }

    // --- セッション発行 ---
    // Next.jsの仕様により、cookies().set() ではなく NextResponse に直接セットする
    const response = NextResponse.redirect(`${siteUrl}/groups`)
    await logAuthEvent({ event: 'line_callback_approved_redirect', flowId, request })
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
    await logAuthEvent({
      event: 'line_callback_unexpected',
      detail: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
      request,
    })
    return NextResponse.redirect(`${siteUrl}/login?error=unexpected`)
  }
}
