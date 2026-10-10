const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename)
let events = [], options = [], requirements = [], additions = [], changes = [], reads = 0
const originalLoad = Module._load
Module._load = function(id, parent, isMain) {
  if (id === '@/lib/google-calendar') return { getGoogleCalendarId: () => 'test-calendar' }
  if (id === '@/lib/google-calendar-import') return {
    isAutoGoogleCalendarSyncEnabled: () => true,
    syncGoogleCalendarRange: async () => ({ synced_at: '2026-10-10T00:00:00Z' }),
  }
  if (id === '@/lib/supabase/admin') return { adminClient: {
    from(table) {
      reads++
      const query = { then(resolve) {
        return Promise.resolve({ data: table === 'gw_calendar_events' ? events : table === 'gw_shift_ec_sales' ? options : requirements, error: null }).then(resolve)
      } }
      for (const method of ['select', 'eq', 'like', 'lt', 'gt', 'order', 'range']) query[method] = () => query
      query.upsert = async values => { additions.push(...values); options.push(...values); return { error: null } }
      return query
    },
    async rpc(name, args) { assert.equal(name, 'gw_apply_shift_calendar_sales'); changes.push(...args.p_rows); return { data: args.p_rows.length, error: null } },
  } }
  if (id.startsWith('@/')) return originalLoad.call(this, path.join(__dirname, '..', id.slice(2)), parent, isMain)
  return originalLoad.call(this, id, parent, isMain)
}
const { syncFloorShiftSales } = require('../lib/shift-calendar-sales-sync.ts')
const { resolveCalendarSale } = require('../lib/shift-calendar-sales.ts')
const retired = resolveCalendarSale('メルカリ月末市', [], '2026-09-30')
const period = { id: 'synthetic-period', department: 'フロア', status: 'editing', start_date: '2026-10-29', end_date: '2026-10-31' }
const event = title => ({ title, starts_at: '2026-10-29T00:00:00+09:00', ends_at: '2026-11-01T00:00:00+09:00', all_day: true })
async function main() {
  events = ['メルカリ月末市', 'Qoo10セール', 'TikTok Shopセール', 'MakeShopセール'].map(event)
  requirements = ['2026-10-29', '2026-10-30', '2026-10-31'].map(work_date => ({ work_date, ec_sale_tags: [], ec_sale_times: {}, calendar_sale_state: { automatic: {}, suppressed: [] } }))
  await syncFloorShiftSales(period, 'synthetic-user')
  assert.deepEqual(additions, [], 'retired/preparing shops do not create master candidates')
  assert.deepEqual(changes, [], 'retired/preparing shops do not create shift notes')
  options = [retired]
  requirements = requirements.map(row => ({ ...row, ec_sale_tags: [retired.id], calendar_sale_state: { automatic: { [retired.id]: { start_time: null, end_time: null } }, suppressed: [] } }))
  const originals = JSON.stringify({ events, options, requirements })
  await syncFloorShiftSales(period, 'synthetic-user')
  assert.deepEqual(changes, [], 'previously saved future automatic notes are not rewritten')
  assert.equal(JSON.stringify({ events, options, requirements }), originals)
  events.push(event('AmazonスマイルSALE'))
  await syncFloorShiftSales(period, 'synthetic-user')
  assert.equal(additions.length, 1)
  assert.match(additions[0].label, /Amazon/)
  assert.equal(changes.length, 3)
  for (const row of changes) {
    assert.ok(row.ec_sale_tags.includes(retired.id), 'saved retired note remains stored')
    assert.ok(row.ec_sale_tags.includes(additions[0].id), 'active shop continues automatic entry')
    assert.ok(row.calendar_sale_state.automatic[retired.id])
  }
  additions = []; changes = []; options = []
  events = [{ ...event('メルカリ月末市'), starts_at: '2026-09-30T00:00:00+09:00', ends_at: '2026-10-02T00:00:00+09:00' }]
  requirements = ['2026-09-30', '2026-10-01'].map(work_date => ({ work_date, ec_sale_tags: [], ec_sale_times: {}, calendar_sale_state: { automatic: {}, suppressed: [] } }))
  await syncFloorShiftSales({ ...period, start_date: '2026-09-30', end_date: '2026-10-01' }, 'synthetic-user')
  assert.equal(additions.length, 1)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].work_date, '2026-09-30', 'historical day remains available across cutoff')
  const readsBefore = reads
  await syncFloorShiftSales({ ...period, status: 'confirmed' }, 'synthetic-user')
  assert.equal(reads, readsBefore, 'confirmed shifts remain untouched')
  console.log('EC retirement sync: no new candidates/notes, saved future automatic notes preserved, active shops and historical boundary passed.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
