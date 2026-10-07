const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const postId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const groupId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const authorId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
let authenticated = true
let member = true
let existingReaction = false
let postExists = true
let readError = null
const reads = []
const writes = []
const pushes = []

function query(table) {
  reads.push(table)
  const filters = {}
  let mutation = null
  const chain = {
    select() { return chain },
    eq(column, value) { filters[column] = value; return chain },
    insert(value) { mutation = ['insert', value]; return chain },
    delete() { mutation = ['delete']; return chain },
    single() { return Promise.resolve(result()) },
    maybeSingle() { return Promise.resolve(result()) },
    then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject) },
  }
  function result() {
    if (mutation) {
      writes.push({ table, mutation, filters })
      return { data: null, error: null }
    }
    if (readError === table) return { data: null, error: { message: 'Synthetic membership read failure' } }
    if (table === 'gw_posts') return { data: postExists
      ? { id: postId, user_id: authorId, group_id: groupId, content: '試験投稿', parent_id: null }
      : null, error: null }
    if (table === 'gw_group_members') {
      assert.equal(filters.group_id, groupId)
      assert.equal(filters.user_id, actorId)
      return { data: member ? { user_id: actorId } : null, error: null }
    }
    if (table === 'gw_reactions') return { data: existingReaction ? { id: 'test-reaction' } : null, error: null }
    if (table === 'gw_groups') return { data: { type: 'board' }, error: null }
    throw new Error(`Unexpected table: ${table}`)
  }
  return chain
}

class FakeNextResponse extends Response {
  static json(value, init) { return new FakeNextResponse(JSON.stringify(value), init) }
}
const dependencies = {
  'next/server': { NextResponse: FakeNextResponse },
  '@/lib/session': { getUserSession: async () => authenticated ? { id: actorId, display_name: '試験担当' } : null },
  '@/lib/supabase/admin': { adminClient: { from: query } },
  '@/lib/web-push': { sendPushNotificationToUser: async (...args) => pushes.push(args) },
}
const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'reactions', 'route.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText
const loaded = { exports: {} }
new Function('module', 'exports', 'require', output)(loaded, loaded.exports, (name) => {
  assert.ok(dependencies[name], `Unexpected dependency: ${name}`)
  return dependencies[name]
})
const request = () => ({ json: async () => ({ post_id: postId, emoji: '👍' }) })

async function main() {
  authenticated = false
  assert.equal((await loaded.exports.POST(request())).status, 401)
  assert.equal(reads.length, 0)
  authenticated = true

  for (const hasExistingReaction of [false, true]) {
    member = false
    existingReaction = hasExistingReaction
    const before = reads.length
    assert.equal((await loaded.exports.POST(request())).status, 403)
    assert.ok(!reads.slice(before).includes('gw_reactions'), 'Check membership before either toggle mutation')
    assert.equal(writes.length, 0)
    assert.equal(pushes.length, 0)
  }

  postExists = false
  assert.equal((await loaded.exports.POST(request())).status, 404)
  assert.equal(writes.length, 0)
  postExists = true
  for (const table of ['gw_posts', 'gw_group_members']) {
    readError = table
    assert.equal((await loaded.exports.POST(request())).status, 500)
    assert.equal(writes.length, 0, 'Database access failures must fail closed')
    assert.equal(pushes.length, 0)
  }
  readError = null
  member = true
  existingReaction = false
  assert.equal((await loaded.exports.POST(request())).status, 201)
  assert.deepEqual(writes[0], {
    table: 'gw_reactions', mutation: ['insert', { post_id: postId, user_id: actorId, emoji: '👍' }], filters: {},
  })
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0][0], authorId)
  existingReaction = true
  const removed = await loaded.exports.POST(request())
  assert.equal(removed.status, 200)
  assert.deepEqual(await removed.json(), { action: 'removed' })
  assert.deepEqual(writes[1], { table: 'gw_reactions', mutation: ['delete'], filters: { id: 'test-reaction' } })
  assert.equal(pushes.length, 1, 'Removing a reaction does not notify its author')
  console.log('Reaction membership access tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
