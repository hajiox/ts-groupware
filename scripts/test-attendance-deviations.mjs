import assert from 'node:assert/strict'
import { analyzeAttendanceDeviations } from '../lib/attendance-deviations.ts'

const policy = {
  roundingUnitMinutes: 15,
  clockInMethod: 'nearest',
  clockOutMethod: 'nearest',
  totalMinutesMethod: 'nearest',
  breakRules: [],
}

function assignment(overrides = {}) {
  return {
    id: 'assignment-1',
    period_id: 'period-1',
    work_date: '2026-08-20',
    shift_label: '基本勤務',
    start_time: '08:30:00',
    end_time: '17:30:00',
    break_minutes: 60,
    work_minutes: 480,
    ...overrides,
  }
}

function punch(type, iso) {
  return {
    work_date: '2026-08-20',
    punch_type: type,
    punched_at: iso,
  }
}

const delayedShift = analyzeAttendanceDeviations({
  assignments: [assignment()],
  punches: [
    punch('clock_in', '2026-08-20T00:30:00.000Z'),
    punch('clock_out', '2026-08-20T09:30:00.000Z'),
  ],
  resolutions: [],
  workStyle: 'regular_5d_8h',
  policy,
  currentDate: '2026-08-21',
})
assert.equal(delayedShift.actionable.length, 1)
assert.equal(delayedShift.actionable[0].lateMinutes, 60)
assert.equal(delayedShift.actionable[0].earlyLeaveMinutes, 0)

const noRetroactiveDeviation = analyzeAttendanceDeviations({
  assignments: [assignment()],
  punches: [
    punch('clock_in', '2026-08-20T00:30:00.000Z'),
    punch('clock_out', '2026-08-20T09:30:00.000Z'),
  ],
  resolutions: [],
  workStyle: 'regular_5d_8h',
  policy,
  currentDate: '2026-08-26',
  deviationStartDate: '2026-08-25',
})
assert.equal(noRetroactiveDeviation.issues.length, 0)

const approvedChange = analyzeAttendanceDeviations({
  assignments: [assignment()],
  punches: delayedShift.issues.length ? [
    punch('clock_in', '2026-08-20T00:30:00.000Z'),
    punch('clock_out', '2026-08-20T09:30:00.000Z'),
  ] : [],
  resolutions: [{
    work_date: '2026-08-20',
    resolution_type: 'work_schedule_changed',
    resolution_status: 'admin_confirmed',
  }],
  workStyle: 'regular_5d_8h',
  policy,
  currentDate: '2026-08-21',
})
assert.equal(approvedChange.issues.length, 0)

const hourlyDeviation = analyzeAttendanceDeviations({
  assignments: [assignment()],
  punches: [
    punch('clock_in', '2026-08-19T23:45:00.000Z'),
    punch('clock_out', '2026-08-20T08:00:00.000Z'),
  ],
  resolutions: [],
  workStyle: 'part_time_under_29_5h',
  policy,
  currentDate: '2026-08-21',
})
assert.equal(hourlyDeviation.actionable.length, 0)
assert.equal(hourlyDeviation.totals.month.lateCount, 1)
assert.equal(hourlyDeviation.totals.month.earlyLeaveCount, 1)
assert.equal(hourlyDeviation.totals.month.lateMinutes, 15)
assert.equal(hourlyDeviation.totals.month.earlyLeaveMinutes, 30)

const missingHourlyPunches = analyzeAttendanceDeviations({
  assignments: [assignment()],
  punches: [],
  resolutions: [],
  workStyle: 'full_time_part',
  policy,
  currentDate: '2026-08-21',
})
assert.equal(missingHourlyPunches.actionable.length, 1)
assert.equal(missingHourlyPunches.actionable[0].issueKind, 'missing_all')

const employeeAnsweredMissingPunch = analyzeAttendanceDeviations({
  assignments: [assignment()],
  punches: [],
  resolutions: [{
    work_date: '2026-08-20',
    resolution_type: 'absence',
    resolution_status: 'employee_answered',
  }],
  workStyle: 'regular_5d_8h',
  policy,
  currentDate: '2026-08-21',
})
assert.equal(employeeAnsweredMissingPunch.issues.length, 1)
assert.equal(employeeAnsweredMissingPunch.actionable.length, 0)

const managerConfirmedAbsence = analyzeAttendanceDeviations({
  assignments: [assignment()],
  punches: [],
  resolutions: [{
    work_date: '2026-08-20',
    resolution_type: 'absence',
    resolution_status: 'admin_confirmed',
  }],
  workStyle: 'regular_5d_8h',
  policy,
  currentDate: '2026-08-21',
})
assert.equal(managerConfirmedAbsence.issues.length, 0)
assert.equal(managerConfirmedAbsence.actionable.length, 0)

console.log('attendance deviation tests passed')
