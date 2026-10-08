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
const actor = { id: 'test-user', role: 'admin', status: 'approved' }
const baseline = '2026-10-08T00:00:00Z'
// 最新のCodexMTGと、同名の通常Chat、掲示板、DMを混在させる。
const tables = {
  gw_groups: [
    { id: mtgId, name: 'CodexMTG', type: 'chat', updated_at: '2026-10-08T04:00:00Z' },
    { id: 'board', name: '掲示板', type: 'board', updated_at: '2026-10-08T02:00:00Z' },
    { id: 'chat', name: 'CodexMTG', type: 'chat', updated_at: '2026-10-08T03:00:00Z' },
    { id: 'dm', type: 'chat', description: 'direct:test-user:other', updated_at: '2026-10-08T05:00:00Z' },
  ],
  gw_group_members: [mtgId, 'board', 'chat', 'dm'].map(group_id => ({ group_id, user_id: actor.id, joined_at: baseline })),
  gw_read_status: [],
  gw_posts: [mtgId, 'board', 'chat', 'dm'].flatMap(group_id => [
    { group_id, id: `${group_id}-new`, user_id: 'other', parent_id: null, created_at: '2026-10-08T01:00:00Z' },
    { group_id, id: `${group_id}-old`, user_id: 'other', parent_id: null, created_at: '2026-10-07T01:00:00Z' },
    { group_id, id: `${group_id}-own`, user_id: actor.id, parent_id: null, created_at: '2026-10-08T01:00:00Z' },
    { group_id, id: `${group_id}-reply`, user_id: 'other', parent_id: 'parent', created_at: '2026-10-08T01:00:00Z' },
  ]),
}
const reads = []
function query(table) {
  assert.ok(Object.hasOwn(tables, table), `Unexpected table: ${table}`)
  const filters = []
  let order, limit, selection
  const chain = {
    select(columns, options) { selection = options; return chain },
    eq(key, value) { filters.push(row => row[key] === value); return chain },
    neq(key, value) { filters.push(row => row[key] !== value); return chain },
    in(key, values) { filters.push(row => values.includes(row[key])); return chain },
    is(key, value) { filters.push(row => value === null ? row[key] == null : row[key] === value); return chain },
    gt(key, value) { filters.push(row => row[key] > value); return chain },
    order(key, options) { order = { key, ascending: options.ascending }; return chain },
    limit(value) { limit = value; return chain },
    then(resolve, reject) {
      let data = tables[table].filter(row => filters.every(filter => filter(row)))
      reads.push({ table, ids: data.map(row => row.group_id || row.id), count: selection?.count })
      if (order) data.sort((a, b) => String(a[order.key]).localeCompare(String(b[order.key])) * (order.ascending ? 1 : -1))
      if (limit) data = data.slice(0, limit)
      return Promise.resolve({ data, count: data.length, error: null }).then(resolve, reject)
    },
  }
  return chain
}
const dependencies = {
  '@/lib/supabase/admin': { adminClient: { from: query } },
  '@/lib/codex-mtg-policy': policy,
}
const unread = load('lib/unread.ts', dependencies)
const groups = load('app/api/groups/route.ts', {
  ...dependencies,
  '@/lib/unread': unread,
  '@/lib/session': { getUserSession: async () => actor },
  '@/lib/user-roles': roles,
  'next/server': { NextResponse: { json: (data, options) => new Response(JSON.stringify(data), options) } },
})

async function main() {
  assert.deepEqual(await unread.getUnreadCountsByGroup(actor.id, [mtgId, mtgId.toUpperCase()]), {})
  assert.equal(reads.length, 0, 'CodexMTGだけの場合はDBへ未読問い合わせをしない')
  const response = await groups.GET()
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.groups.map(group => group.id), ['chat', 'board', mtgId])
  assert.deepEqual(body.groups.map(group => group.unread), [1, 1, 0])
  assert.deepEqual(await unread.getUnreadSummary(actor.id), { dmUnread: 1, groupUnread: 2, totalUnread: 3 })
  assert.ok(reads.filter(read => read.count).every(read => !read.ids.includes(mtgId)), 'CodexMTGの投稿は未読カウント対象外')
  actor.role = 'member'
  assert.deepEqual((await (await groups.GET()).json()).groups.map(group => group.id), ['chat', 'board'])
  console.log('CodexMTG list ordering, unread exclusion and existing group/DM behavior passed.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
