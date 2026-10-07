const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const ts = require('typescript')

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const otherUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const testSecret = 'test-only-session-signing-secret-0123456789abcdef'
const envNames = ['SESSION_SIGNING_SECRET', 'DEVICE_LOGIN_SECRET', 'LINE_CHANNEL_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY', 'VERCEL_ENV', 'NEXT_PUBLIC_SITE_URL', 'NODE_ENV']
const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
const realNow = Date.now
let now = Date.UTC(2026, 9, 7, 0, 0, 0)
Date.now = () => now
for (const name of envNames) delete process.env[name]
process.env.SESSION_SIGNING_SECRET = testSecret
process.env.NODE_ENV = 'production'

function load(relativePath, dependencies = {}, fetch = () => { throw new Error('Unexpected network call') }) {
  const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText
  const loaded = { exports: {} }
  new Function('module', 'exports', 'require', 'fetch', output)(loaded, loaded.exports,
    (name) => dependencies[name] || require(name), fetch)
  return loaded.exports
}

class FakeNextResponse extends Response {
  constructor(...args) {
    super(...args)
    this.cookieWrites = []
    this.cookies = {
      set: (...values) => this.cookieWrites.push(['set', ...values]),
      delete: (name) => this.cookieWrites.push(['delete', name]),
    }
  }
  static redirect(url, status = 307) { return new FakeNextResponse(null, { status, headers: { Location: String(url) } }) }
  static next() { return new FakeNextResponse() }
  static json(body, init) { return new FakeNextResponse(JSON.stringify(body), init) }
}

async function main() {
  const cookie = load('lib/session-cookie.ts')
  const value = cookie.createSessionCookieValue(userId)
  const parsed = cookie.parseSessionCookieValue(value)
  assert.equal(parsed.userId, userId)
  assert.equal(parsed.issuedAt, now / 1000)
  assert.equal(parsed.expiresAt - parsed.issuedAt, cookie.SESSION_MAX_AGE_SECONDS)
  assert.equal(cookie.isSessionExpired(parsed), false)
  assert.equal(cookie.getSessionCookieOptions().httpOnly, true)
  assert.equal(cookie.getSessionCookieOptions().secure, true)
  assert.throws(() => cookie.createSessionCookieValue('invalid-user'), /valid session user ID/)
  for (const forged of [userId, `v2:${userId}:${now}`, value.replace(userId, otherUserId),
    value + ':extra', value.slice(0, -1), value.replace(/^v3:/, 'v2:'), 'v3:invalid:1:2:signature']) {
    if (forged !== value) assert.equal(cookie.parseSessionCookieValue(forged), null)
  }
  const parts = value.split(':')
  parts[4] = (parts[4][0] === 'a' ? 'b' : 'a') + parts[4].slice(1)
  assert.equal(cookie.parseSessionCookieValue(parts.join(':')), null)
  const lastCharacter = value.at(-1)
  assert.equal(cookie.parseSessionCookieValue(value.slice(0, -1) + (lastCharacter === 'a' ? 'b' : 'a')), null,
    'Reject altered signature text, including noncanonical base64url encodings')

  now = parsed.expiresAt * 1000 - 1000
  assert.equal(cookie.isSessionExpired(parsed), false)
  now += 1000
  assert.equal(cookie.isSessionExpired(parsed), true, 'The server expires a replayed cookie at the boundary')
  now = parsed.issuedAt * 1000 - 61000
  assert.equal(cookie.isSessionExpired(parsed), true, 'Reject future-issued sessions')
  now = parsed.issuedAt * 1000
  process.env.SESSION_SIGNING_SECRET = 'different-test-only-signing-secret-0123456789'
  assert.equal(cookie.parseSessionCookieValue(value), null)
  for (const secret of [undefined, '', 'short']) {
    if (secret === undefined) delete process.env.SESSION_SIGNING_SECRET
    else process.env.SESSION_SIGNING_SECRET = secret
    assert.equal(cookie.parseSessionCookieValue(value), null)
    assert.throws(() => cookie.createSessionCookieValue(userId), /SESSION_SIGNING_SECRET/)
  }
  process.env.SESSION_SIGNING_SECRET = testSecret

  let storedCookie = value
  let fixture = { id: userId, status: 'approved', real_name: '試験担当', display_name: '試験', picture_url: null }
  let userReads = 0
  const cookieWrites = []
  const cookieStore = {
    get: (name) => name === cookie.SESSION_COOKIE_NAME && storedCookie ? { value: storedCookie } : undefined,
    set: (...args) => cookieWrites.push(['set', ...args]),
    delete: (...args) => cookieWrites.push(['delete', ...args]),
  }
  const adminClient = { from(table) {
    assert.equal(table, 'gw_users')
    userReads += 1
    const query = {
      select() { return query }, eq() { return query }, update() { return query },
      single: async () => ({ data: fixture ? structuredClone(fixture) : null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject),
    }
    return query
  } }
  const session = load('lib/session.ts', {
    'next/headers': { cookies: async () => cookieStore },
    '@/lib/session-cookie': cookie,
    '@/lib/supabase/admin': { adminClient },
    '@/lib/line-picture': { normalizeLinePictureUrl: (url) => url },
  })
  for (const invalid of [userId, `v2:${userId}:${now}`, value.replace(userId, otherUserId)]) {
    storedCookie = invalid
    const reads = userReads
    assert.equal(await session.getUserSession(), null)
    assert.equal(userReads, reads, 'Invalid cookies fail before privileged database access')
    assert.equal(cookieWrites.at(-1)[0], 'delete')
  }
  for (const status of ['pending', 'suspended']) {
    storedCookie = value
    fixture.status = status
    const writes = cookieWrites.length
    assert.equal(await session.getUserSession(), null)
    assert.equal(cookieWrites.length, writes, 'Inactive users must not receive a refreshed session')
  }
  fixture.status = 'approved'
  assert.equal((await session.getUserSession()).id, userId)
  assert.equal(cookie.parseSessionCookieValue(cookieWrites.at(-1)[2]).userId, userId)
  fixture = null
  assert.equal(await session.getUserSession(), null)
  fixture = { id: userId, status: 'approved', display_name: '試験担当' }

  const { proxy } = load('proxy.ts', {
    'next/server': { NextResponse: FakeNextResponse }, '@/lib/session-cookie': cookie,
  })
  function request(pathname, sessionValue, extraCookies = {}) {
    const url = new URL(pathname, 'https://test.invalid')
    return { nextUrl: url, url: url.href, headers: new Headers(), cookies: {
      get: (name) => name === cookie.SESSION_COOKIE_NAME
        ? sessionValue ? { value: sessionValue } : undefined
        : extraCookies[name] ? { value: extraCookies[name] } : undefined,
    } }
  }
  for (const invalid of [undefined, userId, `v2:${userId}:${now}`, value.replace(userId, otherUserId)]) {
    const response = proxy(request('/admin', invalid))
    assert.equal(response.status, 307)
    assert.match(response.headers.get('Location'), /\/login\?next=%2Fadmin$/)
    assert.ok(response.cookieWrites.some(([action]) => action === 'delete'))
    assert.ok(!response.cookieWrites.some(([action]) => action === 'set'))
  }
  const approvedProxy = proxy(request('/admin', value))
  assert.equal(approvedProxy.status, 200)
  assert.equal(cookie.parseSessionCookieValue(approvedProxy.cookieWrites[0][2]).userId, userId)
  assert.equal(proxy(request('/api/auth/line', undefined)).status, 200)
  assert.equal(proxy(request('/api/data/v1/execute', undefined)).status, 200,
    'The dedicated bearer route performs its own authentication without a browser cookie')
  for (const similarPath of ['/api/data/v1/execute/child', '/api/data/v1/execute-other', '/api/data/v1/execute/']) {
    assert.equal(proxy(request(similarPath, undefined)).status, 307,
      'The bearer route exemption must match the exact path')
  }
  now += cookie.SESSION_MAX_AGE_SECONDS * 1000
  assert.equal(proxy(request('/admin', value)).status, 307)
  storedCookie = value
  const expiredReads = userReads
  assert.equal(await session.getUserSession(), null)
  assert.equal(userReads, expiredReads)
  now = parsed.issuedAt * 1000

  const device = load('lib/device-login-token.ts')
  const token = device.createDeviceLoginToken(userId)
  assert.equal(device.verifyDeviceLoginToken(token).userId, userId)
  assert.equal(device.verifyDeviceLoginToken(token + '.extra'), null)
  now += 5 * 60 * 1000
  assert.equal(device.verifyDeviceLoginToken(token), null)
  now = parsed.issuedAt * 1000 - 61000
  assert.equal(device.verifyDeviceLoginToken(token), null)
  now = parsed.issuedAt * 1000
  delete process.env.SESSION_SIGNING_SECRET
  assert.equal(device.verifyDeviceLoginToken(token), null)
  assert.throws(() => device.createDeviceLoginToken(userId), /signing secret/)
  process.env.LINE_CHANNEL_SECRET = 'test-only-line-channel-secret-0123456789'
  const legacyPayload = Buffer.from(JSON.stringify({ userId, iat: now })).toString('base64url')
  const legacySignature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET).update(legacyPayload).digest('base64url')
  assert.equal(device.verifyDeviceLoginToken(`${legacyPayload}.${legacySignature}`).userId, userId,
    'Existing correctly signed device links remain valid')
  process.env.SESSION_SIGNING_SECRET = testSecret

  const deviceRoute = load('app/api/auth/device-login/route.ts', {
    'next/server': { NextResponse: FakeNextResponse }, '@/lib/session': session,
    '@/lib/supabase/admin': { adminClient }, '@/lib/device-login-token': device,
  })
  const freshToken = device.createDeviceLoginToken(userId)
  const deviceResponse = await deviceRoute.GET(request(`/api/auth/device-login?token=${freshToken}`))
  assert.match(deviceResponse.headers.get('Location'), /\/settings\?deviceLogin=1$/)
  assert.equal(cookie.parseSessionCookieValue(cookieWrites.at(-1)[2]).userId, userId)
  const beforeForgedDevice = cookieWrites.length
  const invalidDeviceResponse = await deviceRoute.GET(request('/api/auth/device-login?token=invalid'))
  assert.match(invalidDeviceResponse.headers.get('Location'), /error=invalid_request/)
  assert.equal(cookieWrites.length, beforeForgedDevice)
  fixture.status = 'suspended'
  assert.match((await deviceRoute.GET(request(`/api/auth/device-login?token=${freshToken}`))).headers.get('Location'), /account_suspended/)
  assert.equal(cookieWrites.length, beforeForgedDevice)
  fixture.status = 'approved'

  process.env.LINE_CHANNEL_ID = 'test-only-line-channel'
  process.env.LINE_CHANNEL_SECRET = 'test-only-line-channel-secret'
  const lineStartRoute = load('app/api/auth/line/route.ts', {
    'next/server': { NextResponse: FakeNextResponse },
    '@/lib/auth-log': { getAuthFlowId: () => 'test', logAuthEvent: async () => {} },
    '@/lib/line-oauth-state': { createLineOAuthState: () => 'test-only-signed-state' },
  })
  for (const browser of [null, '1', 'true', '0', 'https://attacker.invalid']) {
    const url = new URL('/api/auth/line', 'https://test.invalid')
    url.searchParams.set('next', '/admin?tab=shifts')
    if (browser !== null) url.searchParams.set('browser', browser)
    url.searchParams.set('redirect_uri', 'https://attacker.invalid')
    const response = await lineStartRoute.GET(request(url.pathname + url.search))
    const destination = new URL(response.headers.get('Location'))
    assert.equal(destination.origin, 'https://access.line.me')
    assert.equal(destination.searchParams.get('disable_auto_login'), browser === '1' ? 'true' : null)
    assert.equal(destination.searchParams.get('redirect_uri'), 'https://test.invalid/api/auth/line/callback')
    assert.equal(destination.searchParams.get('state'), 'test-only-signed-state')
    assert.equal(destination.searchParams.get('scope'), 'profile openid')
    assert.ok(response.cookieWrites.some(([action, name, value, options]) => action === 'set'
      && name === 'line_oauth_next' && value === '/admin?tab=shifts' && options.httpOnly && options.sameSite === 'lax'))
    assert.ok(!response.cookieWrites.some(([action, name]) => action === 'set' && name === cookie.SESSION_COOKIE_NAME),
      'Starting browser authentication must not create a user session')
  }

  const lineRoute = load('app/api/auth/line/callback/route.ts', {
    'next/server': { NextResponse: FakeNextResponse }, '@/lib/session-cookie': cookie,
    '@/lib/supabase/admin': { adminClient },
    '@/lib/auth-log': { getAuthFlowId: () => 'test', logAuthEvent: async () => {} },
    '@/lib/line-oauth-state': { verifyLineOAuthState: () => false },
    '@/lib/line-picture': { normalizeLinePictureUrl: (url) => url },
  }, async (url) => ({ ok: true, json: async () => url.includes('/token')
    ? { access_token: 'test-only-line-token' }
    : { userId: 'test-only-line-id', displayName: '試験担当', pictureUrl: null } }))
  const lineRequest = request('/api/auth/line/callback?code=test-code&state=test-state', undefined, { line_oauth_state: 'test-state' })
  const lineResponse = await lineRoute.GET(lineRequest)
  const issued = lineResponse.cookieWrites.find(([action, name]) => action === 'set' && name === cookie.SESSION_COOKIE_NAME)
  assert.ok(issued, 'Verified LINE callback issues a signed session')
  assert.equal(cookie.parseSessionCookieValue(issued[2]).userId, userId)
  fixture.status = 'suspended'
  const suspendedLine = await lineRoute.GET(lineRequest)
  assert.ok(!suspendedLine.cookieWrites.some(([action]) => action === 'set'))
  console.log('Session, proxy, LINE, and device security tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  Date.now = realNow
  for (const name of envNames) {
    if (previousEnv[name] === undefined) delete process.env[name]
    else process.env[name] = previousEnv[name]
  }
})
