const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')

const groupId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const otherGroup = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const mtgId = 'a8081dbe-15db-4d41-a18b-b22bb55d2b39'
const id = n => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, '0')}`
let session, member, membershipError, postError, queries
const rows = [
  { id: id(1), group_id: groupId, attachments: [{ driveId: 'replacement', url: 'new-image' }] },
  { id: id(2), group_id: groupId, attachments: null },
  { id: id(3), group_id: otherGroup, attachments: [{ driveId: 'must-not-leak' }] },
  { id: id(4), group_id: groupId, attachments: [], parent_id: id(1) },
]
function reset() {
  session = { id: 'user', role: 'member' }; member = true
  membershipError = null; postError = null; queries = []
}
const adminClient = { from(table) {
  const filters = []
  let selection
  const builder = {
    select(value) { selection = value; return builder },
    eq(key, value) { filters.push([key, value]); return builder },
    in(key, values) { filters.push([key, values]); return builder },
    maybeSingle() {
      assert.equal(table, 'gw_group_members')
      queries.push({ table, selection, filters })
      return Promise.resolve({ data: member ? { user_id: session.id } : null, error: membershipError })
    },
    then(resolve, reject) {
      assert.equal(table, 'gw_posts')
      queries.push({ table, selection, filters })
      const data = rows.filter(row => filters.every(([key, value]) => Array.isArray(value)
        ? value.includes(row[key]) : row[key] === value))
        .map(({ id, attachments }) => ({ id, attachments }))
      return Promise.resolve({ data, error: postError }).then(resolve, reject)
    },
  }
  return builder
} }
const output = ts.transpileModule(fs.readFileSync('app/api/posts/attachment-snapshots/route.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const loaded = { exports: {} }
const dependencies = {
  'next/server': { NextResponse: { json: (body, options) => ({ body, status: options.status, headers: options.headers }) } },
  '@/lib/supabase/admin': { adminClient },
  '@/lib/session': { getUserSession: async () => session },
  '@/lib/user-roles': { isManagementUser: user => ['admin', 'executive'].includes(user.role) },
  '@/lib/codex-mtg-policy': { isCodexMtgGroup: value => value.toLowerCase() === mtgId },
}
new Function('module', 'exports', 'require', output)(loaded, loaded.exports, name => {
  if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`)
  return dependencies[name]
})
async function get(group = groupId, ids = [id(1)]) {
  const params = new URLSearchParams({ group_id: group, post_ids: ids.join(',') })
  const response = await loaded.exports.GET({ nextUrl: new URL(`https://fixture.invalid/?${params}`) })
  assert.equal(response.headers['Cache-Control'], 'private, no-store')
  return response
}
;(async () => {
  reset(); session = null
  assert.equal((await get()).status, 401); assert.equal(queries.length, 0)
  for (const [group, ids] of [['bad', [id(1)]], [groupId, []], [groupId, ['bad']],
    [groupId, Array.from({ length: 101 }, (_, n) => id(n))]]) {
    reset(); assert.equal((await get(group, ids)).status, 400); assert.equal(queries.length, 0)
  }
  reset(); member = false
  assert.equal((await get()).status, 403); assert.equal(queries.length, 1)
  reset(); assert.equal((await get(mtgId)).status, 403); assert.equal(queries.length, 0)
  reset(); session.role = 'admin'; assert.equal((await get(mtgId)).status, 200)
  reset(); membershipError = { message: 'private database detail' }
  assert.equal((await get()).status, 500); assert.equal(queries.length, 1)
  reset(); postError = { message: 'private database detail' }
  const failure = await get(); assert.equal(failure.status, 500)
  assert.ok(!JSON.stringify(failure.body).includes('private database detail'))
  reset()
  const refreshed = await get(groupId, [id(1), id(1).toUpperCase(), id(2), id(3), id(4), id(999)])
  assert.equal(refreshed.status, 200)
  assert.deepEqual(refreshed.body.posts, [
    { id: id(1), attachments: rows[0].attachments }, { id: id(2), attachments: null },
    { id: id(4), attachments: [] },
  ])
  assert.deepEqual(queries[1].filters, [['group_id', groupId], ['id', [id(1), id(2), id(3), id(4), id(999)]]])
  assert.equal(queries[1].selection, 'id, attachments')
  reset(); assert.equal((await get(groupId, Array.from({ length: 100 }, (_, n) => id(n)))).status, 200)
  console.log('Board attachment snapshot API: auth, group isolation, bounds, deduplication, comments, nulls, no read/write side effects PASS')
})().catch(error => { console.error(error); process.exitCode = 1 })
