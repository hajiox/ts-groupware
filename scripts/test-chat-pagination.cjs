const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
function load(file, dependencies = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText
  const loaded = { exports: {} }
  new Function('module', 'exports', 'require', output)(loaded, loaded.exports, name => {
    assert.ok(dependencies[name], `Unexpected dependency: ${name}`)
    return dependencies[name]
  })
  return loaded.exports
}

const pagination = load('lib/chat-pagination.ts')
const groupId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const message = (n, created_at = '2026-10-01T00:00:00.123456+00:00') => ({
  id: uuid(n), group_id: groupId, user_id: actorId, parent_id: null,
  content: `Synthetic message ${n}`, attachments: [], created_at, updated_at: created_at,
})
let rows = Array.from({ length: 250 }, (_, i) => message(i + 1, i < 140
  ? '2026-10-01T00:00:00.123456+00:00'
  : `2026-10-01T00:00:01.${String(i).padStart(6, '0')}+00:00`))
rows.push({ ...message(999), group_id: uuid(999) }, { ...message(998), parent_id: uuid(997) })
let authenticated = true
let member = true
const role = 'staff'
let queryError = false
const postQueries = []
let markedRead = 0
function query(table) {
  const state = { table, eq: {}, is: {}, orders: [], limit: Infinity, gt: null, or: null }
  const chain = {
    select() { return chain },
    eq(key, value) { state.eq[key] = value; return chain },
    is(key, value) { state.is[key] = value; return chain },
    in() { return chain },
    order(key, options) { state.orders.push({ key, ...options }); return chain },
    limit(value) { state.limit = value; return chain },
    gt(key, value) { state.gt = { key, value }; return chain },
    or(value) { state.or = value; return chain },
    single() { return Promise.resolve(result()) },
    then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject) },
  }
  function result() {
    if (table === 'gw_groups') return { data: { id: state.eq.id, type: 'chat', name: 'Synthetic chat' } }
    if (table === 'gw_group_members') return { data: state.eq.user_id ? (member ? { role: 'member' } : null) : [{ user_id: actorId, role: 'member' }] }
    if (table === 'gw_read_status') return { data: [] }
    if (table === 'gw_users') return { data: [{ id: actorId, display_name: 'Synthetic user', role: 'staff' }] }
    if (table === 'gw_reactions') return { data: [] }
    assert.equal(table, 'gw_posts')
    postQueries.push(state)
    if (queryError) return { data: null, error: { message: 'Synthetic database failure' } }
    let resultRows = rows.filter(row => Object.entries(state.eq).every(([key, value]) => row[key] === value)
      && Object.entries(state.is).every(([key, value]) => row[key] === value))
    if (state.gt) resultRows = resultRows.filter(row => Date.parse(row[state.gt.key]) > Date.parse(state.gt.value))
    if (state.or) {
      const match = state.or.match(/^created_at\.(lt|gt)\.([^,]+),and\(created_at\.eq\.([^,]+),id\.\1\.([0-9a-f-]+)\)$/)
      assert.ok(match, 'The cursor filter must use only the validated timestamp and UUID')
      assert.equal(match[2], match[3])
      const cursor = { created_at: match[2], id: match[4] }
      resultRows = resultRows.filter(row => match[1] === 'lt'
        ? pagination.compareChatMessages(row, cursor) < 0
        : pagination.compareChatMessages(row, cursor) > 0)
    }
    assert.deepEqual(state.orders, [
      { key: 'created_at', ascending: state.orders[0].ascending },
      { key: 'id', ascending: state.orders[0].ascending },
    ])
    resultRows.sort((a, b) => pagination.compareChatMessages(a, b) * (state.orders[0].ascending ? 1 : -1))
    return { data: resultRows.slice(0, state.limit), error: null }
  }
  return chain
}

class FakeNextResponse extends Response {
  static json(value, init) { return new FakeNextResponse(JSON.stringify(value), init) }
}
const route = load('app/api/chat/route.ts', {
  'next/server': { NextResponse: FakeNextResponse },
  '@/lib/supabase/admin': { adminClient: { from: query } },
  '@/lib/session': { getUserSession: async () => authenticated ? { id: actorId, role } : null },
  '@/lib/read-status': { markGroupRead: async () => { markedRead++; return {} } },
  '@/lib/drive': {},
  '@/lib/mention-names': {},
  '@/lib/user-roles': { isManagementRole: role => ['admin', 'executive'].includes(role) },
  '@/lib/codex-mtg-policy': { isCodexMtgGroup: id => id === 'a8081dbe-15db-4d41-a18b-b22bb55d2b39' },
  '@/lib/business-api/posting': {},
  '@/lib/business-api/context': {},
  '@/lib/chat-pagination': pagination,
})
const get = query => route.GET({ nextUrl: new URL(`https://example.invalid/api/chat?${new URLSearchParams({ group_id: groupId, ...query })}`) })
async function ok(query) {
  const response = await get(query)
  assert.equal(response.status, 200)
  return response.json()
}

async function main() {
  authenticated = false
  assert.equal((await get({})).status, 401)
  authenticated = true
  member = false
  assert.equal((await get({})).status, 403)
  member = true
  assert.equal((await get({ group_id: 'a8081dbe-15db-4d41-a18b-b22bb55d2b39' })).status, 403)
  assert.equal(postQueries.length, 0, 'Unauthorized readers must never query message history')

  for (const query of [
    { before: 'not-a-cursor' },
    { before: pagination.encodeChatCursor({ id: uuid(1), created_at: 'x),content.neq.secret' }) },
    { before: pagination.encodeChatCursor({ id: 'x),content.neq.secret', created_at: rows[0].created_at }) },
    { before: pagination.encodeChatCursor(rows[0]), after: pagination.encodeChatCursor(rows[0]) },
    { before: pagination.encodeChatCursor(rows[0]), since: rows[0].created_at },
    { since: 'not-a-date' },
  ]) assert.equal((await get(query)).status, 400)
  assert.equal(postQueries.length, 0, 'Invalid cursors must never reach the message query')

  const first = await ok({})
  assert.equal(first.messages.length, 80)
  assert.equal(postQueries.at(-1).limit, 81)
  assert.equal(first.pagination.hasMore, true)
  const found = [...first.messages]
  let page = first
  // Delete an already displayed cursor row and insert a newer post between
  // requests. Keyset paging must still include every older row exactly once.
  rows = rows.filter(row => row.id !== first.messages[0].id)
  rows.push(message(1000, '2026-10-03T00:00:00+00:00'))
  while (page.pagination.hasMore) {
    page = await ok({ before: page.pagination.nextCursor })
    found.unshift(...page.messages)
  }
  assert.equal(found.length, 250)
  assert.equal(new Set(found.map(row => row.id)).size, 250)
  assert.deepEqual(found.map(row => row.id), Array.from({ length: 250 }, (_, i) => uuid(i + 1)))
  assert.equal(page.pagination.nextCursor, null)
  assert.equal((await ok({ before: page.pagination.oldestCursor })).messages.length, 0)

  const newest = await ok({})
  const added = Array.from({ length: 205 }, (_, i) => message(2000 + i, '2026-10-04T00:00:00.000001+00:00'))
  rows.push(...added)
  let cursor = newest.pagination.newestCursor
  const received = []
  do {
    page = await ok({ after: cursor, limit: '100' })
    received.push(...page.messages)
    cursor = page.pagination.newestCursor
  } while (page.pagination.hasMore)
  assert.deepEqual(received.map(row => row.id), added.map(row => row.id), 'Same-timestamp new posts spanning pages must not be skipped')
  assert.equal((await ok({ after: cursor })).messages.length, 0)

  const legacy = await ok({ since: '2026-10-03T00:00:00+00:00', limit: '999' })
  assert.equal(legacy.messages.length, 100)
  assert.equal(postQueries.at(-1).limit, 101)
  assert.equal((await ok({ limit: '-50' })).messages.length, 1)
  const roundTrip = pagination.decodeChatCursor(pagination.encodeChatCursor(rows[0]))
  assert.deepEqual(roundTrip, { id: rows[0].id, created_at: rows[0].created_at })
  assert.ok(pagination.compareChatMessages(message(5, '2026-10-01T00:00:00.123455Z'), message(1, '2026-10-01T00:00:00.123456Z')) < 0)

  queryError = true
  const readsBeforeError = markedRead
  assert.equal((await get({ before: first.pagination.oldestCursor })).status, 500)
  assert.equal(markedRead, readsBeforeError)
  console.log('Chat pagination: access controls, cursor validation, 250 historical posts, deleted anchors, 205 tied new posts, legacy since and bounds passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
