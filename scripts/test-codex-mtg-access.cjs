const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function load(file, dependencies = {}) {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const loaded = { exports: {} }
  new Function('module', 'exports', 'require', source)(loaded, loaded.exports, name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
    return dependencies[name]
  })
  return loaded.exports
}

const policy = load('lib/codex-mtg-policy.ts')
const roles = load('lib/user-roles.ts')
const mtgId = policy.CODEX_MTG_GROUP_ID
const botId = policy.CODEX_MTG_BOT_USER_ID
const normalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const managerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const staffId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const postId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
let actor
let tables
let writes
let reads
let pushes

function reset(role = 'member') {
  actor = { id: actorId, role, status: 'approved', display_name: '試験担当' }
  tables = {
    gw_users: [actor, { id: managerId, role: 'admin', status: 'approved', display_name: '試験管理職' },
      { id: staffId, role: 'member', status: 'approved', display_name: '試験一般社員' },
      { id: botId, role: 'member', status: 'approved', display_name: 'TSG君' }],
    gw_groups: [{ id: mtgId, name: 'CodexMTG', type: 'chat', description: '', created_at: '2026-10-08T00:00:00Z' },
      { id: normalId, name: '通常Chat', type: 'chat', description: '', created_at: '2026-10-08T00:00:00Z' }],
    gw_group_members: [{ group_id: mtgId, user_id: actorId, role: 'member' },
      { group_id: normalId, user_id: actorId, role: 'member' }],
    gw_posts: [{ id: postId, group_id: mtgId, user_id: actorId, content: '非公開の依頼',
      attachments: [], parent_id: null, created_at: '2026-10-08T00:01:00Z' }],
    gw_reactions: [], gw_read_status: [], gw_tasks: [], gw_mentions: [],
  }
  writes = []; reads = []; pushes = []
}

function same(a, b) {
  return typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function query(table) {
  assert.ok(Object.hasOwn(tables, table), `Unexpected table: ${table}`)
  reads.push(table)
  const filters = []
  let mutation
  let values
  const chain = {
    select() { return chain }, order() { return chain }, limit() { return chain },
    eq(key, value) { filters.push(row => same(row[key], value)); return chain },
    neq(key, value) { filters.push(row => !same(row[key], value)); return chain },
    in(key, entries) { filters.push(row => entries.some(value => same(row[key], value))); return chain },
    is(key, value) { filters.push(row => value === null ? row[key] == null : row[key] === value); return chain },
    or() { filters.push(row => row.status === 'approved' || row.status == null); return chain },
    insert(value) { mutation = 'insert'; values = value; return chain },
    upsert(value) { mutation = 'upsert'; values = value; return chain },
    update(value) { mutation = 'update'; values = value; return chain },
    delete() { mutation = 'delete'; return chain },
    single() { return Promise.resolve(result(true)) },
    maybeSingle() { return Promise.resolve(result(true)) },
    then(resolve, reject) { return Promise.resolve(result(false)).then(resolve, reject) },
  }
  function result(single) {
    let rows = tables[table].filter(row => filters.every(predicate => predicate(row)))
    if (mutation) {
      writes.push({ table, mutation, values })
      if (mutation === 'delete') tables[table] = tables[table].filter(row => !rows.includes(row))
      if (mutation === 'update') rows.forEach(row => Object.assign(row, values))
      if (mutation === 'insert' || mutation === 'upsert') {
        rows = (Array.isArray(values) ? values : [values]).map(value => ({
          id: '11111111-1111-4111-8111-111111111111', created_at: '2026-10-08T00:02:00Z', ...value,
        }))
        tables[table].push(...rows)
      }
    }
    return { data: single ? rows[0] || null : rows, error: null, count: rows.length }
  }
  return chain
}

const dependencies = {
  'next/server': { NextResponse: { json: (data, options) => new Response(JSON.stringify(data), options) } },
  '@/lib/codex-mtg-policy': policy,
  '@/lib/user-roles': roles,
  '@/lib/supabase/admin': { adminClient: { from: query } },
  '@/lib/session': { getUserSession: async () => actor },
  '@/lib/read-status': { markGroupRead: async () => ({ error: null }) },
  '@/lib/drive': { deleteFileFromDrive: async () => {} },
  '@/lib/mention-names': { normalizeMentionContent: value => value },
  '@/lib/unread': { getUnreadCountsByGroup: async () => ({}) },
  '@/lib/web-push': {
    sendPushNotificationToUser: async (...args) => pushes.push(args),
    sendPushNotificationToGroup: async (...args) => pushes.push(args),
  },
  '@/lib/mentions': { findMentionedUsersInGroup: async () => [], sendMentionNotifications: async () => {} },
}
const api = Object.fromEntries(['chat', 'posts', 'groups', 'reactions', 'admin/members', 'admin/groups', 'groups/[id]/members']
  .map(name => [name, load(`app/api/${name}/route.ts`, dependencies)]))
const request = (body = {}, params = {}) => ({ json: async () => body, nextUrl: new URL(`https://example.invalid/?${new URLSearchParams(params)}`) })

async function main() {
  assert.equal(policy.isCodexMtgGroup(mtgId.toUpperCase()), true)
  assert.equal(policy.isCodexMtgGroup(null), false)
  for (const group of [mtgId, mtgId.toUpperCase()]) {
    reset()
    assert.equal((await api.chat.GET(request({}, { group_id: group }))).status, 403)
    assert.equal((await api.chat.POST(request({ group_id: group, content: '拒否される依頼' }))).status, 403)
    assert.equal((await api.posts.GET(request({}, { group_id: group }))).status, 403)
    assert.equal((await api.posts.POST(request({ group_id: group, content: '拒否される依頼' }))).status, 403)
    assert.equal((await api['groups/[id]/members'].GET(request(), { params: Promise.resolve({ id: group }) })).status, 403)
    assert.equal(writes.length, 0)
    assert.equal(pushes.length, 0)
  }
  reset()
  for (const method of ['PATCH', 'DELETE']) {
    assert.equal((await api.chat[method](request({ message_id: postId, content: '拒否される変更' }, { message_id: postId }))).status, 403)
    assert.equal((await api.posts[method](request({ post_id: postId, content: '拒否される変更' }, { post_id: postId }))).status, 403)
  }
  assert.equal((await api.reactions.POST(request({ post_id: postId, emoji: '👍' }))).status, 403)
  assert.equal(writes.length, 0)

  reset()
  const hidden = await (await api.groups.GET()).json()
  assert.deepEqual(hidden.groups.map(group => group.id), [normalId])
  assert.ok(!JSON.stringify(hidden).includes('非公開の依頼'), 'Group previews must not leak private content')
  assert.equal((await api.chat.GET(request({}, { group_id: normalId }))).status, 200, 'Ordinary Chat remains readable for members')

  for (const role of ['executive', 'admin']) {
    reset(role)
    assert.equal((await api.chat.GET(request({}, { group_id: mtgId }))).status, 200)
    assert.equal((await api.chat.POST(request({ group_id: mtgId, content: '管理職からの依頼' }))).status, 201)
    assert.ok(writes.some(write => write.table === 'gw_posts' && write.mutation === 'insert'))
    assert.ok(pushes.length > 0)
    reset(role)
    tables.gw_group_members = tables.gw_group_members.filter(row => row.group_id !== mtgId)
    assert.equal((await api.chat.GET(request({}, { group_id: mtgId }))).status, 403, 'Management role alone does not replace membership')
  }

  reset('admin')
  assert.equal((await api['admin/members'].POST(request({ group_id: mtgId.toUpperCase(), user_ids: [staffId] }))).status, 403)
  assert.equal(writes.length, 0)
  assert.equal((await api['admin/members'].POST(request({ group_id: mtgId, user_ids: [managerId, botId] }))).status, 200)
  assert.equal((await api['admin/members'].POST(request({ group_id: normalId, user_ids: [staffId] }))).status, 200)
  const roster = await (await api['admin/members'].GET(request({}, { group_id: mtgId }))).json()
  assert.ok(!roster.nonMembers.some(user => user.id === staffId))
  reset('admin')
  assert.equal((await api['admin/groups'].DELETE(request({ group_id: mtgId.toUpperCase() }))).status, 403)
  assert.equal(writes.length, 0)

  for (const role of ['executive', 'admin']) {
    reset(role)
    tables.gw_posts[0].user_id = botId
    for (const method of ['PATCH', 'DELETE']) {
      assert.equal((await api.chat[method](request({ message_id: postId, content: '改変' }, { message_id: postId }))).status, 403)
      assert.equal((await api.posts[method](request({ post_id: postId, content: '改変' }, { post_id: postId }))).status, 403)
    }
    assert.equal(writes.length, 0, 'Codex reports remain immutable through both existing APIs')
  }
  reset('admin')
  assert.equal((await api.chat.PATCH(request({ message_id: postId, content: '本人の依頼を編集' }))).status, 200)
  assert.equal(tables.gw_posts[0].content, '本人の依頼を編集')
  assert.equal((await api.chat.DELETE(request({}, { message_id: postId }))).status, 200)
  reset('admin')
  tables.gw_posts[0].group_id = normalId
  tables.gw_posts[0].user_id = botId
  assert.equal((await api.chat.PATCH(request({ message_id: postId, content: '通常Chatの既存権限は維持' }))).status, 200)

  console.log('CodexMTG existing API access tests passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
