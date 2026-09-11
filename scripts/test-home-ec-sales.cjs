const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const Module = require('node:module')
const path = require('node:path')
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename)
let user = { id: 'test-user' }, fail = false, databaseFail = false, syncCalls = 0
const date = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
const events = [
  { title: '楽天スーパーSALE（設定済み）', starts_at: `${date}T00:00:00+09:00`, ends_at: `${date}T01:59:00+09:00`, all_day: false, color: '#dc2127' },
  { title: '社内打ち合わせ', starts_at: `${date}T09:00:00+09:00`, ends_at: `${date}T10:00:00+09:00`, all_day: false, color: '#5484ed' },
]
const originalLoad = Module._load
Module._load = function(id, parent, isMain) {
  if (id === 'next/server') return { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200 }) } }
  if (id === '@/lib/session') return { getUserSession: async () => user }
  if (id === '@/lib/google-calendar') return { getGoogleCalendarId: () => 'aizubrandhall@gmail.com' }
  if (id === '@/lib/google-calendar-import') return {
    isAutoGoogleCalendarSyncEnabled: () => true,
    syncGoogleCalendarRange: async args => {
      syncCalls++
      assert.equal(args.rangeStart, `${date}T00:00:00+09:00`)
      assert.equal(Date.parse(args.rangeEnd) - Date.parse(args.rangeStart), 86400000)
      if (fail) throw Error('private upstream details')
      return { synced_at: new Date().toISOString() }
    },
  }
  if (id === '@/lib/supabase/admin') return { adminClient: { from(table) {
    const query = { then(resolve) { return Promise.resolve({ data: table === 'gw_calendar_events' ? events : [], error: databaseFail ? Error('private database details') : null }).then(resolve) } }
    for (const key of ['select', 'eq', 'lt', 'gt', 'order', 'range']) query[key] = () => query
    query.like = (key, value) => { assert.equal(key, 'external_id'); assert.equal(value, 'aizubrandhall@gmail.com:%'); return query }
    return query
  } } }
  if (id.startsWith('@/')) return originalLoad.call(this, path.join(__dirname, '..', id.slice(2)), parent, isMain)
  return originalLoad.call(this, id, parent, isMain)
}
async function main() {
  const { GET } = require('../app/api/home/ec-sales/route.ts')
  user = null
  assert.equal((await GET()).status, 401)
  assert.equal(syncCalls, 0)
  user = { id: 'test-user' }
  const result = await GET()
  assert.equal(result.body.date, date)
  assert.equal(result.body.sales.length, 1)
  assert.match(result.body.sales[0].label, /01:59/)
  assert.equal(result.body.sales[0].color, '#dc2127')
  assert.equal(result.body.warning, null)
  fail = true
  const fallback = await GET()
  assert.equal(fallback.body.sales.length, 1)
  assert.ok(fallback.body.warning)
  events.splice(0)
  assert.ok((await GET()).body.warning)
  fail = false
  const empty = await GET()
  assert.deepEqual(empty.body.sales, [])
  assert.equal(empty.body.warning, null)
  databaseFail = true
  const failure = await GET()
  assert.equal(failure.status, 503)
  assert.ok(!JSON.stringify(failure).includes('private database'))
  console.log('Home EC sales: authentication, JST range, sale filtering, time labels, fallback, empty and database failure passed.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
