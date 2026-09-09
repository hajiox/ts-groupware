const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
function load(file, dependencies = {}) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const loaded = { exports: {} }
  new Function('module', 'exports', 'require', output)(loaded, loaded.exports, name => dependencies[name] || require(name))
  return loaded.exports
}
const logic = load('lib/integration-board-post.ts')
const boardA = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'TS（管理職）', type: 'board' }
const boardB = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'フロア', type: 'board' }
const chat = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: '個人DM', type: 'chat' }
const valid = { sourceKey: 'codex:example:report:v1', boardName: boardA.name, content: ' 本文\n改行を保持します。 ' }
assert.equal(logic.boardPostInput(valid).content, valid.content)
for (const patch of [{ sourceKey: 'x/y' }, { content: '' }, { content: ' ' }, { content: 'x'.repeat(10001) },
  { content: 'a\0b' }, { boardName: '' }, { boardId: boardA.id }, { poster: '別人' }, { attachments: [] }, { parent_id: 'x' }]) {
  assert.throws(() => logic.boardPostInput({ ...valid, ...patch }), /is invalid/)
}
for (const body of [null, [], {}, { sourceKey: 'a', content: 'a' }, { sourceKey: 'a', content: 'a', boardId: 'bad' }]) {
  assert.throws(() => logic.boardPostInput(body), /is invalid/)
}
assert.equal(logic.boardPostInput({ ...valid, content: 'あ'.repeat(10000) }).content.length, 10000)
assert.notEqual(logic.boardPostId('a'), logic.boardPostId('b'))
assert.notEqual(logic.boardPostId('a'), load('lib/carrier-import-alert.ts').carrierImportAlertPostId('a'))

let groups, posts, pushes, calls, writes, race, failure, bot
function reset() {
  groups = [boardA, boardB, chat]; posts = new Map(); pushes = 0; calls = 0; writes = 0
  race = null; failure = null; bot = 'tsg-bot'
}
reset()
const adminClient = { from(table) {
  calls++
  let operation = 'read', row
  const filters = []
  function execute() {
    if (failure === table) return { data: null, error: { message: 'mock storage unavailable' } }
    if (operation === 'update') { writes++; return { data: null, error: null } }
    if (operation === 'insert') {
      if (race) posts.set(row.id, { ...row, ...race, created_at: '2026-09-09T00:00:00Z' })
      if (posts.has(row.id)) return { data: null, error: { code: '23505' } }
      writes++; posts.set(row.id, { ...row, created_at: '2026-09-09T00:00:00Z' })
      return { data: posts.get(row.id), error: null }
    }
    const rows = table === 'gw_groups' ? groups : [...posts.values()]
    return { data: rows.filter(item => filters.every(([key, value]) => item[key] === value)), error: null }
  }
  const query = {
    select() { return query }, eq(key, value) { filters.push([key, value]); return query },
    insert(value) { operation = 'insert'; row = value; return query }, update() { operation = 'update'; return query },
    async maybeSingle() { const result = execute(); return { ...result, data: result.data?.[0] || null } },
    async single() { const result = execute(); return { ...result, data: Array.isArray(result.data) ? result.data[0] || null : result.data } },
    then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject) },
  }
  return query
} }
const route = load('app/api/integrations/board-post/route.ts', {
  'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200, headers: options.headers }) } },
  '@/lib/supabase/admin': { adminClient }, '@/lib/tsg-ai': { getTsgUserId: async () => bot },
  '@/lib/integration-board-post': logic,
  '@/lib/web-push': { sendPushNotificationToGroup: async (groupId, poster, payload, postId) => {
    assert.equal(poster, 'tsg-bot'); assert.equal(posts.get(postId).group_id, groupId)
    assert.equal(payload.url, `/board/${groupId}#post-${postId}`); pushes++
  } },
})
const headers = { 'x-tsg-integration-secret': 'test-only-secret' }
function request(body, auth = headers) {
  return new Request('http://localhost/api/integrations/board-post', {
    method: 'POST', headers: auth, body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
  })
}
function get(query, auth = headers) { return new Request(`http://localhost/api/integrations/board-post?${query}`, { headers: auth }) }
async function main() {
  const proxy = load('proxy.ts', {
    'next/server': { NextResponse: {
      next: () => ({ next: true }),
      redirect: () => ({ redirect: true, cookies: { delete() {} } }),
    } },
    '@/lib/session-cookie': { SESSION_COOKIE_NAME: 'session', parseSessionCookieValue: () => null },
  }).proxy
  const previousVercelEnv = process.env.VERCEL_ENV
  delete process.env.VERCEL_ENV
  for (const [path, allowed] of [['/api/integrations/board-post', true], ['/api/integrations/board-post/other', false], ['/api/posts', false]]) {
    const url = new URL(`http://localhost${path}`)
    assert.equal(Boolean(proxy({ nextUrl: url, url: url.href, cookies: { get() {} } }).next), allowed)
  }
  if (previousVercelEnv !== undefined) process.env.VERCEL_ENV = previousVercelEnv
  process.env.TSG_INTEGRATION_SECRET = 'test-only-secret'
  assert.equal((await route.POST(request(valid, {}))).status, 401)
  assert.equal((await route.GET(get('', {}))).status, 401)
  assert.equal(calls, 0)
  delete process.env.TSG_INTEGRATION_SECRET
  assert.equal((await route.POST(request(valid))).status, 500); assert.equal(calls, 0)
  process.env.TSG_INTEGRATION_SECRET = 'test-only-secret'
  for (const body of ['{', [], { ...valid, user_id: 'forged' }, new Uint8Array([0xff])]) {
    assert.equal((await route.POST(request(body))).status, 400)
  }
  assert.equal((await route.POST(request('x'.repeat(65537)))).status, 413)
  assert.equal(calls, 0)
  for (const query of ['', 'boardId=bad', `boardId=${boardA.id}&boardName=x`, 'boardName=x&boardName=y', 'boardName=x&poster=y']) {
    assert.equal((await route.GET(get(query))).status, 400)
  }
  const ready = await route.GET(get(`boardId=${boardA.id}`, { authorization: 'Bearer test-only-secret' }))
  assert.equal(ready.status, 200); assert.equal(ready.body.group.id, boardA.id)
  assert.equal(ready.headers['Cache-Control'], 'no-store'); assert.equal(writes, 0)
  for (const name of [chat.name, '存在しない掲示板']) {
    assert.equal((await route.POST(request({ ...valid, boardName: name }))).status, 404)
  }
  assert.equal((await route.GET(get(`boardId=${chat.id}`))).status, 404)
  groups.push({ ...boardB, name: boardA.name })
  assert.equal((await route.POST(request(valid))).status, 409)
  groups.pop(); assert.equal(writes, 0)
  const first = await route.POST(request(valid))
  assert.equal(first.status, 201); assert.equal(first.body.duplicate, false)
  assert.equal(first.body.poster.displayName, 'TSG君'); assert.equal(first.body.post.user_id, 'tsg-bot')
  assert.equal(first.body.post.content, valid.content); assert.equal(first.body.group.id, boardA.id)
  assert.equal(pushes, 1); assert.equal(posts.size, 1)
  const duplicate = await route.POST(request({ sourceKey: valid.sourceKey, content: valid.content, boardId: boardA.id }))
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true); assert.equal(pushes, 1)
  for (const patch of [{ content: '変更' }, { boardName: boardB.name }]) {
    assert.equal((await route.POST(request({ ...valid, ...patch }))).status, 409)
  }
  assert.equal(pushes, 1); assert.equal(posts.size, 1)
  reset(); race = {}
  assert.equal((await route.POST(request(valid))).status, 200); assert.equal(pushes, 0)
  reset(); race = { content: '競合本文' }
  assert.equal((await route.POST(request(valid))).status, 409); assert.equal(pushes, 0)
  reset()
  const results = await Promise.all([route.POST(request(valid)), route.POST(request(valid))])
  assert.deepEqual(results.map(result => result.status).sort(), [200, 201]); assert.equal(pushes, 1)
  reset(); failure = 'gw_groups'
  const originalError = console.error
  console.error = () => {}
  try {
    assert.equal((await route.POST(request(valid))).status, 500)
    assert.equal((await route.GET(get(`boardId=${boardA.id}`))).status, 503)
    reset(); bot = null
    assert.equal((await route.POST(request(valid))).status, 500); assert.equal(writes, 0)
  } finally { console.error = originalError }
  console.log('Board API validation, auth, board-only resolution, readiness, exact content, duplicate/conflict, concurrency and failure tests passed (no live posts).')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
