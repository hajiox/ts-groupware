import {
  projectPaidLeaveAttendance,
  type PaidLeaveAttendanceProjection,
  type PaidLeaveUnit,
} from '@/lib/paid-leave-attendance'
import { loadAttendanceCalculationPolicy } from '@/lib/payroll-attendance-policy-data'
import { adminClient } from '@/lib/supabase/admin'

export type AttendancePunchForPaidLeave = {
  user_id: string | null
  punch_type: 'clock_in' | 'clock_out'
  work_date: string
  punched_at: string
  is_voided?: boolean
  break_override_minutes?: number | string | null
}

type EmployeeRow = {
  id: string
  user_id: string | null
  raw_payload: Record<string, unknown> | null
}

type PaidLeaveRow = {
  id: string
  employee_id: string
  user_id: string | null
  leave_date: string
  leave_unit: PaidLeaveUnit
  request_source: string
  request_status: string
  shift_assignment_id: string | null
  scheduled_minutes_snapshot: number | null
  payable_minutes_snapshot: number | null
  raw_payload: Record<string, unknown> | null
}

type AssignmentRow = {
  id: string
  start_time: string | null
  end_time: string | null
  break_minutes: number | null
  work_minutes: number | null
}

export type PaidLeaveAttendanceDay = PaidLeaveAttendanceProjection & {
  requestId: string
  employeeId: string
  userId: string
  workDate: string
  leaveUnit: PaidLeaveUnit
  requestSource: string
  scheduledMinutes: number
  payableMinutes: number
}

function jstTime(value: string | null | undefined) {
  if (!value) return null
  return new Date(value).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function numberOrNull(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function hrProfile(rawPayload: Record<string, unknown> | null) {
  const profile = rawPayload?.hr_profile
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return {
      basicWorkStart: null,
      basicWorkEnd: null,
      basicBreakMinutes: null,
    }
  }
  const row = profile as {
    basic_work_start?: string | null
    basic_work_end?: string | null
    basic_break_minutes?: number | string | null
  }
  return {
    basicWorkStart: row.basic_work_start || null,
    basicWorkEnd: row.basic_work_end || null,
    basicBreakMinutes: numberOrNull(row.basic_break_minutes),
  }
}

export async function loadPaidLeaveAttendanceDays(options: {
  userIds: string[]
  startDate: string
  endDate: string
  punches: AttendancePunchForPaidLeave[]
}) {
  const userIds = [...new Set(options.userIds.filter(Boolean))]
  if (userIds.length === 0) return [] as PaidLeaveAttendanceDay[]

  const [
    { data: employees, error: employeesError },
    attendancePolicy,
  ] = await Promise.all([
    adminClient
      .from('gw_payroll_employees')
      .select('id, user_id, raw_payload')
      .in('user_id', userIds),
    loadAttendanceCalculationPolicy(options.endDate),
  ])
  if (employeesError) throw employeesError

  const employeeRows = (employees || []) as EmployeeRow[]
  const employeeIds = employeeRows.map((employee) => employee.id)
  if (employeeIds.length === 0) return [] as PaidLeaveAttendanceDay[]

  const { data: paidLeaveRows, error: paidLeaveError } = await adminClient
    .from('gw_paid_leave_requests')
    .select('id, employee_id, user_id, leave_date, leave_unit, request_source, request_status, shift_assignment_id, scheduled_minutes_snapshot, payable_minutes_snapshot, raw_payload')
    .in('employee_id', employeeIds)
    .in('request_status', ['approved', 'consumed'])
    .gte('leave_date', options.startDate)
    .lte('leave_date', options.endDate)
    .order('leave_date', { ascending: true })
  if (paidLeaveError) throw paidLeaveError

  const leaveRows = ((paidLeaveRows || []) as PaidLeaveRow[])
    .filter((leave) => leave.raw_payload?.opening_balance_adjustment !== true)
  const assignmentIds = [...new Set(
    leaveRows
      .map((leave) => leave.shift_assignment_id)
      .filter((id): id is string => Boolean(id)),
  )]
  let assignmentRows: AssignmentRow[] = []
  if (assignmentIds.length > 0) {
    const { data: assignments, error: assignmentError } = await adminClient
      .from('gw_shift_assignments')
      .select('id, start_time, end_time, break_minutes, work_minutes')
      .in('id', assignmentIds)
    if (assignmentError) throw assignmentError
    assignmentRows = (assignments || []) as AssignmentRow[]
  }

  const employeeById = new Map(employeeRows.map((employee) => [employee.id, employee]))
  const assignmentById = new Map(assignmentRows.map((assignment) => [assignment.id, assignment]))
  const punchesByUserDate = new Map<string, AttendancePunchForPaidLeave[]>()
  for (const punch of options.punches) {
    if (!punch.user_id || punch.is_voided) continue
    const key = `${punch.user_id}:${punch.work_date}`
    const rows = punchesByUserDate.get(key) || []
    rows.push(punch)
    punchesByUserDate.set(key, rows)
  }

  const days: PaidLeaveAttendanceDay[] = []
  for (const leave of leaveRows) {
    const employee = employeeById.get(leave.employee_id)
    const userId = leave.user_id || employee?.user_id
    if (!employee || !userId) continue

    const assignment = leave.shift_assignment_id
      ? assignmentById.get(leave.shift_assignment_id) || null
      : null
    const profile = hrProfile(employee.raw_payload)
    const dayPunches = punchesByUserDate.get(`${userId}:${leave.leave_date}`) || []
    const clockIns = dayPunches
      .filter((punch) => punch.punch_type === 'clock_in')
      .sort((a, b) => a.punched_at.localeCompare(b.punched_at))
    const clockOuts = dayPunches
      .filter((punch) => punch.punch_type === 'clock_out')
      .sort((a, b) => b.punched_at.localeCompare(a.punched_at))
    const clockIn = clockIns[0] || null
    const clockOut = clockOuts[0] || null
    const physicalBreakMinutes = numberOrNull(
      clockOut?.break_override_minutes ?? clockIn?.break_override_minutes,
    )
    const projection = projectPaidLeaveAttendance({
      leaveUnit: leave.leave_unit,
      scheduledMinutes: leave.scheduled_minutes_snapshot ?? assignment?.work_minutes,
      payableMinutes: leave.payable_minutes_snapshot,
      assignmentStartTime: assignment?.start_time,
      assignmentEndTime: assignment?.end_time,
      assignmentBreakMinutes: assignment?.break_minutes,
      profileStartTime: profile.basicWorkStart,
      profileEndTime: profile.basicWorkEnd,
      profileBreakMinutes: profile.basicBreakMinutes,
      physicalClockInTime: jstTime(clockIn?.punched_at),
      physicalClockOutTime: jstTime(clockOut?.punched_at),
      physicalBreakMinutes,
      breakRules: attendancePolicy.breakRules,
    })

    days.push({
      ...projection,
      requestId: leave.id,
      employeeId: leave.employee_id,
      userId,
      workDate: leave.leave_date,
      leaveUnit: leave.leave_unit,
      requestSource: leave.request_source,
      scheduledMinutes: Number(leave.scheduled_minutes_snapshot ?? assignment?.work_minutes ?? 0),
      payableMinutes: Number(leave.payable_minutes_snapshot || 0),
    })
  }

  return days
}
