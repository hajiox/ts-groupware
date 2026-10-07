import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE_NAME = 'gw_user_session'
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

type ParsedSessionCookie = {
  userId: string
  issuedAt: number
  expiresAt: number
}

const SESSION_COOKIE_PREFIX = 'v3'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const CLOCK_SKEW_SECONDS = 60

function signingSecret() {
  const secret = process.env.SESSION_SIGNING_SECRET
  return secret && secret.length >= 32 ? secret : null
}

function signatureFor(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function createSessionCookieValue(userId: string) {
  const secret = signingSecret()
  if (!secret) throw new Error('SESSION_SIGNING_SECRET must contain at least 32 characters')
  if (!UUID_PATTERN.test(userId)) throw new Error('A valid session user ID is required')

  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = issuedAt + SESSION_MAX_AGE_SECONDS
  const payload = `${SESSION_COOKIE_PREFIX}:${userId}:${issuedAt}:${expiresAt}`
  return `${payload}:${signatureFor(payload, secret)}`
}

export function parseSessionCookieValue(value?: string | null): ParsedSessionCookie | null {
  if (!value) return null

  const secret = signingSecret()
  if (!secret) return null
  const parts = value.split(':')
  if (parts.length !== 5) return null
  const [version, userId, issuedAtValue, expiresAtValue, signature] = parts
  if (version !== SESSION_COOKIE_PREFIX || !userId || !SIGNATURE_PATTERN.test(signature)) return null
  if (!UUID_PATTERN.test(userId)) return null
  if (!/^[1-9]\d{0,12}$/.test(issuedAtValue) || !/^[1-9]\d{0,12}$/.test(expiresAtValue)) return null

  const issuedAt = Number(issuedAtValue)
  const expiresAt = Number(expiresAtValue)
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return null
  if (expiresAt - issuedAt !== SESSION_MAX_AGE_SECONDS) return null

  const payload = parts.slice(0, 4).join(':')
  const expected = Buffer.from(signatureFor(payload, secret))
  const actual = Buffer.from(signature)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null

  return { userId, issuedAt, expiresAt }
}

export function isSessionExpired(session: ParsedSessionCookie) {
  const now = Math.floor(Date.now() / 1000)
  return session.expiresAt <= now || session.issuedAt > now + CLOCK_SKEW_SECONDS
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
