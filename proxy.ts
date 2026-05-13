import { NextRequest, NextResponse } from 'next/server'

/**
 * Proxy: 認証チェック
 *
 * ログインページ・API・静的ファイル以外のアクセスで
 * セッション Cookie が無ければログインページにリダイレクト
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // 認証不要なパス
  const publicPaths = [
    '/login',
    '/api/auth',
    '/_next',
    '/favicon.ico',
    '/manifest.json',
    '/sw.js',
    '/icon',
    '/apple-icon',
    '/placeholder',
  ]

  if (publicPaths.some(p => pathname.startsWith(p)) || pathname === '/') {
    return NextResponse.next()
  }

  // セッション Cookie の存在チェック
  const session = request.cookies.get('gw_user_session')
  if (!session?.value) {
    const loginUrl = new URL('/login', request.url)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
