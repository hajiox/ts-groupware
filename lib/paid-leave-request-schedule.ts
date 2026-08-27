import { adminClient } from '@/lib/supabase/admin'

type LeaveUnit = 'full_day' | 'half_day'

type AssignmentRow = {
  id: string
  period_id: string
  work_date: string
  shift_label: string | null
  start_time: string | null
  end_time: string | null
  break_minutes: number | null
  work_minutes: number | null
  note: string | null
}

type ScheduleBasis = {
  startTime: string | null
  endTime: string | null
  breakMinutes: number
  scheduledMinutes: number
}

export type PaidLeaveRequestSchedule = {
  periodId: string
  assignmentId: string | null
  startTime: string | null
  endTime: string | null
  breakMinutes: number
  scheduledMinutes: number
  source: 'confirmed_assignment' | 'hr_profile' | 'nearby_assignment'
  convertsNonWorkday: boolean
  previousShiftRequestType: string | null
}

export type PaidLeaveScheduleResult =
  | { ok: true; schedule: PaidLeaveRequestSchedule }
  | { ok: false; status: number; error: string }

function elapsedMinutes(startTime: string | null, endTime: string | null) {
  if (!startTime || !endTime) return 0
  const start = startTime.slice(0, 5).split(':').map(Number)
  const end = endTime.slice(0, 5).split(':').map(Number)
  if (start.length !== 2 || end.length !== 2 || [...start, ...end].some((value) => !Number.isFinite(value))) return 0
  let minutes = end[0] * 60 + end[1] - (start[0] * 60 + start[1])
  if (minutes < 0) minutes += 24 * 60
  return minutes
}

function assignmentBasis(assignment: AssignmentRow | null | undefined): ScheduleBasis | null {
  if (!assignment) return null
  const breakMinutes = Math.max(0, Number(assignment.break_minutes || 0))
  const scheduledMinutes = Number(assignment.work_minutes || 0)
    || Math.max(0, elapsedMinutes(assignment.start_time, assignment.end_time) - breakMinutes)
  if (scheduledMinutes <= 0) return null
  return {
    startTime: assignment.start_time,
    endTime: assignment.end_time,
    breakMinutes,
    scheduledMinutes,
  }
}

function profileBasis(rawPayload: unknown): ScheduleBasis | null {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return null
  const profile = (rawPayload as Record<string, unknown>).hr_profile
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null
  const row = profile as Record<string, unknown>
  const startTime = typeof row.basic_work_start === 'string' ? row.basic_work_start : null
  const endTime = typeof row.basic_work_end === 'string' ? row.basic_work_end : null
  const breakMinutes = Math.max(0, Number(row.basic_break_minutes || 0))
  const scheduledMinutes = Math.max(0, elapsedMinutes(startTime, endTime) - breakMinutes)
  if (scheduledMinutes <= 0) return null
  return { startTime, endTime, breakMinutes, scheduledMinutes }
}

function dateDistance(left: string, right: string) {
  const leftDate = Date.parse(`${left}T00:00:00Z`)
  const rightDate = Date.parse(`${right}T00:00:00Z`)
  return Math.abs(leftDate - rightDate)
}

function isWorkAssignment(assignment: AssignmentRow) {
  return Boolean(
    assignment.shift_label
    && assignment.note !== '__company_off__'
    && assignment.note !== '__paid_leave_full__'
    && assignmentBasis(assignment),
  )
}

export async function resolvePaidLeaveRequestSchedule(options: {
  employeeId: string
  userId: string
  leaveDate: string
  leaveUnit: LeaveUnit
}): Promise<PaidLeaveScheduleResult> {
  const { data: employee, error: employeeError } = await adminClient
    .from('gw_payroll_employees')
    .select('department, raw_payload')
    .eq('id', options.employeeId)
    .maybeSingle()
  if (employeeError) throw employeeError
  if (!employee?.department) {
    return {
      ok: false,
      status: 400,
      error: '所属部署が未設定のため確定シフトを特定できません。人事管理で所属部署を設定してください',
    }
  }

  const { data: periods, error: periodsError } = await adminClient
    .from('gw_shift_periods')
    .select('id, start_date, end_date, status')
    .in('status', ['confirmed', 'exported', 'archived'])
    .eq('is_test_mode', false)
    .eq('department', employee.department)
    .lte('start_date', options.leaveDate)
    .gte('end_date', options.leaveDate)
    .order('start_date', { ascending: false })
    .limit(1)
  if (periodsError) throw periodsError
  const period = periods?.[0]
  if (!period) {
    return {
      ok: false,
      status: 400,
      error: 'この日の確定シフトがありません。シフト確定前は希望回収画面から申請してください',
    }
  }

  const assignmentFilter = `employee_id.eq.${options.employeeId},user_id.eq.${options.userId}`
  const [assignmentResult, periodAssignmentsResult, requestResult] = await Promise.all([
    adminClient
      .from('gw_shift_assignments')
      .select('id, period_id, work_date, shift_label, start_time, end_time, break_minutes, work_minutes, note')
      .eq('period_id', period.id)
      .eq('work_date', options.leaveDate)
      .or(assignmentFilter)
      .order('updated_at', { ascending: false })
      .limit(1),
    adminClient
      .from('gw_shift_assignments')
      .select('id, period_id, work_date, shift_label, start_time, end_time, break_minutes, work_minutes, note')
      .eq('period_id', period.id)
      .or(assignmentFilter)
      .order('work_date', { ascending: true }),
    adminClient
      .from('gw_shift_requests')
      .select('request_type')
      .eq('period_id', period.id)
      .eq('user_id', options.userId)
      .eq('work_date', options.leaveDate)
      .maybeSingle(),
  ])
  const lookupError = assignmentResult.error
    || periodAssignmentsResult.error
    || requestResult.error
  if (lookupError) throw lookupError

  const assignment = (assignmentResult.data?.[0] || null) as AssignmentRow | null
  const confirmedBasis = assignmentBasis(assignment)
  if (confirmedBasis) {
    return {
      ok: true,
      schedule: {
        periodId: period.id,
        assignmentId: assignment!.id,
        ...confirmedBasis,
        source: 'confirmed_assignment',
        convertsNonWorkday: false,
        previousShiftRequestType: requestResult.data?.request_type || null,
      },
    }
  }

  if (options.leaveUnit === 'half_day') {
    return {
      ok: false,
      status: 400,
      error: '確定シフトで休みの日は半休にできません。全休を選ぶか、管理者に勤務時間の設定を依頼してください',
    }
  }

  const employeeProfileBasis = profileBasis(employee.raw_payload)
  const nearbyAssignment = ((periodAssignmentsResult.data || []) as AssignmentRow[])
    .filter(isWorkAssignment)
    .sort((left, right) => dateDistance(left.work_date, options.leaveDate) - dateDistance(right.work_date, options.leaveDate))[0]
  const nearbyBasis = assignmentBasis(nearbyAssignment)
  const fallbackBasis = employeeProfileBasis || nearbyBasis
  if (!fallbackBasis) {
    return {
      ok: false,
      status: 400,
      error: '有給の基準となる所定勤務時間が未設定です。管理者が人事設定または同期間の勤務時間を登録してください',
    }
  }

  return {
    ok: true,
    schedule: {
      periodId: period.id,
      assignmentId: null,
      ...fallbackBasis,
      source: employeeProfileBasis ? 'hr_profile' : 'nearby_assignment',
      convertsNonWorkday: true,
      previousShiftRequestType: requestResult.data?.request_type || null,
    },
  }
}
