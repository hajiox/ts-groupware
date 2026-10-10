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
const logic = load('lib/oem-consultation-notification.ts')
const valid = {
  schemaVersion: 1, event: 'consultation_received',
  sourceKey: 'oem:consultation:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:received:v1',
  leadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', receivedAt: '2026-10-10T15:10:11.000Z',
  companyName: 'サンプル株式会社', productName: 'タイソース', quantityLabel: '400個', estimatedTotalPrice: 140000,
}
const board = { id: logic.OEM_CONSULTATION_BOARD_ID, name: 'NEWブランド館（フロア）', type: 'board' }
const botId = 'f78baef5-d40c-4886-b51d-a02efbf794fe'
const expectedContent = '【OEM見積もり相談・受付】\n新しい相談を受け付けました。受注確定ではありません。\n受付日時：2026/10/11 00:10:11（日本時間）\n会社：サンプル株式会社\n商品：タイソース\n数量：400個\n概算合計：140,000円（税別・試作費別）\n\nOEM相談管理画面\nhttps://oem.aizubrandhall.com/admin/dashboard'
assert.equal(logic.oemConsultationNotification(valid).content, expectedContent)
assert.equal(logic.oemConsultationNotification({ ...valid, receivedAt: '2026-10-11T00:10:11+09:00' }).content, expectedContent)
assert.equal(logic.oemConsultationNotification({ ...valid, leadId: valid.leadId.toUpperCase() }).sourceKey, valid.sourceKey)
assert.match(logic.oemConsultationNotification({ ...valid, estimatedTotalPrice: 0 }).content, /概算合計：0円/)
assert.match(logic.oemConsultationNotification({ ...valid, estimatedTotalPrice: Number.MAX_SAFE_INTEGER }).content, /9,007,199,254,740,991円/)
for (const field of ['companyName', 'productName', 'quantityLabel']) {
  assert.doesNotThrow(() => logic.oemConsultationNotification({ ...valid, [field]: '𠮷'.repeat(200) }))
  assert.throws(() => logic.oemConsultationNotification({ ...valid, [field]: '𠮷'.repeat(201) }), /is invalid/)
  // The caller permits literal strings in these labels. They cannot override the fixed dashboard URL.
  assert.match(logic.oemConsultationNotification({ ...valid, [field]: 'sample@example.com https://example.com' }).content,
    /OEM相談管理画面\nhttps:\/\/oem\.aizubrandhall\.com\/admin\/dashboard$/)
}
assert.doesNotThrow(() => logic.oemConsultationNotification({ ...valid, receivedAt: '2026-02-30T12:00:00Z' }))
for (const patch of [
  { schemaVersion: 2 }, { schemaVersion: '1' }, { event: 'order_confirmed' },
  { leadId: 'bad' }, { sourceKey: 'oem:consultation:other:received:v1' },
  { sourceKey: valid.sourceKey.toUpperCase() }, { receivedAt: '2026-10-10' },
  { receivedAt: '2026-10-10T12:00:00' }, { receivedAt: '2026-10-10T12:00:00.000000000000000000000Z' },
  { receivedAt: '2026-10-10T12:00:00+99:99' }, { receivedAt: '2026-10-10T12:00:00+24:00' },
  { estimatedTotalPrice: -1 }, { estimatedTotalPrice: 1.5 }, { estimatedTotalPrice: '140000' },
  { estimatedTotalPrice: Number.MAX_SAFE_INTEGER + 1 }, { estimatedTotalPrice: NaN },
  { companyName: '' }, { productName: ' ' }, { quantityLabel: 'x'.repeat(201) },
  { companyName: 'A\nB' }, { productName: 'A\u009fB' }, { quantityLabel: 'A\0B' },
  { groupId: board.id }, { user_id: botId }, { content: '自由記載' },
  { dashboardUrl: 'https://example.com' }, { email: 'test@example.com' }, { phone: '000-0000-0000' },
]) {
  assert.throws(() => logic.oemConsultationNotification({ ...valid, ...patch }), /is invalid/)
}
for (const raw of [null, [], {}, 1, 'body']) assert.throws(() => logic.oemConsultationNotification(raw), /is invalid/)
assert.notEqual(logic.oemConsultationNotificationPostId('a'), logic.oemConsultationNotificationPostId('b'))
assert.notEqual(logic.oemConsultationNotificationPostId('a'), load('lib/integration-board-post.ts').boardPostId('a'))

let groups, posts, pushes, calls, writes, race, failure, bot, pushFailure
function reset() {
  groups = [board]; posts = new Map(); pushes = 0; calls = 0; writes = 0
  race = null; failure = null; bot = botId; pushFailure = false
}
reset()
const adminClient = { from(table) {
  calls++
  let operation = 'read', row
  const filters = []
  function execute() {
    if (failure === table || failure === `${table}:${operation}`) {
      return { data: null, error: { message: 'secret-sensitive-storage-value' } }
    }
    if (operation === 'update') { writes++; return { data: null, error: null } }
    if (operation === 'insert') {
      if (race) posts.set(row.id, { ...row, ...race })
      if (posts.has(row.id)) return { data: null, error: { code: '23505' } }
      writes++; posts.set(row.id, { ...row })
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
const route = load('app/api/integrations/oem/consultation-received/route.ts', {
  'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200, headers: options.headers }) } },
  '@/lib/supabase/admin': { adminClient }, '@/lib/tsg-ai': { getTsgUserId: async () => bot },
  '@/lib/oem-consultation-notification': logic,
  '@/lib/web-push': { sendPushNotificationToGroup: async (groupId, poster, payload, postId) => {
    pushes++
    assert.equal(groupId, board.id); assert.equal(poster, botId)
    assert.equal(posts.get(postId).group_id, groupId)
    assert.equal(payload.url, `/board/${groupId}#post-${postId}`)
    assert.equal(payload.body, '新しいOEM見積もり相談を受け付けました。掲示板で確認してください。')
    if (pushFailure) throw new Error('secret-sensitive-push-value')
  } },
})
const headers = { authorization: 'Bearer oem-test-only-secret', 'content-type': 'application/json' }
const url = 'http://localhost/api/integrations/oem/consultation-received'
function request(body = valid, auth = headers) {
  return new Request(url, { method: 'POST', headers: auth,
    body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) })
}
function get(query = '', auth = headers) {
  const nextUrl = new URL(`${url}${query}`)
  return Object.assign(new Request(nextUrl, { headers: auth }), { nextUrl })
}
async function main() {
  const proxy = load('proxy.ts', {
    'next/server': { NextResponse: {
      next: () => ({ next: true }), redirect: () => ({ redirect: true, cookies: { delete() {} } }),
    } },
    '@/lib/session-cookie': { SESSION_COOKIE_NAME: 'session', parseSessionCookieValue: () => null },
  }).proxy
  const oldVercelEnv = process.env.VERCEL_ENV
  delete process.env.VERCEL_ENV
  for (const [path, allowed] of [['/api/integrations/oem/consultation-received', true],
    ['/api/integrations/oem/consultation-received/other', false], ['/api/integrations/oem/other', false], ['/api/posts', false]]) {
    const nextUrl = new URL(`http://localhost${path}`)
    assert.equal(Boolean(proxy({ nextUrl, url: nextUrl.href, cookies: { get() {} } }).next), allowed)
  }
  if (oldVercelEnv !== undefined) process.env.VERCEL_ENV = oldVercelEnv
  process.env.OEM_CONSULTATION_INTEGRATION_SECRET = 'oem-test-only-secret'
  process.env.TSG_INTEGRATION_SECRET = 'shared-test-only-secret'
  process.env.MEETING_TRANSCRIBER_INTEGRATION_SECRET = 'meeting-test-only-secret'
  for (const auth of [{}, { authorization: 'Bearer wrong' },
    { 'x-tsg-integration-secret': 'oem-test-only-secret' }, { authorization: 'Bearer shared-test-only-secret' },
    { authorization: 'Bearer meeting-test-only-secret' }, { cookie: 'session=not-a-service-secret' }]) {
    assert.equal((await route.POST(request(valid, auth))).status, 401)
    assert.equal((await route.GET(get('', auth))).status, 401)
  }
  assert.equal(calls, 0)
  delete process.env.OEM_CONSULTATION_INTEGRATION_SECRET
  assert.equal((await route.POST(request())).status, 503)
  assert.equal((await route.GET(get())).status, 503)
  assert.equal(calls, 0)
  process.env.OEM_CONSULTATION_INTEGRATION_SECRET = 'oem-test-only-secret'
  for (const raw of ['{', [], { ...valid, boardId: board.id }, new Uint8Array([0xff]), { ...valid, estimatedTotalPrice: -1 }]) {
    assert.equal((await route.POST(request(raw))).status, 400)
  }
  assert.equal((await route.POST(request('x'.repeat(4097)))).status, 413)
  assert.equal((await route.GET(get('?boardId=x'))).status, 400)
  assert.equal(calls, 0)
  const ready = await route.GET(get())
  assert.equal(ready.status, 200); assert.equal(ready.body.success, true)
  assert.equal(ready.body.group.id, board.id); assert.equal(ready.body.poster.id, botId)
  assert.equal(ready.headers['Cache-Control'], 'no-store'); assert.equal(writes, 0); assert.equal(pushes, 0)
  assert.equal((await route.POST(request({ ...valid, companyName: '𠮷'.repeat(200),
    productName: '𠮷'.repeat(200), quantityLabel: '𠮷'.repeat(200) }))).status, 201)
  reset()
  const first = await route.POST(request())
  assert.deepEqual(first.body, { success: true, postId: logic.oemConsultationNotificationPostId(valid.sourceKey), duplicate: false })
  assert.equal(first.status, 201); assert.equal(first.headers['Cache-Control'], 'no-store')
  const saved = posts.get(first.body.postId)
  assert.equal(saved.group_id, board.id); assert.equal(saved.user_id, botId); assert.equal(saved.content, expectedContent)
  assert.deepEqual(saved.attachments, []); assert.equal(saved.parent_id, null); assert.equal(pushes, 1); assert.equal(posts.size, 1)
  const duplicate = await route.POST(request())
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true); assert.equal(pushes, 1)
  for (const patch of [{ companyName: '別会社' }, { productName: '別商品' }, { quantityLabel: '500個' },
    { estimatedTotalPrice: 150000 }, { receivedAt: '2026-10-10T15:10:12Z' }]) {
    assert.equal((await route.POST(request({ ...valid, ...patch }))).status, 409)
  }
  assert.equal(posts.size, 1); assert.equal(pushes, 1)
  reset(); race = {}
  assert.equal((await route.POST(request())).status, 200); assert.equal(pushes, 0)
  for (const conflict of [{ content: '競合本文' }, { group_id: 'other-board' }, { user_id: 'forged' }]) {
    reset(); race = conflict
    assert.equal((await route.POST(request())).status, 409); assert.equal(pushes, 0)
  }
  reset()
  const results = await Promise.all([route.POST(request()), route.POST(request())])
  assert.deepEqual(results.map(result => result.status).sort(), [200, 201]); assert.equal(pushes, 1); assert.equal(posts.size, 1)
  const originalError = console.error, logs = []
  console.error = (...args) => logs.push(args.join(' '))
  try {
    reset(); failure = 'gw_groups'
    assert.equal((await route.POST(request())).status, 500)
    assert.equal((await route.GET(get())).status, 503)
    reset(); groups = [{ ...board, type: 'chat' }]
    assert.equal((await route.POST(request())).status, 500); assert.equal(writes, 0)
    reset(); bot = null
    assert.equal((await route.POST(request())).status, 500); assert.equal(writes, 0)
    reset(); failure = 'gw_posts:insert'
    assert.equal((await route.POST(request())).status, 500); assert.equal(pushes, 0)
    reset(); failure = 'gw_groups:update'
    assert.equal((await route.POST(request())).status, 201); assert.equal(pushes, 1)
    reset(); pushFailure = true
    assert.equal((await route.POST(request())).status, 201)
    assert.equal((await route.POST(request())).status, 200); assert.equal(pushes, 1)
    assert.doesNotMatch(logs.join('\n'), /secret-sensitive|oem-test-only-secret|サンプル株式会社|タイソース/)
  } finally { console.error = originalError }
  console.log('OEM consultation auth, strict schema, JST content, locked destination, readiness, duplicate/conflict, concurrency, push failure and sanitized diagnostics passed (no live posts).')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
