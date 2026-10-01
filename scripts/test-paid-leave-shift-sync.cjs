const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

// Every dependency below is an in-memory fixture. This script never loads a
// Supabase client, credentials, or a production endpoint.
function loadTypeScript(relativePath, dependencies = {}, setup = '', context = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const loaded = { exports: {} }
  new Function('module', 'exports', 'require', 'context', output + '\n' + setup)(
    loaded, loaded.exports, (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected external dependency: ${name}`)
      return dependencies[name]
    }, context,
  )
  return loaded.exports
}

const leave = loadTypeScript('lib/paid-leave.ts')
const periodId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const employeeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const actorId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const assignmentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const requestId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const leaveDate = '2099-01-02'
const events = []
let averageMinutes = 501
let syncError = null
let accountSyncs = 0
let fixtures = {}

function resetFixtures() {
  averageMinutes = 501
  syncError = null
  accountSyncs = 0
  events.length = 0
  fixtures = {
    gw_shift_periods: [{ id: periodId, is_test_mode: false, status: 'editing' }],
    gw_shift_requests: [{
      id: requestId, period_id: periodId, user_id: userId, employee_id: employeeId,
      work_date: leaveDate, request_type: 'paid_leave_half', memo: 'Synthetic half-day leave',
    }],
    gw_payroll_employees: [{
      id: employeeId, user_id: userId, employee_code: 'TEST', display_name: 'Synthetic staff',
      real_name: null, hire_date: '2098-01-01', department: '製造', work_style: 'full_time_part',
      payroll_status: 'active', raw_payload: { hr_profile: {
        basic_work_start: '08:30', basic_work_end: '17:30', basic_break_minutes: 60,
      } },
    }],
    gw_shift_assignments: [{
      id: assignmentId, period_id: periodId, user_id: userId, employee_id: employeeId,
      work_date: leaveDate, shift_label: '08:30-12:30', start_time: '08:30',
      end_time: '12:30', break_minutes: 0, work_minutes: 240, note: null,
    }],
    gw_pay_rates: [{ employee_id: employeeId, amount: 1200, effective_from: '2098-01-01', effective_to: null, rate_type: 'hourly' }],
    gw_payroll_calculation_profiles: [{ employee_id: employeeId, calculation_type: 'hourly', hourly_rate: 1200, effective_from: '2098-01-01', effective_to: null }],
  }
}

function query(table) {
  events.push({ type: 'read', table })
  let rows = [...(fixtures[table] || [])]
  let single = false
  const chain = {
    select() { return chain },
    eq(key, value) { rows = rows.filter((row) => row[key] === value); return chain },
    in(key, values) { rows = rows.filter((row) => values.includes(row[key])); return chain },
    gte(key, value) { rows = rows.filter((row) => row[key] >= value); return chain },
    lte(key, value) { rows = rows.filter((row) => row[key] <= value); return chain },
    or() { return chain },
    order() { return chain },
    limit(count) { rows = rows.slice(0, count); return chain },
    maybeSingle() { single = true; return chain },
    then(resolve, reject) {
      return Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(resolve, reject)
    },
  }
  return chain
}

const data = loadTypeScript('lib/paid-leave-data.ts', {
  '@/lib/paid-leave': leave,
  '@/lib/attendance-deviations': {},
  '@/lib/payroll-attendance-policy-data': {},
  '@/lib/payroll-calculation': {},
  '@/lib/supabase/admin': { adminClient: {
    from: query,
    rpc: async (name, params) => {
      assert.equal(name, 'gw_sync_shift_paid_leave_batch')
      events.push({ type: 'rpc', name, params })
      return { data: syncError ? null : { synced: params.p_rows.length }, error: syncError }
    },
  } },
}, `
  // Isolate average retrieval and account maintenance, which have their own
  // business inputs; retain the real wage snapshot and shift batch builder.
  loadThreeMonthAverage = context.average;
  syncPaidLeaveAccount = context.syncAccount;
`, {
  average: async () => ({ averageMinutesPerDay: averageMinutes }),
  syncAccount: async () => { accountSyncs += 1 },
})

class FakeNextResponse extends Response {
  static json(value, init) {
    return new FakeNextResponse(JSON.stringify(value), {
      ...init, headers: { 'Content-Type': 'application/json' },
    })
  }
}

let routeSyncError = null
let routeTestMode = false
let periodUpdateError = null
const routeEvents = []
const routePeriod = {
  id: periodId, department: '製造', title: 'Synthetic phase',
  start_date: '2099-01-01', end_date: '2099-01-15', status: 'editing', is_test_mode: false,
}
function routeQuery(table) {
  let mutation = null
  const chain = {
    select() { return chain }, eq() { return chain }, in() { return chain },
    neq() { return chain }, lte() { return chain }, gte() { return chain }, limit() { return chain },
    update(values) { mutation = values; return chain },
    then(resolve, reject) {
      if (mutation) routeEvents.push({ type: 'update', table, values: mutation })
      const error = mutation && table === 'gw_shift_periods' ? periodUpdateError : null
      return Promise.resolve({ data: [], error, count: table === 'gw_shift_confirmation_alerts' ? 3 : 0 }).then(resolve, reject)
    },
  }
  return chain
}
const route = loadTypeScript('app/api/admin/shifts/route.ts', {
  'next/server': { NextResponse: FakeNextResponse },
  '@/lib/shift-pattern-access': {},
  '@/lib/departments': {},
  '@/lib/google-calendar-import': {},
  '@/lib/shift-calendar-sales-sync': {},
  '@/lib/management-permissions': {},
  '@/lib/session': {},
  '@/lib/shift-assignments': {},
  '@/lib/shift-constraints': {},
  '@/lib/shift-request-exclusions': {},
  '@/lib/shift-sales': {},
  '@/lib/shift-timee': {},
  '@/lib/supabase/admin': { adminClient: { from: routeQuery } },
  '@/lib/paid-leave-data': { syncShiftPaidLeaveRequests: async () => {
    routeEvents.push({ type: 'sync' })
    if (routeSyncError) throw routeSyncError
    return { synced: 1 }
  } },
}, `
  requireShiftAdmin = context.auth;
  loadPeriod = context.period;
  loadPatterns = async () => [];
  loadShiftEmployees = async () => [];
`, {
  auth: async () => ({ user: { id: actorId }, error: null }),
  period: async () => ({ ...routePeriod, is_test_mode: routeTestMode }),
})

function patch(finalize = true) {
  return { json: async () => ({
    action: 'save_shift_changes', period_id: periodId, finalize,
    requirements: [], assignments: [], request_changes: [], cell_styles: [],
  }) }
}
function batchRow() {
  return events.findLast((event) => event.type === 'rpc').params.p_rows[0]
}

async function main() {
  const oddHalf = leave.calculateOrdinaryPaidLeaveWage({ scheduledMinutes: 501, hourlyRate: 1200, leaveDays: 0.5 })
  assert.deepEqual(oddHalf, { payableMinutes: 251, amount: 5010 }, 'Integer minutes must preserve the original wage amount from 250.5 minutes')
  assert.deepEqual(leave.calculateOrdinaryPaidLeaveWage({ scheduledMinutes: 500, hourlyRate: 1200, leaveDays: 0.5 }), { payableMinutes: 250, amount: 5000 })
  assert.deepEqual(leave.calculateOrdinaryPaidLeaveWage({ scheduledMinutes: 501, hourlyRate: 1200, leaveDays: 1 }), { payableMinutes: 501, amount: 10020 })

  resetFixtures()
  assert.deepEqual(await data.syncShiftPaidLeaveRequests(periodId, actorId), { synced: 1, skippedTestMode: false })
  assert.equal(accountSyncs, 1)
  assert.equal(batchRow().scheduled_minutes_snapshot, 240, 'The actual working half must not be inflated to the wage basis')
  assert.equal(batchRow().shift_assignment_id, assignmentId)
  assert.equal(batchRow().payable_minutes_snapshot, 251)
  assert.equal(batchRow().paid_wage_amount, 5010)
  assert.equal(batchRow().raw_payload.wage_basis, 'three_month_average_hours')

  resetFixtures()
  averageMinutes = 500
  await data.syncShiftPaidLeaveRequests(periodId, actorId)
  assert.equal(batchRow().payable_minutes_snapshot, 250)
  assert.equal(batchRow().paid_wage_amount, 5000)

  resetFixtures()
  fixtures.gw_shift_requests[0].request_type = 'paid_leave_full'
  fixtures.gw_shift_assignments = []
  await data.syncShiftPaidLeaveRequests(periodId, actorId)
  assert.equal(batchRow().leave_unit, 'full_day')
  assert.equal(batchRow().scheduled_minutes_snapshot, 480)
  assert.equal(batchRow().payable_minutes_snapshot, 501)
  assert.equal(batchRow().paid_wage_amount, 10020)

  resetFixtures()
  averageMinutes = null
  await data.syncShiftPaidLeaveRequests(periodId, actorId)
  assert.equal(batchRow().raw_payload.wage_basis, 'confirmed_shift')
  assert.equal(batchRow().payable_minutes_snapshot, 120)
  assert.equal(batchRow().paid_wage_amount, 2400)

  resetFixtures()
  fixtures.gw_payroll_employees[0].work_style = 'regular_5d_8h'
  fixtures.gw_payroll_calculation_profiles[0].calculation_type = 'monthly_fixed'
  const salaried = await data.paidLeaveWageSnapshot(employeeId, 480, 0.5, leaveDate)
  assert.equal(salaried.payableMinutes, 240)
  assert.equal(salaried.amount, 0)
  assert.equal(salaried.includedInMonthlySalary, true)
  assert.equal(salaried.basis, 'confirmed_shift')

  resetFixtures()
  fixtures.gw_shift_periods[0].is_test_mode = true
  assert.deepEqual(await data.syncShiftPaidLeaveRequests(periodId, actorId), { synced: 0, skippedTestMode: true })
  assert.equal(accountSyncs, 0)
  assert.equal(events.filter((event) => event.type === 'rpc').length, 0)
  assert.deepEqual(events.map((event) => event.table), ['gw_shift_periods'])

  resetFixtures()
  fixtures.gw_shift_requests = []
  assert.deepEqual(await data.syncShiftPaidLeaveRequests(periodId, actorId), { synced: 0 })
  assert.equal(accountSyncs, 0)
  assert.equal(events.filter((event) => event.type === 'rpc').length, 0)

  resetFixtures()
  syncError = new Error('Synthetic paid-leave batch failure')
  await assert.rejects(data.syncShiftPaidLeaveRequests(periodId, actorId), syncError)

  routeEvents.length = 0
  const finalized = await route.PATCH(patch())
  assert.equal(finalized.status, 200)
  assert.equal((await finalized.json()).finalized, true)
  assert.deepEqual(routeEvents.map((event) => event.type), ['sync', 'update'])
  assert.equal(routeEvents[1].values.status, 'confirmed')
  assert.equal(routeEvents[1].values.confirmed_by, actorId)
  assert.ok(routeEvents[1].values.confirmed_at)

  routeEvents.length = 0
  routeSyncError = new Error('Synthetic paid-leave synchronization error')
  const failed = await route.PATCH(patch())
  assert.equal(failed.status, 500)
  assert.equal((await failed.json()).error, routeSyncError.message)
  assert.deepEqual(routeEvents.map((event) => event.type), ['sync'], 'Failed leave sync must not claim the period is confirmed')
  routeSyncError = null

  routeEvents.length = 0
  periodUpdateError = new Error('Synthetic period update error')
  const failedUpdate = await route.PATCH(patch())
  assert.equal(failedUpdate.status, 500)
  assert.equal((await failedUpdate.json()).error, periodUpdateError.message)
  periodUpdateError = null

  routeEvents.length = 0
  routeTestMode = true
  assert.equal((await route.PATCH(patch())).status, 400)
  assert.equal(routeEvents.length, 0)
  routeTestMode = false

  routeEvents.length = 0
  const temporarySave = await route.PATCH(patch(false))
  assert.equal(temporarySave.status, 200)
  assert.equal((await temporarySave.json()).finalized, false)
  assert.deepEqual(routeEvents.map((event) => event.type), ['update'])
  assert.equal(routeEvents[0].values.status, 'editing')
  assert.equal(routeEvents[0].values.confirmed_at, undefined)

  console.log('Paid-leave shift sync: odd/even/full wages, monthly salary, fallback, batch errors, test mode, and final-save status passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
