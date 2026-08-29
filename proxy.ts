import { NextRequest, NextResponse } from 'next/server'
import {
  createSessionCookieValue,
  getSessionCookieOptions,
  isSessionExpired,
  parseSessionCookieValue,
  SESSION_COOKIE_NAME,
} from '@/lib/session-cookie'

/**
 * Proxy: 認証チェック
 *
 * ログインページ・API・静的ファイル以外のアクセスで
 * セッション Cookie が無ければログインページにリダイレクト
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (process.env.VERCEL_ENV === 'production' && configuredSiteUrl) {
    const canonicalOrigin = new URL(configuredSiteUrl).origin
    const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    const requestHost = forwardedHost || request.headers.get('host') || request.nextUrl.host
    if (requestHost !== new URL(canonicalOrigin).host) {
      const canonicalUrl = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, canonicalOrigin)
      return NextResponse.redirect(canonicalUrl, 308)
    }
  }

  // 認証不要なパス
  const publicPaths = [
    '/login',
    '/api/auth',
    '/api/time-clock',
    '/api/integrations/tsa',
    '/api/integrations/doc-scanner',
    '/time-clock',
    '/_next',
    '/favicon.ico',
    '/manifest.json',
    '/manual',
    '/sw.js',
    '/icon',
    '/apple-icon',
    '/placeholder',
  ]
  const publicExactPaths = [
    '/api/integrations/meeting-transcriber/summary',
    '/api/integrations/meeting-transcriber/self-dm',
  ]

  if (publicPaths.some(p => pathname.startsWith(p)) || publicExactPaths.includes(pathname) || pathname === '/') {
    return NextResponse.next()
  }

  // セッション Cookie の存在チェック
  const session = request.cookies.get(SESSION_COOKIE_NAME)
  const parsedSession = parseSessionCookieValue(session?.value)
  if (!parsedSession || isSessionExpired(parsedSession)) {
    const loginUrl = new URL('/login', request.url)
    const nextPath = `${request.nextUrl.pathname}${request.nextUrl.search}`
    if (nextPath !== '/login') {
      loginUrl.searchParams.set('next', nextPath)
    }
    const response = NextResponse.redirect(loginUrl)
    response.cookies.delete(SESSION_COOKIE_NAME)
    return response
  }

  const response = NextResponse.next()
  response.cookies.set(
    SESSION_COOKIE_NAME,
    createSessionCookieValue(parsedSession.userId),
    getSessionCookieOptions(),
  )
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
