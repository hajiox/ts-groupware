import { NextRequest, NextResponse } from 'next/server'
import { getAuthFlowId, logAuthEvent } from '@/lib/auth-log'
import { createLineOAuthState } from '@/lib/line-oauth-state'

const LINE_OAUTH_NEXT_COOKIE = 'line_oauth_next'

function getSafeNextPath(value: string | null) {
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
 * GET /api/auth/line
 *
 * LINE OAuth 2.0 の認可フローを開始する。
 */
export async function GET(request: NextRequest) {
  const channelId = process.env.LINE_CHANNEL_ID
  const channelSecret = process.env.LINE_CHANNEL_SECRET

  if (!channelId || !channelSecret) {
    await logAuthEvent({
      event: 'line_start_config_missing',
      detail: !channelId ? 'missing_channel_id' : 'missing_channel_secret',
      request,
    })
    return NextResponse.json({ error: 'LINE_CHANNEL_ID または LINE_CHANNEL_SECRET が未設定です' }, { status: 500 })
  }

  const siteUrl = new URL(process.env.NEXT_PUBLIC_SITE_URL?.trim() || request.nextUrl.origin).origin
  const redirectUri = `${siteUrl}/api/auth/line/callback`
  const state = createLineOAuthState(channelSecret)
  const nextPath = getSafeNextPath(request.nextUrl.searchParams.get('next'))
  const flowId = getAuthFlowId(state)

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: channelId,
    redirect_uri: redirectUri,
    state,
    scope: 'profile openid',
  })

  const authUrl = `https://access.line.me/oauth2/v2.1/authorize?${params.toString()}`

  await logAuthEvent({
    event: 'line_start_redirect',
    flowId,
    detail: `redirect_uri=${redirectUri}`,
    request,
  })

  const response = NextResponse.redirect(authUrl)
  response.cookies.set('line_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })
  if (nextPath) {
    response.cookies.set(LINE_OAUTH_NEXT_COOKIE, nextPath, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600,
      path: '/',
    })
  } else {
    response.cookies.delete(LINE_OAUTH_NEXT_COOKIE)
  }

  return response
}
