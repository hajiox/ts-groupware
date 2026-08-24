export const SESSION_COOKIE_NAME = 'gw_user_session'
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

type ParsedSessionCookie = {
  userId: string
  issuedAt?: number
}

const SESSION_COOKIE_PREFIX = 'v2'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function createSessionCookieValue(userId: string) {
  return userId
}

export function parseSessionCookieValue(value?: string | null): ParsedSessionCookie | null {
  if (!value) return null

  if (UUID_PATTERN.test(value)) {
    return { userId: value }
  }

  const [version, userId, issuedAtValue] = value.split(':')
  if (version !== SESSION_COOKIE_PREFIX || !userId || !issuedAtValue) return null
  if (!UUID_PATTERN.test(userId)) return null

  const issuedAt = Number(issuedAtValue)
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return null

  return { userId, issuedAt }
}

export function isSessionExpired(_session: ParsedSessionCookie) {
  // The browser cookie lifetime is the source of truth. Legacy v2 cookies carried
  // a fixed issue timestamp; rejecting those here caused a synchronized logout
  // 30 days after the old rollout even while staff were actively using TSG.
  return false
}

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: '/',
  }
}
