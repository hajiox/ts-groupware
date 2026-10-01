const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const targetUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const otherUserId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const outsiderId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
let session = { id: actorId }
let authorized = true
let eligible = true
let eligibilityError = null
let saveError = null
let noteReadError = null
let reads = 0
const rpcCalls = []
const eligibilityCalls = []
const fixtures = {
  gw_attendance_monthly_notes: [
    { user_id: targetUserId, note_month: '2026-09-01', memo: '九月の連絡', updated_at: '2026-10-01T01:00:00Z' },
    { user_id: otherUserId, note_month: '2026-09-01', memo: '別の対象者', updated_at: '2026-10-01T01:00:00Z' },
    { user_id: targetUserId, note_month: '2026-08-01', memo: '八月の連絡', updated_at: '2026-09-01T01:00:00Z' },
    { user_id: outsiderId, note_month: '2026-09-01', memo: '対象外の連絡', updated_at: '2026-10-01T01:00:00Z' },
  ],
}

class FakeNextResponse extends Response {
  static json(value, init) {
    return new FakeNextResponse(JSON.stringify(value), { ...init, headers: { 'Content-Type': 'application/json' } })
  }
}

function query(table) {
  reads += 1
  let rows = fixtures[table] || []
  const chain = {
    select() { return chain },
    eq(column, value) { rows = rows.filter((row) => row[column] === value); return chain },
    gte(column, value) { rows = rows.filter((row) => row[column] >= value); return chain },
    lte(column, value) { rows = rows.filter((row) => row[column] <= value); return chain },
    order() { return chain },
    limit() { return chain },
    then(resolve, reject) {
      const error = table === 'gw_attendance_monthly_notes' ? noteReadError : null
      return Promise.resolve({ data: error ? null : rows, error }).then(resolve, reject)
    },
  }
  return chain
}

const dependencies = {
  'next/server': { NextResponse: FakeNextResponse },
  '@/lib/management-permissions': { getManagementPermissions: () => ({ canManageAttendance: authorized }) },
  '@/lib/paid-leave-attendance-data': { loadPaidLeaveAttendanceDays: async () => [] },
  '@/lib/session': { getUserSession: async () => session },
  '@/lib/supabase/admin': { adminClient: {
    from: query,
    rpc: async (name, params) => {
      rpcCalls.push({ name, params })
      return { error: saveError, data: saveError ? null : [{
        user_id: params.p_user_id, note_month: params.p_note_month, memo: params.p_memo,
        updated_at: '2026-10-01T02:00:00Z',
      }] }
    },
  } },
  '@/lib/workforce-employment': {
    loadAttendanceWorkforceForRange: async () => ({
      users: [{ id: targetUserId, display_name: '試験スタッフ甲' }, { id: otherUserId, display_name: '試験スタッフ乙' }],
      error: null,
    }),
    isAttendanceUserEligibleForRange: async (...args) => {
      eligibilityCalls.push(args)
      return { eligible, error: eligibilityError }
    },
  },
}
const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'admin', 'attendance', 'route.ts'), 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const loaded = { exports: {} }
new Function('module', 'exports', 'require', output)(loaded, loaded.exports, (name) => {
  assert.ok(dependencies[name], `Unexpected external dependency: ${name}`)
  return dependencies[name]
})

function patch(overrides = {}) {
  return { json: async () => ({
    action: 'monthly_memo_save', user_id: targetUserId, month: '2026-09', memo: '全体のメモ',
    expected_updated_at: null, ...overrides,
  }) }
}

async function main() {
  for (const [nextSession, permission, expectedStatus] of [[null, true, 401], [{ id: actorId }, false, 403]]) {
    session = nextSession
    authorized = permission
    const before = [reads, rpcCalls.length, eligibilityCalls.length]
    assert.equal((await loaded.exports.PATCH(patch())).status, expectedStatus)
    assert.equal((await loaded.exports.GET({ nextUrl: new URL('https://test.invalid/api/admin/attendance?date=2026-09-01') })).status, expectedStatus)
    assert.deepEqual([reads, rpcCalls.length, eligibilityCalls.length], before, 'Denied users must not read or mutate notes')
  }
  session = { id: actorId }
  authorized = true

  for (const invalid of [
    { user_id: 'not-uuid' }, { month: '2026-13' }, { month: '2026-00' }, { month: '2026-09-01' },
    { month: '1899-09' }, { memo: 'a'.repeat(2001) }, { memo: null }, { memo: 'invalid\u0000' }, { memo: '\u000b' },
    { expected_updated_at: undefined }, { expected_updated_at: '' }, { expected_updated_at: 'invalid-time' },
  ]) {
    const before = [rpcCalls.length, eligibilityCalls.length]
    assert.equal((await loaded.exports.PATCH(patch(invalid))).status, 400, JSON.stringify(invalid))
    assert.deepEqual([rpcCalls.length, eligibilityCalls.length], before, 'Validation fails before eligibility read or write')
  }

  eligible = false
  const beforeRejected = rpcCalls.length
  assert.equal((await loaded.exports.PATCH(patch())).status, 404)
  assert.equal(rpcCalls.length, beforeRejected, 'Staff outside employment range cannot get a monthly memo')
  assert.deepEqual(eligibilityCalls.at(-1), [targetUserId, '2026-09-01', '2026-09-30'])
  eligible = true
  eligibilityError = { message: 'Synthetic employment read error' }
  assert.equal((await loaded.exports.PATCH(patch())).status, 500)
  assert.equal(rpcCalls.length, beforeRejected)
  eligibilityError = null

  saveError = { code: '40001', message: 'Synthetic stale-note conflict' }
  assert.equal((await loaded.exports.PATCH(patch({ expected_updated_at: '2026-10-01T01:00:00Z' }))).status, 409)
  saveError = { code: 'XX000', message: 'Synthetic write error' }
  const failedWrite = await loaded.exports.PATCH(patch())
  assert.equal(failedWrite.status, 500)
  assert.equal((await failedWrite.json()).error, saveError.message)
  saveError = null

  const saved = await loaded.exports.PATCH(patch({
    memo: '  全体の連絡\r\n二行目\r三行目  ',
    expected_updated_at: '2026-10-01T01:00:00Z', actor_id: outsiderId,
  }))
  assert.equal(saved.status, 200)
  assert.deepEqual(rpcCalls.at(-1), { name: 'gw_save_attendance_monthly_note', params: {
    p_user_id: targetUserId, p_note_month: '2026-09-01', p_memo: '全体の連絡\n二行目\n三行目',
    p_actor_id: actorId, p_expected_updated_at: '2026-10-01T01:00:00Z',
  } })
  const savedPayload = await saved.json()
  assert.equal(savedPayload.monthlyNote.memo, '全体の連絡\n二行目\n三行目')
  assert.equal(savedPayload.checked, false, 'A memo edit requires monthly review again')
  const emptySaved = await loaded.exports.PATCH(patch({ memo: ' \r\n ' }))
  assert.equal(emptySaved.status, 200)
  assert.equal((await emptySaved.json()).monthlyNote.memo, '')
  assert.equal(rpcCalls.at(-1).params.p_memo, '')

  const getRequest = { nextUrl: new URL(`https://test.invalid/api/admin/attendance?date_from=2026-09-01&date_to=2026-09-30&user_id=${targetUserId}`) }
  const result = await loaded.exports.GET(getRequest)
  assert.equal(result.status, 200)
  assert.deepEqual((await result.json()).monthlyNotes, [fixtures.gw_attendance_monthly_notes[0]], 'GET isolates month, eligibility, and selected staff')
  noteReadError = { message: 'Synthetic monthly-note read error' }
  const failedRead = await loaded.exports.GET(getRequest)
  assert.equal(failedRead.status, 500)
  assert.equal((await failedRead.json()).error, noteReadError.message)
  console.log('Attendance monthly memo API: auth, input validation, employment, optimistic conflict, multiline/empty save, session actor, recheck, and GET filtering passed.')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
