import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { createDeviceLoginToken, verifyDeviceLoginToken } from '@/lib/device-login-token'
import { getUserSession, setUserSession } from '@/lib/session'

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const token = createDeviceLoginToken(user.id)
  const url = new URL('/api/auth/device-login', request.nextUrl.origin)
  url.searchParams.set('token', token)

  return NextResponse.json({
    url: url.toString(),
    expiresInSeconds: 300,
  })
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token') || ''
  const verified = verifyDeviceLoginToken(token)
  if (!verified) {
    return NextResponse.redirect(new URL('/login?error=invalid_request', request.url))
  }

  const { data: user } = await adminClient
    .from('gw_users')
    .select('id, status')
    .eq('id', verified.userId)
    .single()

  if (!user || (user.status || 'approved') !== 'approved') {
    return NextResponse.redirect(new URL('/login?error=account_suspended', request.url))
  }

  await setUserSession(user.id)
  return NextResponse.redirect(new URL('/settings?deviceLogin=1', request.url))
}
