import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceRoleKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が必要です')
}

const db = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function fetchAll(table, columns, configure = (query) => query) {
  const rows = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const query = configure(db.from(table).select(columns)).range(offset, offset + pageSize - 1)
    const { data, error } = await query
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < pageSize) break
  }
  return rows
}

function countBy(rows, key) {
  return Object.fromEntries(
    [...new Set(rows.map((row) => String(row[key])))].sort().map((value) => [
      value,
      rows.filter((row) => String(row[key]) === value).length,
    ]),
  )
}

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date())
const liveAttendanceStartDate = '2026-06-16'

const [
  periods,
  shiftRequests,
  assignments,
  leaveRequests,
  allocations,
  grantLots,
  punches,
  employees,
  payrollProfiles,
] = await Promise.all([
  fetchAll('gw_shift_periods', 'id, department, start_date, end_date, status, is_test_mode'),
  fetchAll(
    'gw_shift_requests',
    'id, period_id, user_id, employee_id, work_date, request_type, status, is_test',
    (query) => query.in('request_type', ['paid_leave_full', 'paid_leave_half']),
  ),
  fetchAll(
    'gw_shift_assignments',
    'id, period_id, user_id, employee_id, work_date, shift_label, work_minutes, note',
  ),
  fetchAll(
    'gw_paid_leave_requests',
    'id, employee_id, user_id, leave_date, leave_unit, request_source, request_status, shift_period_id, shift_assignment_id, scheduled_minutes_snapshot, payable_minutes_snapshot, source_key, raw_payload',
  ),
  fetchAll(
    'gw_paid_leave_consumption_allocations',
    'id, request_id, grant_lot_id, employee_id, allocated_days, voided_at',
  ),
  fetchAll(
    'gw_paid_leave_grant_lots',
    'id, employee_id, grant_date, expires_on, granted_days, grant_status',
  ),
  fetchAll(
    'gw_attendance_punches',
    'id, user_id, employee_id, work_date, punch_type, source_type, is_voided',
    (query) => query.eq('is_voided', false),
  ),
  fetchAll(
    'gw_payroll_employees',
    'id, user_id, display_name, real_name, payroll_status',
    (query) => query.eq('payroll_status', 'active'),
  ),
  fetchAll(
    'gw_payroll_calculation_profiles',
    'id, employee_id, effective_from, effective_to, calculation_type',
  ),
])

const lockedStatuses = new Set(['confirmed', 'exported', 'archived'])
const activeLeaveStatuses = new Set(['draft', 'submitted', 'approved', 'consumed'])
const approvedLeaveStatuses = new Set(['approved', 'consumed'])
const periodById = new Map(periods.map((row) => [row.id, row]))
const assignmentById = new Map(assignments.map((row) => [row.id, row]))
const leaveBySourceKey = new Map(
  leaveRequests.filter((row) => row.source_key).map((row) => [row.source_key, row]),
)
const operationalLeaveRequests = leaveRequests.filter(
  (row) => row.raw_payload?.opening_balance_adjustment !== true,
)

const confirmedPaidLeaveShiftRequests = shiftRequests.filter((row) => {
  const period = periodById.get(row.period_id)
  return !row.is_test && period && lockedStatuses.has(period.status)
})
const missingPaidLeaveSync = confirmedPaidLeaveShiftRequests.filter((row) => (
  !leaveBySourceKey.has(`shift:${row.period_id}:${row.user_id}:${row.work_date}`)
))

const activeLeaveRequests = operationalLeaveRequests.filter(
  (row) => activeLeaveStatuses.has(row.request_status),
)
const approvedLeaveRequests = operationalLeaveRequests.filter(
  (row) => approvedLeaveStatuses.has(row.request_status),
)
const allApprovedLeaveRequests = leaveRequests.filter(
  (row) => approvedLeaveStatuses.has(row.request_status),
)
const invalidPaidLeaveSnapshots = activeLeaveRequests.filter((row) => (
  Number(row.scheduled_minutes_snapshot || 0) <= 0
  || Number(row.payable_minutes_snapshot || 0) <= 0
))
const brokenPaidLeaveAssignments = activeLeaveRequests.filter((row) => (
  row.shift_assignment_id && !assignmentById.has(row.shift_assignment_id)
))

const allocatedDaysByRequest = new Map()
for (const row of allocations.filter((allocation) => !allocation.voided_at)) {
  allocatedDaysByRequest.set(
    row.request_id,
    (allocatedDaysByRequest.get(row.request_id) || 0) + Number(row.allocated_days || 0),
  )
}
const allocationMismatches = allApprovedLeaveRequests.filter((row) => {
  const expected = row.leave_unit === 'full_day' ? 1 : 0.5
  return Math.abs((allocatedDaysByRequest.get(row.id) || 0) - expected) > 0.001
})

const punchesByUserDate = new Map()
for (const punch of punches) {
  const key = `${punch.user_id || ''}:${punch.work_date}`
  const state = punchesByUserDate.get(key) || {
    workDate: punch.work_date,
    clockIn: 0,
    clockOut: 0,
    sourceTypes: new Set(),
  }
  if (punch.punch_type === 'clock_in') state.clockIn += 1
  if (punch.punch_type === 'clock_out') state.clockOut += 1
  if (punch.source_type) state.sourceTypes.add(punch.source_type)
  punchesByUserDate.set(key, state)
}
const fullDayLeavePunchConflicts = approvedLeaveRequests.filter((row) => (
  row.leave_unit === 'full_day'
  && punchesByUserDate.has(`${row.user_id || ''}:${row.leave_date}`)
))
const unpairedPunchRows = [...punchesByUserDate.values()].filter((row) => (
  row.clockIn === 0 || row.clockOut === 0 || row.clockIn !== row.clockOut
))
const openPunchDaysToday = unpairedPunchRows.filter((row) => row.workDate === today).length
const prelaunchImportFragments = unpairedPunchRows.filter((row) => (
  row.workDate < liveAttendanceStartDate
  && row.sourceTypes.size > 0
  && [...row.sourceTypes].every((sourceType) => sourceType === 'import')
)).length
const historicalUnpairedPunchDays = unpairedPunchRows.length
  - openPunchDaysToday
  - prelaunchImportFragments
const duplicatePunchDays = [...punchesByUserDate.values()].filter((row) => (
  row.clockIn > 1 || row.clockOut > 1
)).length
const punchesWithoutEmployee = punches.filter((row) => !row.employee_id)

const lockedRealPeriods = periods
  .filter((row) => !row.is_test_mode && lockedStatuses.has(row.status))
  .sort((a, b) => a.department.localeCompare(b.department, 'ja') || a.start_date.localeCompare(b.start_date))
const overlappingConfirmedPeriods = []
for (let index = 0; index < lockedRealPeriods.length; index += 1) {
  const left = lockedRealPeriods[index]
  for (let otherIndex = index + 1; otherIndex < lockedRealPeriods.length; otherIndex += 1) {
    const right = lockedRealPeriods[otherIndex]
    if (left.department !== right.department) break
    if (right.start_date > left.end_date) break
    overlappingConfirmedPeriods.push({
      department: left.department,
      left: `${left.start_date}:${left.end_date}`,
      right: `${right.start_date}:${right.end_date}`,
    })
  }
}

const profileEmployeeIds = new Set(
  payrollProfiles
    .filter((row) => (
      row.effective_from <= today
      && (!row.effective_to || row.effective_to >= today)
    ))
    .map((row) => row.employee_id),
)
const activeEmployeesWithoutPayrollProfile = employees.filter((row) => {
  const normalizedName = String(row.real_name || row.display_name || '').replace(/[\s　]/g, '')
  return normalizedName !== 'TSG君' && !profileEmployeeIds.has(row.id)
})

const severe = {
  missingPaidLeaveSync: missingPaidLeaveSync.length,
  invalidPaidLeaveSnapshots: invalidPaidLeaveSnapshots.length,
  allocationMismatches: allocationMismatches.length,
  brokenPaidLeaveAssignments: brokenPaidLeaveAssignments.length,
  fullDayLeavePunchConflicts: fullDayLeavePunchConflicts.length,
  overlappingConfirmedPeriods: overlappingConfirmedPeriods.length,
  punchesWithoutEmployee: punchesWithoutEmployee.length,
}

const report = {
  target: new URL(url).host,
  generatedAt: new Date().toISOString(),
  counts: {
    shiftPeriods: periods.length,
    shiftPeriodStatus: countBy(periods, 'status'),
    paidLeaveShiftRequests: shiftRequests.length,
    shiftAssignments: assignments.length,
    paidLeaveRequests: leaveRequests.length,
    paidLeaveRequestStatus: countBy(leaveRequests, 'request_status'),
    paidLeaveGrantLots: grantLots.length,
    attendancePunches: punches.length,
    activeEmployees: employees.length,
    payrollProfiles: payrollProfiles.length,
  },
  severe,
  warnings: {
    openPunchDaysToday,
    prelaunchImportFragments,
    historicalUnpairedPunchDays,
    duplicatePunchDays,
    activeEmployeesWithoutPayrollProfile: activeEmployeesWithoutPayrollProfile.length,
  },
  samples: {
    missingPaidLeaveSync: missingPaidLeaveSync.slice(0, 5).map((row) => ({
      periodId: row.period_id,
      workDate: row.work_date,
      requestType: row.request_type,
    })),
    overlappingConfirmedPeriods: overlappingConfirmedPeriods.slice(0, 5),
  },
}

console.log(JSON.stringify(report, null, 2))

if (process.argv.includes('--strict') && Object.values(severe).some((count) => count > 0)) {
  process.exitCode = 2
}
