const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

// No credentials, database, Drive client, or network are loaded by this harness.
const memberId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const groupId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const postId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const testEnv = { SESSION_SIGNING_SECRET: 'test-only-drive-boundary-secret-0123456789abcdef', NODE_ENV: 'production' }
let sideEffects = 0
function forbidden() { sideEffects++; throw new Error('Unexpected database, Drive, or network access') }
const blockedService = new Proxy({}, { get: () => forbidden })

class FakeNextResponse extends Response {
  constructor(...args) {
    super(...args)
    this.cookies = { set() {}, delete() {} }
  }
  static json(value, init) { return new FakeNextResponse(JSON.stringify(value), init) }
  static redirect(url, status = 307) { return new FakeNextResponse(null, { status, headers: { Location: String(url) } }) }
  static next() { return new FakeNextResponse() }
}

function load(relativePath, dependencies = {}, fetchMock = forbidden) {
  const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText
  const loaded = { exports: {} }
  new Function('module', 'exports', 'require', 'fetch', 'process', output)(loaded, loaded.exports,
    (name) => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name]
      if (name.startsWith('node:')) return require(name)
      throw new Error(`Unmocked import ${name}`)
    }, fetchMock, { env: testEnv })
  return loaded.exports
}

function request(route, headers = {}, body = {}) {
  const url = new URL(route, 'https://tsg.example.invalid')
  return { url: String(url), nextUrl: url, headers: new Headers(headers), cookies: { get() {} },
    json: async () => body, formData: forbidden }
}

function readOnlyClient(hasMembership) {
  return {
    from(table) {
      const data = table === 'gw_posts'
        ? { id: postId, user_id: otherId, group_id: groupId, attachments: [], parent_id: null }
        : table === 'gw_group_members' ? (hasMembership ? { user_id: memberId, role: 'member' } : null)
          : { id: groupId, type: 'chat', description: '', posting_disabled: false }
      const query = { select() { return query }, eq() { return query },
        single: async () => ({ data, error: null }), maybeSingle: async () => ({ data, error: null }),
        insert: forbidden, update: forbidden, delete: forbidden, upsert: forbidden }
      return query
    },
  }
}

async function main() {
  const cookie = load('lib/session-cookie.ts')
  const roles = load('lib/user-roles.ts')
  const anonymousSession = load('lib/session.ts', {
    'next/headers': { cookies: async () => ({ get() {}, set: forbidden, delete() {} }) },
    '@/lib/session-cookie': cookie,
    '@/lib/supabase/admin': { adminClient: blockedService },
    '@/lib/line-picture': { normalizeLinePictureUrl: forbidden },
  })
  const common = {
    'next/server': { NextResponse: FakeNextResponse },
    '@/lib/session': anonymousSession,
    '@/lib/supabase/admin': { adminClient: blockedService },
    '@/lib/drive': blockedService,
    '@/lib/read-status': blockedService,
    '@/lib/mention-names': blockedService,
    '@/lib/user-roles': roles,
    '@/lib/pledge-paper': blockedService,
    '@/lib/pledges': blockedService,
    '@/lib/hr-resume-service': blockedService,
    '@/lib/management-permissions': blockedService,
  }
  const { proxy } = load('proxy.ts', { 'next/server': common['next/server'], '@/lib/session-cookie': cookie })
  const cases = [
    ['app/api/posts/route.ts', '/api/posts', ['GET', 'POST', 'PATCH', 'DELETE']],
    ['app/api/chat/route.ts', '/api/chat', ['GET', 'POST', 'PATCH', 'DELETE']],
    ['app/api/upload/route.ts', '/api/upload', ['POST']],
    ['app/api/image-proxy/route.ts', '/api/image-proxy', ['GET']],
    ['app/api/admin/pledges/paper/route.ts', '/api/admin/pledges/paper', ['GET', 'POST']],
    ['app/api/admin/hr/resumes/route.ts', '/api/admin/hr/resumes', ['GET', 'POST', 'PUT', 'DELETE']],
  ]
  let rejected = 0
  for (const [source, route, methods] of cases) {
    const api = load(source, common)
    for (const headers of [{}, { Authorization: `Bearer tsg_data_${'x'.repeat(43)}` },
      { 'x-tsg-integration-secret': 'test-only-unrelated-bridge-key' }]) {
      assert.equal(proxy(request(route, headers)).status, 307)
      for (const method of methods) {
        assert.equal((await api[method](request(route, headers))).status, 401,
          `${route} ${method} must require a signed browser session`)
        rejected++
      }
    }
  }
  assert.equal(sideEffects, 0)

  // These authenticated negative cases only execute mocked SELECTs.
  const memberSession = { getUserSession: async () => ({ id: memberId, role: 'member', status: 'approved' }) }
  for (const source of ['app/api/posts/route.ts', 'app/api/chat/route.ts']) {
    for (const hasMembership of [false, true]) {
      const api = load(source, { ...common, '@/lib/session': memberSession,
        '@/lib/supabase/admin': { adminClient: readOnlyClient(hasMembership) } })
      const key = source.includes('/posts/') ? 'post_id' : 'message_id'
      assert.equal((await api.DELETE(request(`/api/review?${key}=${postId}`))).status, 403)
    }
  }
  const paper = load('app/api/admin/pledges/paper/route.ts', { ...common, '@/lib/session': memberSession })
  assert.equal((await paper.GET(request('/api/admin/pledges/paper?assignment_id=fake'))).status, 403)
  let upstreamCalls = 0
  const image = load('app/api/image-proxy/route.ts', { ...common, '@/lib/session': memberSession }, async (url, options) => {
    upstreamCalls++
    assert.equal(url, 'https://drive.google.com/uc?id=synthetic-private-file')
    assert.deepEqual(options, { cache: 'no-store' }, 'The image proxy must not add a Drive credential or browser cookie')
    return new Response(null, { status: 404 })
  })
  assert.equal((await image.GET(request('/api/image-proxy?url=https%3A%2F%2Fdrive.google.com%2Fuc%3Fid%3Dsynthetic-private-file'))).status, 404)
  assert.equal(upstreamCalls, 1)
  assert.equal(sideEffects, 0)
  console.log(`Drive access boundary passed: ${rejected} anonymous/key-only route refusals; member refusals; no real database, Drive, upload, delete, or network calls`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
