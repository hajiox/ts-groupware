const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function load(relativePath, dependencies = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const loaded = { exports: {} }
  new Function('module', 'exports', 'require', output)(loaded, loaded.exports, (name) => {
    assert.ok(dependencies[name], `Unexpected dependency: ${name}`)
    return dependencies[name]
  })
  return loaded.exports
}

const role = load('lib/user-roles.ts')
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const memberId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const executiveIds = ['afbc01a8-3963-43c4-8005-7146bf9ff850', '7457839f-aba2-4169-95e5-ca88f70841c7']
for (const name of ['佐藤正彦', '佐藤 正彦', '佐藤ちさと', '佐藤　ちさと']) {
  for (const storedRole of ['member', 'admin', undefined]) {
    const user = { id: actorId, role: storedRole, display_name: name, real_name: name }
    assert.equal(role.getEffectiveUserRole(user), storedRole || 'member')
    assert.equal(role.isExecutiveUser(user), false, 'A name cannot grant executive access')
    assert.equal(role.isFixedExecutiveUser(user), false, 'A name cannot lock an unrelated account')
  }
}
for (const id of executiveIds) {
  assert.equal(role.isFixedExecutiveUser({ id, role: 'executive', real_name: '名称変更後' }), true)
  assert.equal(role.getEffectiveUserRole({ id, role: 'member' }), 'member', 'An ID does not implicitly elevate the stored role')
}
assert.equal(role.getEffectiveUserRole({ role: 'executive', real_name: '名称変更後' }), 'executive')
assert.equal(role.isFixedExecutiveUser(null), false)

const users = [
  { id: actorId, role: 'admin', status: 'approved', real_name: '試験管理者', display_name: '試験管理者', department: 'フロア' },
  { id: memberId, role: 'member', status: 'approved', real_name: '試験スタッフ', display_name: '試験スタッフ', department: 'フロア' },
  ...executiveIds.map((id) => ({ id, role: 'executive', status: 'approved', real_name: '試験役員', display_name: '試験役員', department: '道の駅' })),
]
let current = users[0]
let reads = 0
const writes = []
const adminClient = { from(table) {
  reads += 1
  let rows = table === 'gw_users' ? [...users] : []
  let update = null
  const chain = {
    select() { return chain },
    eq(key, value) { rows = rows.filter((row) => row[key] === value); return chain },
    update(value) { update = value; return chain },
    maybeSingle: async () => ({ data: rows[0] ? { ...rows[0] } : null, error: null }),
    then(resolve, reject) {
      if (update) {
        assert.equal(table, 'gw_users')
        writes.push({ target: rows[0]?.id, update })
        for (const row of rows) Object.assign(row, update)
      }
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
    },
  }
  return chain
} }
const permissions = load('lib/management-permissions.ts', {
  '@/lib/user-roles': role, '@/lib/supabase/admin': { adminClient },
})
const api = load('app/api/admin/users/route.ts', {
  'next/server': { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), init) } },
  '@/lib/session': { getUserSession: async () => current },
  '@/lib/user-roles': role,
  '@/lib/supabase/admin': { adminClient },
  '@/lib/departments': { isUserDepartment: (value) => ['フロア', '製造', '道の駅'].includes(value) },
})
const put = (body) => api.PUT({ json: async () => body })

async function main() {
  for (const invalidActor of [null, { ...users[1], real_name: '佐藤正彦', display_name: '佐藤正彦' }]) {
    current = invalidActor
    const before = reads
    assert.equal((await put({ user_id: actorId, real_name: '名称変更' })).status, invalidActor ? 403 : 401)
    assert.equal(reads, before)
    assert.equal(writes.length, 0)
  }
  current = users[0]
  assert.equal((await put({ user_id: actorId, real_name: '佐藤正彦', display_name: '佐藤正彦' })).status, 200)
  assert.equal(role.getEffectiveUserRole(users[0]), 'admin', 'Renaming a manager must not elevate their role')
  assert.equal(permissions.getManagementPermissions(users[0]).canViewPayroll, false)
  assert.equal((await put({ user_id: actorId, role: 'executive' })).status, 400)
  assert.equal(users[0].role, 'admin')
  assert.equal((await put({ user_id: memberId, real_name: '佐藤ちさと' })).status, 200)
  assert.equal(role.getEffectiveUserRole(users[1]), 'member')
  assert.equal(role.isFixedExecutiveUser(users[1]), false)
  assert.equal((await put({ user_id: executiveIds[0], real_name: '変更不可' })).status, 403,
    'A manager still cannot edit an actual executive account')
  current = users[2]
  assert.equal((await put({ user_id: executiveIds[1], role: 'executive' })).status, 200)
  assert.equal((await put({ user_id: memberId, role: 'executive' })).status, 400,
    'Even an executive cannot grant the reserved role to an unrelated account')
  console.log('Stored user role and administrator rename security tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
