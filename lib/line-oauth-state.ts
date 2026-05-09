import crypto from 'crypto'

const STATE_MAX_AGE_MS = 10 * 60 * 1000

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

function sign(data: string, secret: string) {
  return crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function createLineOAuthState(secret: string) {
  const payload = base64UrlEncode(JSON.stringify({
    nonce: crypto.randomBytes(16).toString('hex'),
    iat: Date.now(),
  }))
  const signature = sign(payload, secret)
  return `${payload}.${signature}`
}

export function verifyLineOAuthState(state: string, secret: string) {
  const [payload, signature] = state.split('.')
  if (!payload || !signature) return false

  const expectedSignature = sign(payload, secret)
  const actual = Buffer.from(signature)
  const expected = Buffer.from(expectedSignature)
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return false
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload))
    if (typeof parsed?.iat !== 'number') return false
    return Date.now() - parsed.iat <= STATE_MAX_AGE_MS
  } catch {
    return false
  }
}
