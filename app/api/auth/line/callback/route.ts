import { NextRequest, NextResponse } from 'next/server'
import { getAuthFlowId, logAuthEvent } from '@/lib/auth-log'
import { createSessionCookieValue, getSessionCookieOptions, SESSION_COOKIE_NAME } from '@/lib/session-cookie'
import { adminClient } from '@/lib/supabase/admin'
import { verifyLineOAuthState } from '@/lib/line-oauth-state'
import { normalizeLinePictureUrl } from '@/lib/line-picture'

const LINE_OAUTH_NEXT_COOKIE = 'line_oauth_next'

function getSafeNextPath(value?: string | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null

  try {
    const parsed = new URL(value, 'https://tsg.local')
    if (parsed.origin !== 'https://tsg.local') return null
    if (parsed.pathname === '/login' || parsed.pathname.startsWith('/api/auth')) return null
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return null
  }
}

/**
 * GET /api/auth/line/callback
 *
 * 雋ｬ蜍・ LINE OAuth 繧ｳ繝ｼ繝ｫ繝舌ャ繧ｯ蜃ｦ逅・・ * 1. state 讀懆ｨｼ・・SRF髦ｲ豁｢・・ * 2. 隱榊庄繧ｳ繝ｼ繝峨ｒ繧｢繧ｯ繧ｻ繧ｹ繝医・繧ｯ繝ｳ縺ｫ莠､謠・ * 3. LINE 繝励Ο繝輔ぅ繝ｼ繝ｫ蜿門ｾ・ * 4. gw_users 繝・・繝悶Ν縺ｧ line_user_id 繧呈､懃ｴ｢ 竊・譌｢蟄・or 謇ｿ隱榊ｾ・■逋ｻ骭ｲ
 * 5. 謇ｿ隱肴ｸ医∩繝ｦ繝ｼ繧ｶ繝ｼ縺ｮ縺ｿ繧ｻ繝・す繝ｧ繝ｳ Cookie 繧堤匱陦・ * 6. 繧ｰ繝ｫ繝ｼ繝嶺ｸ隕ｧ縺ｸ繝ｪ繝繧､繝ｬ繧ｯ繝・ */

export async function GET(request: NextRequest) {
  const siteUrl = new URL(process.env.NEXT_PUBLIC_SITE_URL?.trim() || request.nextUrl.origin).origin

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

    // LINE error or cancellation.
    if (error) {
      console.error('[LINE callback] LINE auth error:', error)
      await logAuthEvent({ event: 'line_callback_line_error', flowId, detail: error, request })
      return NextResponse.redirect(`${siteUrl}/login?error=cancelled`)
    }

    if (!code || !state) {
      await logAuthEvent({ event: 'line_callback_invalid_request', flowId, request })
      return NextResponse.redirect(`${siteUrl}/login?error=invalid_request`)
    }

    // --- CSRF state 讀懆ｨｼ ---
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

    // --- 繧｢繧ｯ繧ｻ繧ｹ繝医・繧ｯ繝ｳ蜿門ｾ・---
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

    // --- LINE 繝励Ο繝輔ぅ繝ｼ繝ｫ蜿門ｾ・---
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
    const pictureUrl = normalizeLinePictureUrl(profile.pictureUrl || null)
    await logAuthEvent({ event: 'line_callback_profile_ok', flowId, request })

    const supabase = adminClient

    // --- 譌｢蟄倥Θ繝ｼ繧ｶ繝ｼ讀懃ｴ｢ ---
    const { data: existingUser } = await supabase
      .from('gw_users')
      .select('*')
      .eq('line_user_id', lineUserId)
      .single()

    let userId: string
    let userStatus = 'pending'

    if (existingUser) {
      // 譌｢蟄倥Θ繝ｼ繧ｶ繝ｼ 竊・繝励Ο繝輔ぅ繝ｼ繝ｫ譖ｴ譁ｰ
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
      // Register a new user as pending approval.
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
      response.cookies.delete(LINE_OAUTH_NEXT_COOKIE)
      response.cookies.delete(SESSION_COOKIE_NAME)
      return response
    }

    if (userStatus === 'suspended') {
      await logAuthEvent({ event: 'line_callback_suspended_redirect', flowId, request })
      const response = NextResponse.redirect(`${siteUrl}/login?error=account_suspended`)
      response.cookies.delete('line_oauth_state')
      response.cookies.delete(LINE_OAUTH_NEXT_COOKIE)
      response.cookies.delete(SESSION_COOKIE_NAME)
      return response
    }

    // --- 繧ｻ繝・す繝ｧ繝ｳ逋ｺ陦・---
    // Next.js縺ｮ莉墓ｧ倥↓繧医ｊ縲…ookies().set() 縺ｧ縺ｯ縺ｪ縺・NextResponse 縺ｫ逶ｴ謗･繧ｻ繝・ヨ縺吶ｋ
    const nextPath = getSafeNextPath(request.cookies.get(LINE_OAUTH_NEXT_COOKIE)?.value)
    const response = NextResponse.redirect(`${siteUrl}${nextPath || '/groups'}`)
    await logAuthEvent({ event: 'line_callback_approved_redirect', flowId, request })
    response.cookies.set(SESSION_COOKIE_NAME, createSessionCookieValue(userId), getSessionCookieOptions())
    response.cookies.delete('line_oauth_state')
    response.cookies.delete(LINE_OAUTH_NEXT_COOKIE)
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
