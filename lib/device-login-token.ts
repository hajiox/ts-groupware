import crypto from 'crypto'

const TOKEN_MAX_AGE_MS = 5 * 60 * 1000

function getSecret() {
  return process.env.DEVICE_LOGIN_SECRET
    || process.env.LINE_CHANNEL_SECRET
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || 'ts-groupware-device-login'
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
  return crypto
    .createHmac('sha256', getSecret())
    .update(payload)
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
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null

  const expectedSignature = sign(payload)
  const actual = Buffer.from(signature)
  const expected = Buffer.from(expectedSignature)
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return null
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload))
    if (typeof parsed?.userId !== 'string' || typeof parsed?.iat !== 'number') return null
    if (Date.now() - parsed.iat > TOKEN_MAX_AGE_MS) return null
    return { userId: parsed.userId as string }
  } catch {
    return null
  }
}
