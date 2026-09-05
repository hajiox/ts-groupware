const assert = require('node:assert/strict')
const fs = require('node:fs'), ts = require('typescript')
const source = ts.transpileModule(fs.readFileSync('lib/google-calendar-import.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function harness({ failSecond = false, locked = false, empty = false } = {}) {
  const statuses = new Map(), snapshots = [], requests = []
  let releases = 0
  const db = {
    from(name) {
      const query = {
        select() { return this }, eq(_, value) { this.key = value; return this },
        maybeSingle: async function() { return { data: statuses.get(this.key) || null } },
        upsert: async function(value) { const next = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)); statuses.set(value.sync_key, { ...statuses.get(value.sync_key), ...next }); return {} },
        delete() { releases++; return this },
      }
      assert.ok(['gw_calendar_sync_status', 'gw_calendar_sync_leases'].includes(name))
      return query
    },
    async rpc(name, body) {
      if (name === 'gw_claim_calendar_sync') return { data: !locked }
      assert.equal(name, 'gw_replace_google_calendar_range')
      snapshots.push(body); return { data: 0 }
    },
  }
  const google = {
    colors: { get: async () => { throw new Error('color endpoint unavailable') } },
    events: { list: async (params, options) => {
      requests.push(params)
      assert.equal(options.timeout, 8000)
      assert.deepEqual(options.retryConfig.statusCodesToRetry, [[429, 429], [500, 599]])
      if (params.pageToken && failSecond) throw new Error('temporary calendar failure')
      return { data: { nextPageToken: !params.pageToken && !empty ? 'page2' : undefined, items: empty ? [] : [{ id: params.pageToken || 'page1', summary: 'SALE', start: { date: '2026-09-05' }, end: { date: '2026-09-06' } }] } }
    } },
  }
  const mod = { exports: {} }
  const fakeRequire = name => {
    if (name === '@/lib/google-calendar') return { getGoogleCalendarId: () => 'calendar@test', getGoogleCalendarAuthInfo: () => ({ mode: 'service_account' }), getGoogleCalendarClient: () => google }
    if (name === '@/lib/supabase/admin') return { adminClient: db }
    if (name === '@/lib/tsg-ai') return { getTsgUserId: async () => 'test-user' }
    return require(name)
  }
  new Function('require', 'module', 'exports', source)(fakeRequire, mod, mod.exports)
  return { sync: mod.exports.syncGoogleCalendarRange, statuses, snapshots, requests, releases: () => releases }
}
const args = { rangeStart: '2026-09-01T00:00:00Z', rangeEnd: '2026-10-01T00:00:00Z', requestedBy: 'test-user' }
async function main() {
  const normal = harness()
  const result = await normal.sync(args)
  assert.equal(result.imported, 2)
  assert.equal(normal.snapshots.length, 1)
  assert.equal(normal.snapshots[0].p_events.length, 2)
  assert.equal(normal.requests[1].pageToken, 'page2')
  assert.equal((await normal.sync(args)).sync_skipped, true)
  assert.equal(normal.requests.length, 2)
  const failure = harness({ failSecond: true })
  const key = 'google_calendar:calendar@test:2026-09-01:2026-10-01'
  const previous = '2026-08-01T00:00:00Z'
  failure.statuses.set(key, { last_synced_at: previous })
  await assert.rejects(failure.sync(args))
  assert.equal(failure.snapshots.length, 0)
  assert.equal(failure.statuses.get(key).last_synced_at, previous)
  assert.equal(failure.releases(), 1)
  await assert.rejects(failure.sync(args))
  assert.equal(failure.requests.length, 2)
  const concurrent = harness({ locked: true })
  assert.equal((await concurrent.sync(args)).sync_in_progress, true)
  assert.equal(concurrent.requests.length, 0)
  const removed = harness({ empty: true })
  assert.equal((await removed.sync(args)).imported, 0)
  assert.deepEqual(removed.snapshots[0].p_events, [])
  console.log('Pagination, bounded retries, failed-page preservation, cooldown, successful empty snapshot and concurrent lease checks passed.')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
