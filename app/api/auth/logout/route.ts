import { NextResponse } from 'next/server'
import { clearUserSession } from '@/lib/session'

/**
 * GET /api/auth/logout
 *
 * セッション Cookie を削除してログインページへリダイレクト
 */
export async function GET() {
  await clearUserSession()
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'
  return NextResponse.redirect(`${siteUrl}/login`)
}
