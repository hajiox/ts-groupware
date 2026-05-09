import { NextRequest, NextResponse } from 'next/server'
import { clearUserSession } from '@/lib/session'

/**
 * GET /api/auth/logout
 *
 * セッション Cookie を削除してログインページへリダイレクト
 */
export async function GET(request: NextRequest) {
  await clearUserSession()
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || request.nextUrl.origin
  return NextResponse.redirect(`${siteUrl}/login`)
}
