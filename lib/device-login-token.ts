import crypto from 'crypto'

const TOKEN_MAX_AGE_MS = 5 * 60 * 1000
const CLOCK_SKEW_MS = 60 * 1000

function getSecret() {
  const existingSecret = process.env.DEVICE_LOGIN_SECRET
    || process.env.LINE_CHANNEL_SECRET
    || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (existingSecret) return { secret: existingSecret, prefix: '' }
  const sessionSecret = process.env.SESSION_SIGNING_SECRET
  return sessionSecret && sessionSecret.length >= 32
    ? { secret: sessionSecret, prefix: 'tsg-device-login:v1:' }
    : null
}

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalized, 'base64').toString('utf8')
}

function sign(payload: string) {
  const key = getSecret()
  if (!key) throw new Error('A device login signing secret is required')
  return crypto
    .createHmac('sha256', key.secret)
    .update(`${key.prefix}${payload}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function createDeviceLoginToken(userId: string) {
  const payload = base64UrlEncode(JSON.stringify({
    userId,
    nonce: crypto.randomBytes(16).toString('hex'),
    iat: Date.now(),
  }))
  return `${payload}.${sign(payload)}`
}

export function verifyDeviceLoginToken(token: string) {
  const parts = token.split('.')
  if (parts.length !== 2 || !getSecret()) return null
  const [payload, signature] = parts
  if (!payload || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null

  const expectedSignature = sign(payload)
  const actual = Buffer.from(signature)
  const expected = Buffer.from(expectedSignature)
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return null
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload))
    if (typeof parsed?.userId !== 'string' || !parsed.userId || !Number.isSafeInteger(parsed?.iat) || parsed.iat <= 0) return null
    const now = Date.now()
    if (now - parsed.iat >= TOKEN_MAX_AGE_MS || parsed.iat > now + CLOCK_SKEW_MS) return null
    return { userId: parsed.userId as string }
  } catch {
    return null
  }
}
