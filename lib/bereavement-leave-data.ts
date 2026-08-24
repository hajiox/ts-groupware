import 'server-only'

import { isRegularEmployeeWorkStyle } from '@/lib/bereavement-leave'
import { SHIFT_COMPANY_OFF_NOTE } from '@/lib/shift-assignments'
import { adminClient } from '@/lib/supabase/admin'

export type BereavementEmployee = {
  id: string
  user_id: string | null
  employee_code: string | null
  display_name: string
  real_name: string | null
  department: string | null
  work_style: string | null
  payroll_status: string
}

export type BereavementWorkday = {
  workDate: string
  periodId: string
  assignmentId: string
  shiftLabel: string
  scheduledMinutes: number | null
}

export type BereavementWorkdaySelection = {
  requestedStartDate: string
  leaveStartDate: string
  leaveEndDate: string
  requestedDays: number
  appliedDates: string[]
  skippedDates: string[]
  workdays: BereavementWorkday[]
}

const PAID_LEAVE_SHIFT_LABELS = new Set(['有給（全休）', '有給（半休）'])

function addDays(dateText: string, days: number) {
  const [year, month, day] = dateText.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return date.toISOString().slice(0, 10)
}

function datesBetween(startDate: string, endDate: string) {
  const dates: string[] = []
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    dates.push(date)
  }
  return dates
}

export async function selectBereavementWorkdays(options: {
  userId: string
  startDate: string
  requestedDays: number
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.startDate)) {
    throw new Error('取得開始日を確認してください')
  }
  if (!Number.isInteger(options.requestedDays) || options.requestedDays < 1 || options.requestedDays > 7) {
    throw new Error('取得日数を確認してください')
  }

  const searchEndDate = addDays(options.startDate, 90)
  const { data: periods, error: periodError } = await adminClient
    .from('gw_shift_periods')
    .select('id, start_date, end_date')
    .eq('status', 'confirmed')
    .gte('end_date', options.startDate)
    .lte('start_date', searchEndDate)
    .order('start_date', { ascending: true })
  if (periodError) throw periodError

  const periodIds = (periods || []).map((period) => period.id)
  if (periodIds.length === 0) {
    throw new Error('取得開始日以降の確定シフトがありません')
  }

  const { data: assignments, error: assignmentError } = await adminClient
    .from('gw_shift_assignments')
    .select('id, period_id, work_date, shift_label, start_time, end_time, break_minutes, work_minutes, assignment_type, note')
    .eq('user_id', options.userId)
    .in('period_id', periodIds)
    .gte('work_date', options.startDate)
    .lte('work_date', searchEndDate)
    .order('work_date', { ascending: true })
  if (assignmentError) throw assignmentError

  const uniqueWorkdays = new Map<string, BereavementWorkday>()
  for (const assignment of assignments || []) {
    const shiftLabel = String(assignment.shift_label || '').trim()
    const isScheduledWorkday = assignment.assignment_type === 'staff'
      && shiftLabel.length > 0
      && assignment.note !== SHIFT_COMPANY_OFF_NOTE
      && !PAID_LEAVE_SHIFT_LABELS.has(shiftLabel)
    if (!isScheduledWorkday || uniqueWorkdays.has(assignment.work_date)) continue

    uniqueWorkdays.set(assignment.work_date, {
      workDate: assignment.work_date,
      periodId: assignment.period_id,
      assignmentId: assignment.id,
      shiftLabel,
      scheduledMinutes: assignment.work_minutes === null
        ? null
        : Number(assignment.work_minutes),
    })
  }

  const workdays = [...uniqueWorkdays.values()].slice(0, options.requestedDays)
  if (workdays.length < options.requestedDays) {
    throw new Error(
      `確定シフト上の勤務日が${options.requestedDays}日分ありません。シフト確定後に申請してください`,
    )
  }

  const appliedDates = workdays.map((day) => day.workDate)
  const leaveEndDate = appliedDates[appliedDates.length - 1]
  const appliedDateSet = new Set(appliedDates)
  const skippedDates = datesBetween(options.startDate, leaveEndDate)
    .filter((date) => !appliedDateSet.has(date))

  return {
    requestedStartDate: options.startDate,
    leaveStartDate: options.startDate,
    leaveEndDate,
    requestedDays: options.requestedDays,
    appliedDates,
    skippedDates,
    workdays,
  } satisfies BereavementWorkdaySelection
}

export async function loadBereavementEmployee(userId: string) {
  const { data, error } = await adminClient
    .from('gw_payroll_employees')
    .select('id, user_id, employee_code, display_name, real_name, department, work_style, payroll_status')
    .eq('user_id', userId)
    .eq('payroll_status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1)
  if (error) throw error
  return (data?.[0] || null) as BereavementEmployee | null
}

export async function canUserApplyForBereavementLeave(userId: string) {
  const employee = await loadBereavementEmployee(userId)
  return Boolean(employee && isRegularEmployeeWorkStyle(employee.work_style))
}

export async function loadEligibleBereavementEmployees() {
  const { data, error } = await adminClient
    .from('gw_payroll_employees')
    .select('id, user_id, employee_code, display_name, real_name, department, work_style, payroll_status')
    .eq('payroll_status', 'active')
    .not('user_id', 'is', null)
    .in('work_style', ['regular_5d_8h', 'regular_6d_6_5h'])
    .order('department', { ascending: true })
    .order('hire_date', { ascending: true })
  if (error) throw error
  return (data || []) as BereavementEmployee[]
}
