const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const XLSX = require('xlsx')

const users = [
  { id: 'staff-a', display_name: '試験スタッフ甲', department: 'フロア' },
  { id: 'staff-b', display_name: '試験スタッフ乙', department: 'フロア' },
  { id: 'staff-c', display_name: '試験スタッフ丙', department: 'フロア' },
]
const overallMemo = '今月全体の連絡\r\n時給変更 & <確認> "済"\n面談の結果を共有'
const fixtures = {
  gw_attendance_punches: [],
  gw_attendance_daily_notes: [{ user_id: 'staff-a', work_date: '2026-09-03', memo: '日別の備考は別に保持' }],
  gw_attendance_monthly_notes: [
    { user_id: 'staff-a', note_month: '2026-09-01', memo: overallMemo },
    { user_id: 'staff-b', note_month: '2026-09-01', memo: '乙のみの月次メモ' },
    { user_id: 'staff-c', note_month: '2026-09-01', memo: '' },
    { user_id: 'staff-a', note_month: '2026-08-01', memo: '先月だけのメモ' },
    { user_id: 'not-eligible', note_month: '2026-09-01', memo: '対象外スタッフのメモ' },
  ],
  gw_workday_resolutions: [],
}
let noteReadError = null
let authorized = true
let currentUsers = users
let queryCount = 0

class FakeNextResponse extends Response {
  static json(value, init) {
    return new FakeNextResponse(JSON.stringify(value), { ...init, headers: { 'Content-Type': 'application/json' } })
  }
}

function query(table) {
  queryCount += 1
  let rows = fixtures[table] || []
  const chain = {
    select() { return chain },
    in(column, values) { rows = rows.filter((row) => values.includes(row[column])); return chain },
    eq(column, value) { rows = rows.filter((row) => row[column] === value); return chain },
    gte(column, value) { rows = rows.filter((row) => row[column] >= value); return chain },
    lte(column, value) { rows = rows.filter((row) => row[column] <= value); return chain },
    order() { return chain },
    then(resolve, reject) {
      const error = table === 'gw_attendance_monthly_notes' ? noteReadError : null
      return Promise.resolve({ data: error ? null : rows, error }).then(resolve, reject)
    },
  }
  return chain
}

const dependencies = {
  'next/server': { NextResponse: FakeNextResponse },
  '@/lib/departments': {
    USER_DEPARTMENTS: ['フロア', '製造', '道の駅'],
    normalizeUserDepartment: (value) => value || '製造',
  },
  '@/lib/management-permissions': { getManagementPermissions: () => ({ canManageAttendance: authorized }) },
  '@/lib/paid-leave-attendance-data': { loadPaidLeaveAttendanceDays: async () => [] },
  '@/lib/session': { getUserSession: async () => ({ id: 'synthetic-admin' }) },
  '@/lib/supabase/admin': { adminClient: { from: query } },
  '@/lib/workforce-employment': {
    loadAttendanceWorkforceForRange: async () => ({ users: currentUsers, employeesByUserId: new Map(), error: null }),
  },
}
const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'api', 'admin', 'attendance', 'export', 'route.ts'), 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const loaded = { exports: {} }
new Function('module', 'exports', 'require', output)(loaded, loaded.exports, (name) => {
  assert.ok(dependencies[name], `Unexpected external dependency: ${name}`)
  return dependencies[name]
})

function request(month = '2026-09') {
  return { nextUrl: new URL(`https://test.invalid/api/admin/attendance/export?month=${month}&department=${encodeURIComponent('フロア')}`) }
}

function memoFromSheet(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: true })
  const start = rows.findIndex((row) => row[0] === '個人全体のメモ')
  if (start < 0) return ''
  let memo = ''
  for (let index = start; index < rows.length; index += 1) {
    if (!sheet['!merges']?.some((range) => range.s.r === index && range.s.c === 1 && range.e.c === 5)) break
    memo += rows[index][1] || ''
  }
  return memo
}

async function main() {
  const response = await loaded.exports.GET(request())
  assert.equal(response.status, 200)
  const xml = await response.text()
  assert.match(xml, /ss:MergeAcross="4" ss:StyleID="MonthlyMemo"/)
  assert.match(xml, /ss:Vertical="Top" ss:WrapText="1"/)
  assert.match(xml, /今月全体の連絡&#10;/)
  assert.match(xml, /時給変更 &amp; &lt;確認&gt; &quot;済&quot;&#10;/)
  assert.match(xml, /ss:AutoFitHeight="0" ss:Height="30"/)
  assert.match(xml, /ss:AutoFitHeight="0" ss:Height="24"/)
  assert.doesNotMatch(xml, /<Column /, 'Monthly notes must not change daily worksheet column defaults')
  assert.doesNotMatch(xml, /先月だけのメモ|対象外スタッフのメモ/)

  const workbook = XLSX.read(xml, { type: 'string' })
  const normalizedMemo = overallMemo.replace(/\r\n?/g, '\n')
  for (const [staffName, expectedMemo] of [[users[0].display_name, normalizedMemo], [users[1].display_name, '乙のみの月次メモ']]) {
    const sheet = workbook.Sheets[staffName]
    assert.equal(sheet.A5.v, '個人全体のメモ')
    assert.equal(memoFromSheet(sheet), expectedMemo)
    assert.ok(sheet['!merges'].some((range) => range.s.r === 4 && range.s.c === 1 && range.e.r === 4 && range.e.c === 5))
  }
  const firstSheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[users[0].display_name], { header: 1 })
  assert.equal(firstSheetRows.find((row) => row[0] === '2026-09-03')[5], '日別の備考は別に保持')
  const emptySheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[users[2].display_name], { header: 1 })
  assert.ok(!emptySheetRows.some((row) => row[0] === '個人全体のメモ'))

  const previousMonth = await loaded.exports.GET(request('2026-08'))
  const previousXml = await previousMonth.text()
  assert.match(previousXml, /先月だけのメモ/)
  assert.doesNotMatch(previousXml, /今月全体の連絡|乙のみの月次メモ/)

  const savedOverallMemo = fixtures.gw_attendance_monthly_notes[0].memo
  for (const memo of ['長'.repeat(2000), 'W'.repeat(2000), '開始\n\n🙂確認\n\n末尾\n', '🙂'.repeat(1000)]) {
    fixtures.gw_attendance_monthly_notes[0].memo = memo
    const longResponse = await loaded.exports.GET(request())
    const longXml = await longResponse.text()
    const sheet = XLSX.read(longXml, { type: 'string' }).Sheets[users[0].display_name]
    assert.equal(memoFromSheet(sheet), memo, 'Length-limit, blank-line, and emoji contents must survive row splitting exactly')
    for (const range of sheet['!merges'] || []) {
      if (range.s.c !== 1 || range.e.c !== 5) continue
      const text = sheet[XLSX.utils.encode_cell(range.s)]?.v || ''
      const displayWidth = Array.from(text.replace(/\n/g, '')).reduce((width, character) => width + (character === '\t' ? 4 : character.codePointAt(0) <= 0x7f ? 1 : 2), 0)
      assert.ok(displayWidth <= 40, 'Each printable memo row must remain within a conservative display width')
    }
  }
  fixtures.gw_attendance_monthly_notes[0].memo = savedOverallMemo

  noteReadError = { message: 'Synthetic monthly-note read failed' }
  const failedRead = await loaded.exports.GET(request())
  assert.equal(failedRead.status, 500)
  assert.equal((await failedRead.json()).error, noteReadError.message)
  noteReadError = null

  authorized = false
  const beforeDenied = queryCount
  assert.equal((await loaded.exports.GET(request())).status, 403)
  assert.equal(queryCount, beforeDenied, 'Denied export must not read private data')
  authorized = true

  currentUsers = []
  const beforeEmpty = queryCount
  assert.equal((await loaded.exports.GET(request())).status, 200)
  assert.equal(queryCount, beforeEmpty, 'No eligible staff requires no note query')
  console.log('Attendance monthly memo export: printable max-length/blank-line/emoji XML roundtrip, empty/per-staff/per-month isolation, daily notes, read failure, and permissions passed.')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
