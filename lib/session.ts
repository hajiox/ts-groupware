import { cookies } from 'next/headers'
import {
  createSessionCookieValue,
  getSessionCookieOptions,
  isSessionExpired,
  parseSessionCookieValue,
  SESSION_COOKIE_NAME,
} from '@/lib/session-cookie'
import { adminClient } from '@/lib/supabase/admin'
import { normalizeLinePictureUrl } from '@/lib/line-picture'

export async function setUserSession(userId: string) {
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE_NAME, createSessionCookieValue(userId), getSessionCookieOptions())
}

export async function getUserSession() {
  const cookieStore = await cookies()
  const session = cookieStore.get(SESSION_COOKIE_NAME)
  if (!session?.value) return null

  const parsedSession = parseSessionCookieValue(session.value)
  if (!parsedSession || isSessionExpired(parsedSession)) {
    try {
      cookieStore.delete(SESSION_COOKIE_NAME)
    } catch {
      // Cookie deletion can fail in read-only contexts.
    }
    return null
  }

  const { data: user } = await adminClient
    .from('gw_users')
    .select('*')
    .eq('id', parsedSession.userId)
    .single()

  if (!user) return null
  if ((user.status || 'approved') !== 'approved') return null

  user.display_name = user.real_name || user.display_name
  user.picture_url = normalizeLinePictureUrl(user.picture_url)

  // Keep active sessions alive for 30 days and migrate legacy v2 values to the
  // current plain user-id format. Read-only server contexts can reject writes.
  try {
    cookieStore.set(SESSION_COOKIE_NAME, createSessionCookieValue(parsedSession.userId), getSessionCookieOptions())
  } catch {
    // Proxy and route handlers also refresh the cookie where writes are allowed.
  }

  return user
}

export async function clearUserSession() {
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_COOKIE_NAME)
}
