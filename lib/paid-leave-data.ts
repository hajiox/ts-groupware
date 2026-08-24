import {
  addYearsToISODate,
  calculateAttendanceEligibility,
  calculateOrdinaryPaidLeaveWage,
  differenceInCalendarDays,
  estimatePaidLeaveGrantSchedule,
  grantDateForSequence,
  nextGrantSequence,
  statutoryGrantDays,
  type ISODate,
  type PaidLeaveGrantScheduleEstimate,
} from '@/lib/paid-leave'
import { loadAttendanceCalculationPolicy } from '@/lib/payroll-attendance-policy-data'
import { summarizeAttendance, type PayrollCalculationType } from '@/lib/payroll-calculation'
import { adminClient } from '@/lib/supabase/admin'

type EmployeeRow = {
  id: string
  user_id: string | null
  employee_code: string | null
  display_name: string
  real_name: string | null
  hire_date: string | null
  department: string | null
  work_style: string | null
  payroll_status: string
}

type GrantRow = {
  id: string
  employee_id: string
  user_id: string | null
  grant_date: string
  expires_on: string
  granted_days: number | string
  grant_source: string
  grant_status: 'granted' | 'withheld' | 'voided'
  initial_assumption: boolean
  attendance_rate: number | string | null
  notes: string | null
}

type RequestRow = {
  id: string
  employee_id: string
  user_id: string | null
  leave_date: string
  leave_unit: 'full_day' | 'half_day' | 'half_day_am' | 'half_day_pm'
  requested_days: number | string
  request_source: string
  request_status: string
  scheduled_minutes_snapshot: number | null
  hourly_rate_snapshot: number | string | null
  payable_minutes_snapshot: number | null
  paid_wage_amount: number | string | null
  employee_memo: string | null
  manager_memo: string | null
  requested_at: string
  raw_payload: Record<string, unknown> | null
}

type ResolutionRow = {
  id: string
  employee_id: string
  user_id: string | null
  work_date: string
  shift_period_id: string | null
  shift_assignment_id: string | null
  scheduled_minutes_snapshot: number | null
  resolution_type: string
  resolution_status: string
  paid_leave_request_id: string | null
  employee_memo: string | null
  manager_memo: string | null
  employee_answered_at: string | null
  confirmed_at: string | null
}

type AssignmentRow = {
  id: string
  period_id: string
  user_id: string | null
  employee_id: string | null
  work_date: string
  shift_label: string | null
  start_time: string | null
  end_time: string | null
  break_minutes: number
  work_minutes: number | null
  note: string | null
}

type PunchRow = {
  work_date: string
  punched_at: string
  punch_type: 'clock_in' | 'clock_out'
  break_override_minutes?: number | string | null
}

const ACTIVE_REQUEST_STATUSES = new Set(['approved', 'consumed'])
const PAID_LEAVE_SHIFT_LABELS = new Set(['有給（全休）', '有給（半休）'])
const PAID_LEAVE_SYSTEM_START_DATE = '2026-08-01' as ISODate
const PAID_LEAVE_ATTENDANCE_DISPLAY_DATE = '2026-11-01' as ISODate
const PAID_LEAVE_ATTENDANCE_MEASUREMENT_END_DATE = '2026-10-31' as ISODate
const LIVE_ATTENDANCE_START_DATE = '2026-06-16' as ISODate
const PAID_LEAVE_EXCLUDED_NAMES = new Set(['佐藤正彦', '佐藤ちさと', 'TSG君'])

function normalizedPaidLeaveName(value: string | null | undefined) {
  return (value || '').replace(/[\s　]/g, '')
}

export function isPaidLeaveManagedEmployeeName(value: string | null | undefined) {
  return !PAID_LEAVE_EXCLUDED_NAMES.has(normalizedPaidLeaveName(value))
}

function toNumber(value: number | string | null | undefined) {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function isOpeningBalanceAdjustment(row: {
  raw_payload?: Record<string, unknown> | null
}) {
  return row.raw_payload?.opening_balance_adjustment === true
}

export function jstDate(date = new Date()): ISODate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date) as ISODate
}

export function addDays(dateText: string, days: number) {
  const [year, month, day] = dateText.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

export function addMonths(dateText: string, months: number) {
  const [year, month, day] = dateText.split('-').map(Number)
  const target = new Date(Date.UTC(year, month - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return target.toISOString().slice(0, 10)
}

function displayName(employee: EmployeeRow) {
  return employee.real_name || employee.display_name
}

function normalizedEmployeeName(employee: EmployeeRow) {
  return normalizedPaidLeaveName(displayName(employee))
}

function isPaidLeaveManagedEmployee(employee: EmployeeRow) {
  return isPaidLeaveManagedEmployeeName(displayName(employee))
}

async function voidExcludedPaidLeaveData(employee: EmployeeRow) {
  const { data: lots, error: lotsError } = await adminClient
    .from('gw_paid_leave_grant_lots')
    .select('id, grant_date, granted_days, grant_source, grant_status, source_key')
    .eq('employee_id', employee.id)
    .neq('grant_status', 'voided')
  if (lotsError) throw lotsError

  if (lots?.length) {
    const lotIds = lots.map((lot) => lot.id)
    const { data: voidedLots, error: voidLotsError } = await adminClient
      .from('gw_paid_leave_grant_lots')
      .update({
        grant_status: 'voided',
        notes: '有給管理対象外のため無効化（2026-07-26）',
        updated_at: new Date().toISOString(),
      })
      .in('id', lotIds)
      .neq('grant_status', 'voided')
      .select('id')
    if (voidLotsError) throw voidLotsError

    const voidedIds = new Set((voidedLots || []).map((lot) => lot.id))
    const audits = lots
      .filter((lot) => voidedIds.has(lot.id))
      .map((lot) => ({
        employee_id: employee.id,
        user_id: employee.user_id,
        entity_type: 'grant_lot',
        entity_id: lot.id,
        action: 'void',
        actor_type: 'system',
        source: 'paid_leave_exclusion_2026',
        before_payload: lot,
        after_payload: {
          grant_status: 'voided',
          reason: '有給管理対象外',
        },
      }))
    if (audits.length) {
      const { error: auditError } = await adminClient.from('gw_paid_leave_audit_logs').insert(audits)
      if (auditError) throw auditError
    }
  }

  const { error: requestError } = await adminClient
    .from('gw_paid_leave_requests')
    .update({
      request_status: 'voided',
      manager_memo: '有給管理対象外のため無効化（2026-07-26）',
      updated_at: new Date().toISOString(),
    })
    .eq('employee_id', employee.id)
    .in('request_status', ['draft', 'submitted', 'approved'])
  if (requestError) throw requestError

  const { error: resolutionError } = await adminClient
    .from('gw_workday_resolutions')
    .update({
      resolution_status: 'voided',
      manager_memo: '有給管理対象外のため無効化（2026-07-26）',
      updated_at: new Date().toISOString(),
    })
    .eq('employee_id', employee.id)
    .in('resolution_status', ['pending', 'employee_answered', 'reopened'])
    .in('resolution_type', ['paid_leave_full', 'paid_leave_half'])
  if (resolutionError) throw resolutionError

  const { error: profileError } = await adminClient
    .from('gw_paid_leave_profiles')
    .update({
      next_grant_date: null,
      projected_grant_days: 0,
      notes: '有給管理対象外: 佐藤正彦・佐藤ちさと・TSG君',
      updated_at: new Date().toISOString(),
    })
    .eq('employee_id', employee.id)
  if (profileError) throw profileError
}

function minutesBetween(startTime: string | null, endTime: string | null, breakMinutes = 0) {
  if (!startTime || !endTime) return null
  const [startHour, startMinute] = startTime.slice(0, 5).split(':').map(Number)
  const [endHour, endMinute] = endTime.slice(0, 5).split(':').map(Number)
  let minutes = (endHour * 60 + endMinute) - (startHour * 60 + startMinute)
  if (minutes < 0) minutes += 1440
  return Math.max(0, minutes - Math.max(0, breakMinutes))
}

async function loadEmployee(userId: string) {
  const { data, error } = await adminClient
    .from('gw_payroll_employees')
    .select('id, user_id, employee_code, display_name, real_name, hire_date, department, work_style, payroll_status')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return data as EmployeeRow | null
}

async function loadConfirmedAssignments(employee: EmployeeRow, startDate: string, endDate: string) {
  const { data: periods, error: periodError } = await adminClient
    .from('gw_shift_periods')
    .select('id')
    .in('status', ['confirmed', 'exported', 'archived'])
    .eq('is_test_mode', false)
    .gte('end_date', startDate)
    .lte('start_date', endDate)

  if (periodError) throw periodError
  const periodIds = (periods || []).map((period) => period.id)
  if (periodIds.length === 0) return [] as AssignmentRow[]

  let query = adminClient
    .from('gw_shift_assignments')
    .select('id, period_id, user_id, employee_id, work_date, shift_label, start_time, end_time, break_minutes, work_minutes, note')
    .in('period_id', periodIds)
    .gte('work_date', startDate)
    .lte('work_date', endDate)
    .order('work_date', { ascending: true })

  query = employee.user_id
    ? query.eq('user_id', employee.user_id)
    : query.eq('employee_id', employee.id)

  const { data, error } = await query
  if (error) throw error
  return (data || []) as AssignmentRow[]
}

async function loadPunchDates(employee: EmployeeRow, startDate: string, endDate: string) {
  let query = adminClient
    .from('gw_attendance_punches')
    .select('work_date, punched_at, punch_type, break_override_minutes')
    .eq('is_voided', false)
    .gte('work_date', startDate)
    .lte('work_date', endDate)
    .order('punched_at', { ascending: true })

  query = employee.user_id
    ? query.eq('user_id', employee.user_id)
    : query.eq('employee_id', employee.id)

  const { data, error } = await query
  if (error) throw error
  return (data || []) as PunchRow[]
}

function validPunchDateSet(punches: PunchRow[]) {
  const states = new Map<string, { hasIn: boolean; hasOut: boolean }>()
  for (const punch of punches) {
    const state = states.get(punch.work_date) || { hasIn: false, hasOut: false }
    if (punch.punch_type === 'clock_in') state.hasIn = true
    if (punch.punch_type === 'clock_out') state.hasOut = true
    states.set(punch.work_date, state)
  }
  return new Set(
    [...states.entries()]
      .filter(([, state]) => state.hasIn && state.hasOut)
      .map(([workDate]) => workDate),
  )
}

async function inferGrantSchedule(employee: EmployeeRow, asOf: ISODate) {
  if (['regular_5d_8h', 'regular_6d_6_5h', 'full_time_part', 'officer'].includes(employee.work_style || '')) {
    return { kind: 'standard' } as PaidLeaveGrantScheduleEstimate
  }

  const { data: workbookSnapshots, error: workbookError } = await adminClient
    .from('gw_paid_leave_average_snapshots')
    .select('reference_start, reference_end, worked_days, average_minutes_per_worked_day')
    .eq('employee_id', employee.id)
    .eq('source_type', 'shift_workbook')
    .order('reference_end', { ascending: false })
    .limit(1)
  if (workbookError) throw workbookError

  const workbook = workbookSnapshots?.[0]
  if (workbook) {
    const observedStart = employee.hire_date && employee.hire_date > workbook.reference_start
      ? employee.hire_date
      : workbook.reference_start
    const observedDays = Math.max(
      1,
      differenceInCalendarDays(workbook.reference_end as ISODate, observedStart as ISODate) + 1,
    )
    const weeklyScheduledDays = Math.max(
      1,
      Math.min(5, Math.round(toNumber(workbook.worked_days) / (observedDays / 7))),
    )
    return estimatePaidLeaveGrantSchedule({
      weeklyScheduledDays,
      weeklyScheduledMinutes: toNumber(workbook.average_minutes_per_worked_day) * weeklyScheduledDays,
    })
  }

  const startDate = addDays(asOf, -365)
  const assignments = await loadConfirmedAssignments(employee, startDate, asOf)
  const workedDates = new Set(
    assignments
      .filter((assignment) => Boolean(assignment.shift_label))
      .map((assignment) => assignment.work_date),
  )
  const assignmentDates = [...workedDates].sort()
  const observedDays = assignmentDates.length > 1
    ? Math.max(28, differenceInCalendarDays(
      assignmentDates.at(-1) as ISODate,
      assignmentDates[0] as ISODate,
    ) + 1)
    : 0
  const observedWeeks = observedDays / 7
  const weeklyMinutes = observedWeeks > 0 ? assignments.reduce((sum, assignment) => {
    const minutes = assignment.work_minutes ?? minutesBetween(assignment.start_time, assignment.end_time, assignment.break_minutes) ?? 0
    return sum + minutes
  }, 0) / observedWeeks : 0

  if (workedDates.size > 0 && observedWeeks > 0) {
    const weeklyScheduledDays = Math.max(1, Math.min(5, Math.round(workedDates.size / observedWeeks)))
    return estimatePaidLeaveGrantSchedule({
      weeklyScheduledDays,
      weeklyScheduledMinutes: weeklyMinutes,
    })
  }

  if (employee.work_style === 'part_time_under_29_5h') {
    return estimatePaidLeaveGrantSchedule({ weeklyScheduledDays: 4, weeklyScheduledMinutes: 29.5 * 60 })
  }
  return { kind: 'standard' } as PaidLeaveGrantScheduleEstimate
}

async function attendanceForPeriod(employee: EmployeeRow, startDate: string, endDate: string) {
  const [assignments, punches, requestsResult, resolutionsResult] = await Promise.all([
    loadConfirmedAssignments(employee, startDate, endDate),
    loadPunchDates(employee, startDate, endDate),
    adminClient
      .from('gw_paid_leave_requests')
      .select('leave_date, leave_unit, request_status, raw_payload')
      .eq('employee_id', employee.id)
      .gte('leave_date', startDate)
      .lte('leave_date', endDate)
      .in('request_status', ['approved', 'consumed']),
    adminClient
      .from('gw_workday_resolutions')
      .select('work_date, resolution_type')
      .eq('employee_id', employee.id)
      .eq('resolution_status', 'admin_confirmed')
      .gte('work_date', startDate)
      .lte('work_date', endDate)
      .in('resolution_type', ['work_schedule_changed', 'employer_shutdown', 'bereavement_leave']),
  ])
  if (requestsResult.error || resolutionsResult.error) throw requestsResult.error || resolutionsResult.error

  const excludedDates = new Set(
    (resolutionsResult.data || [])
      .filter((row) => row.resolution_type !== 'bereavement_leave')
      .map((row) => row.work_date),
  )
  const bereavementDates = new Set(
    (resolutionsResult.data || [])
      .filter((row) => row.resolution_type === 'bereavement_leave')
      .map((row) => row.work_date),
  )
  const scheduledDates = new Set(
    assignments
      .filter((assignment) => Boolean(assignment.shift_label) && !excludedDates.has(assignment.work_date))
      .map((assignment) => assignment.work_date),
  )
  const validPunchDates = validPunchDateSet(punches)
  const paidLeaveByDate = new Map<string, number>()
  for (const request of requestsResult.data || []) {
    if (isOpeningBalanceAdjustment(request)) continue
    const days = request.leave_unit === 'full_day' ? 1 : 0.5
    paidLeaveByDate.set(request.leave_date, Math.max(paidLeaveByDate.get(request.leave_date) || 0, days))
  }
  const numeratorDays = [...scheduledDates].reduce((sum, workDate) => {
    if (validPunchDates.has(workDate)) return sum + 1
    if (bereavementDates.has(workDate)) return sum + 1
    return sum + Math.min(1, paidLeaveByDate.get(workDate) || 0)
  }, 0)

  return {
    numeratorDays,
    denominatorDays: scheduledDates.size,
  }
}

export async function syncPaidLeaveAccount(employee: EmployeeRow, actorUserId?: string | null) {
  if (
    !employee.hire_date
    || employee.payroll_status !== 'active'
    || !isPaidLeaveManagedEmployee(employee)
  ) return
  const today = jstDate()
  const projectionDate = today < PAID_LEAVE_SYSTEM_START_DATE ? PAID_LEAVE_SYSTEM_START_DATE : today
  const schedule = await inferGrantSchedule(employee, projectionDate)
  const { data: profile, error: profileError } = await adminClient
    .from('gw_paid_leave_profiles')
    .select('id, projection_calculated_at, attendance_threshold, grant_when_equal_to_threshold, assume_first_assessment_eligible')
    .eq('employee_id', employee.id)
    .maybeSingle()
  if (profileError) throw profileError

  const { data: currentProfile, error: upsertProfileError } = profile
    ? { data: profile, error: null }
    : await adminClient
      .from('gw_paid_leave_profiles')
      .upsert({
        employee_id: employee.id,
        user_id: employee.user_id,
        created_by: actorUserId || null,
        updated_by: actorUserId || null,
      }, { onConflict: 'employee_id' })
      .select('id, projection_calculated_at, attendance_threshold, grant_when_equal_to_threshold, assume_first_assessment_eligible')
      .single()
  if (upsertProfileError) throw upsertProfileError

  const initialSync = !currentProfile?.projection_calculated_at
  const { data: existingLots, error: lotsError } = await adminClient
    .from('gw_paid_leave_grant_lots')
    .select('grant_date, grant_status, grant_source')
    .eq('employee_id', employee.id)
    .neq('grant_status', 'voided')
  if (lotsError) throw lotsError
  const existingDates = new Set((existingLots || []).map((lot) => lot.grant_date))
  const hasGrantedBalance = (existingLots || []).some((lot) => lot.grant_status === 'granted')

  const openingSequence = nextGrantSequence(
    employee.hire_date as ISODate,
    PAID_LEAVE_SYSTEM_START_DATE,
  ).sequenceIndex - 1
  const openingDays = openingSequence >= 0 ? statutoryGrantDays(openingSequence, schedule) : 0
  const shouldCreateOpeningGrant = (
    !hasGrantedBalance
    && !PAID_LEAVE_EXCLUDED_NAMES.has(normalizedEmployeeName(employee))
    && employee.work_style !== 'officer'
    && openingDays > 0
  )

  if (shouldCreateOpeningGrant) {
    const sourceKey = `paid-leave-system-opening-2026:${employee.id}`
    const { error: openingError } = await adminClient
      .from('gw_paid_leave_grant_lots')
      .insert({
        employee_id: employee.id,
        user_id: employee.user_id,
        grant_date: PAID_LEAVE_SYSTEM_START_DATE,
        expires_on: addYearsToISODate(PAID_LEAVE_SYSTEM_START_DATE, 2),
        granted_days: openingDays,
        grant_source: 'initial_company_assumption',
        grant_status: 'granted',
        service_months: 6 + openingSequence * 12,
        scheduled_week_days: schedule.kind === 'proportional' ? schedule.weeklyScheduledDays : null,
        annual_scheduled_days: schedule.kind === 'proportional' ? schedule.annualScheduledDays || null : null,
        initial_assumption: true,
        source_key: sourceKey,
        notes: '制度開始時みなし付与（2026年8月1日）。初回は過去出勤率を満たしたものとして付与',
        created_by: actorUserId || null,
      })
    if (openingError && openingError.code !== '23505') throw openingError
    existingDates.add(PAID_LEAVE_SYSTEM_START_DATE)
  }

  const dueLots: Record<string, unknown>[] = []
  const latestDueSequence = nextGrantSequence(employee.hire_date as ISODate, today).sequenceIndex - 1
  for (let sequenceIndex = 0; sequenceIndex < 50; sequenceIndex += 1) {
    const grantDate = grantDateForSequence(employee.hire_date as ISODate, sequenceIndex)
    if (grantDate > today) break
    if (grantDate < PAID_LEAVE_SYSTEM_START_DATE) continue
    const expiresOn = addYearsToISODate(grantDate, 2)
    if (expiresOn <= today || existingDates.has(grantDate)) continue
    if (initialSync && sequenceIndex !== latestDueSequence) continue

    const days = statutoryGrantDays(sequenceIndex, schedule)
    if (days <= 0) continue
    const referenceStart = sequenceIndex === 0 ? employee.hire_date : grantDateForSequence(employee.hire_date as ISODate, sequenceIndex - 1)
    const referenceEnd = addDays(grantDate, -1)
    const attendance = initialSync
      ? { numeratorDays: 0, denominatorDays: 0 }
      : await attendanceForPeriod(employee, referenceStart, referenceEnd)
    const eligibility = calculateAttendanceEligibility({
      ...attendance,
      threshold: toNumber(currentProfile?.attendance_threshold) || 0.8,
      thresholdInclusive: Boolean(currentProfile?.grant_when_equal_to_threshold),
    })
    const assumed = initialSync
    const eligible = assumed || eligibility.eligible === true

    dueLots.push({
      employee_id: employee.id,
      user_id: employee.user_id,
      grant_date: grantDate,
      expires_on: expiresOn,
      granted_days: eligible ? days : 0,
      grant_source: assumed
        ? 'initial_company_assumption'
        : schedule.kind === 'proportional' ? 'statutory_proportional' : 'statutory_standard',
      grant_status: eligible ? 'granted' : 'withheld',
      service_months: 6 + sequenceIndex * 12,
      scheduled_week_days: schedule.kind === 'proportional' ? schedule.weeklyScheduledDays : null,
      annual_scheduled_days: schedule.kind === 'proportional' ? schedule.annualScheduledDays || null : null,
      attendance_reference_start: referenceStart,
      attendance_reference_end: referenceEnd,
      attendance_numerator_days: attendance.numeratorDays,
      attendance_denominator_days: attendance.denominatorDays,
      attendance_rate: eligibility.rate,
      attendance_threshold: toNumber(currentProfile?.attendance_threshold) || 0.8,
      grant_when_equal_to_threshold: Boolean(currentProfile?.grant_when_equal_to_threshold),
      initial_assumption: assumed,
      notes: assumed ? '初期移行: 過去出勤率不明のため会社みなし付与。過去取得・繰越分は別途確認' : null,
      created_by: actorUserId || null,
    })
  }

  if (dueLots.length > 0) {
    for (const lot of dueLots) {
      const { error } = await adminClient.from('gw_paid_leave_grant_lots').insert(lot)
      if (error && error.code !== '23505') throw error
    }
  }

  const next = nextGrantSequence(employee.hire_date as ISODate, projectionDate)
  const projectedDays = statutoryGrantDays(next.sequenceIndex, schedule)
  const { error: updateError } = await adminClient
    .from('gw_paid_leave_profiles')
    .update({
      user_id: employee.user_id,
      last_grant_date: dueLots.at(-1)?.grant_date || undefined,
      next_grant_date: next.grantDate,
      projected_grant_days: projectedDays,
      projection_calculated_at: new Date().toISOString(),
      updated_by: actorUserId || null,
      updated_at: new Date().toISOString(),
    })
    .eq('employee_id', employee.id)
  if (updateError) throw updateError
}

async function loadThreeMonthAverage(employee: EmployeeRow, asOf: ISODate) {
  const referenceStart = addMonths(asOf, -3)
  const isSalariedEmployee = ['regular_5d_8h', 'regular_6d_6_5h', 'officer'].includes(employee.work_style || '')
  // Pre-launch salaried imports contain overtime fragments without the regular workday.
  // Counting those fragments as full workdays materially understates the daily average.
  const actualReferenceStart = isSalariedEmployee && referenceStart < LIVE_ATTENDANCE_START_DATE
    ? LIVE_ATTENDANCE_START_DATE
    : referenceStart
  const [{ data: snapshots, error: snapshotError }, assignments, punches, { data: dailyRecords, error: dailyError }, { data: rates, error: ratesError }, { data: profiles, error: profileError }] = await Promise.all([
    adminClient
      .from('gw_paid_leave_average_snapshots')
      .select('reference_start, reference_end, source_type, worked_days, worked_minutes, wage_total, average_minutes_per_worked_day, average_wage_per_worked_day, hourly_rate_snapshot, is_reference_only')
      .eq('employee_id', employee.id)
      .order('reference_end', { ascending: false })
      .limit(3),
    loadConfirmedAssignments(employee, actualReferenceStart, asOf),
    loadPunchDates(employee, actualReferenceStart, asOf),
    adminClient
      .from('gw_attendance_daily_records')
      .select('work_date, net_work_minutes, status')
      .eq('employee_id', employee.id)
      .gte('work_date', actualReferenceStart)
      .lte('work_date', asOf)
      .neq('status', 'voided')
      .gt('net_work_minutes', 0),
    adminClient
      .from('gw_pay_rates')
      .select('amount, effective_from, effective_to')
      .eq('employee_id', employee.id)
      .eq('rate_type', 'hourly')
      .lte('effective_from', asOf)
      .or(`effective_to.is.null,effective_to.gte.${asOf}`)
      .order('effective_from', { ascending: false })
      .limit(1),
    adminClient
      .from('gw_payroll_calculation_profiles')
      .select('calculation_type, hourly_rate, effective_from, effective_to')
      .eq('employee_id', employee.id)
      .lte('effective_from', asOf)
      .or(`effective_to.is.null,effective_to.gte.${asOf}`)
      .order('effective_from', { ascending: false })
      .limit(1),
  ])
  if (snapshotError || dailyError || ratesError || profileError) throw snapshotError || dailyError || ratesError || profileError

  const hourlyRate = toNumber(rates?.[0]?.amount || profiles?.[0]?.hourly_rate)
  const latestSnapshot = snapshots?.[0] || null
  const calculationType = (profiles?.[0]?.calculation_type || 'unknown') as PayrollCalculationType
  const attendancePolicy = await loadAttendanceCalculationPolicy(asOf)
  const attendanceSummary = summarizeAttendance(
    punches,
    { calculation_type: 'hourly' },
    attendancePolicy,
  )
  let workedMinutes = 0
  let workedDays = 0
  const actualDates: string[] = []
  const recordedMinutesByDate = new Map<string, number>()
  for (const record of dailyRecords || []) {
    const minutes = Number(record.net_work_minutes || 0)
    if (minutes <= 0) continue
    recordedMinutesByDate.set(
      record.work_date,
      Math.max(recordedMinutesByDate.get(record.work_date) || 0, minutes),
    )
  }
  const punchMinutesByDate = new Map(
    attendanceSummary.daily
      .filter((row) => row.netWorkMinutes > 0)
      .map((row) => [row.workDate, row.netWorkMinutes] as const),
  )
  const observedDates = [...new Set([
    ...recordedMinutesByDate.keys(),
    ...punchMinutesByDate.keys(),
  ])].sort()
  for (const workDate of observedDates) {
    // Monthly attendance corrections update punches, so complete punches take
    // precedence over an older imported daily snapshot for the same date.
    const minutes = punchMinutesByDate.get(workDate) ?? recordedMinutesByDate.get(workDate) ?? 0
    if (minutes <= 0) continue
    workedMinutes += minutes
    workedDays += 1
    actualDates.push(workDate)
  }
  if (workedDays === 0) {
    for (const assignment of assignments) {
      if (!assignment.shift_label || PAID_LEAVE_SHIFT_LABELS.has(assignment.shift_label)) continue
      workedMinutes += assignment.work_minutes ?? minutesBetween(assignment.start_time, assignment.end_time, assignment.break_minutes) ?? 0
      workedDays += 1
      actualDates.push(assignment.work_date)
    }
  }

  actualDates.sort()
  const useInitialSnapshot = workedDays === 0 && Boolean(latestSnapshot?.average_minutes_per_worked_day)
  const displayWorkedDays = useInitialSnapshot ? toNumber(latestSnapshot?.worked_days) : workedDays
  const displayWorkedMinutes = useInitialSnapshot ? toNumber(latestSnapshot?.worked_minutes) : workedMinutes
  const averageMinutes = useInitialSnapshot
    ? latestSnapshot?.average_minutes_per_worked_day ?? null
    : workedDays > 0
    ? Math.round(workedMinutes / workedDays)
    : latestSnapshot?.average_minutes_per_worked_day ?? null
  const includedInMonthlySalary = (
    ['regular_5d_8h', 'regular_6d_6_5h', 'officer'].includes(employee.work_style || '')
    || ['monthly_fixed', 'monthly_with_overtime', 'officer_fixed'].includes(calculationType)
  )
  const averageWage = !includedInMonthlySalary && averageMinutes !== null && hourlyRate > 0
    ? Math.round((averageMinutes / 60) * hourlyRate)
    : !includedInMonthlySalary
      ? latestSnapshot?.average_wage_per_worked_day ?? null
      : null

  return {
    referenceStart: useInitialSnapshot
      ? (latestSnapshot?.reference_start as ISODate || actualReferenceStart)
      : actualReferenceStart,
    referenceEnd: asOf,
    workedDays: displayWorkedDays,
    workedMinutes: displayWorkedMinutes,
    averageMinutesPerDay: averageMinutes,
    hourlyRate: includedInMonthlySalary
      ? null
      : hourlyRate || toNumber(latestSnapshot?.hourly_rate_snapshot) || null,
    averageWagePerDay: averageWage,
    source: useInitialSnapshot
      ? latestSnapshot?.source_type || 'shift_workbook'
      : workedDays > 0
        ? (dailyRecords?.length ? 'attendance_daily_records' : attendanceSummary.workDays > 0 ? 'attendance_punches' : 'confirmed_shifts')
        : latestSnapshot?.source_type || 'none',
    isReferenceOnly: true,
    isNetWorkTime: true,
    includedInMonthlySalary,
  }
}

export async function loadPaidLeaveDashboard(userId: string, actorUserId?: string | null) {
  const employee = await loadEmployee(userId)
  if (!employee) throw new Error('人事情報に連携されたスタッフが見つかりません')
  const managed = isPaidLeaveManagedEmployee(employee)
  if (managed) {
    await syncPaidLeaveAccount(employee, actorUserId)
  } else {
    await voidExcludedPaidLeaveData(employee)
  }

  const today = jstDate()
  const pendingStart = addDays(today, -90)
  const [
    grantsResult,
    requestsResult,
    resolutionsResult,
    assignments,
    punches,
    average,
    profileResult,
    balanceLotsResult,
  ] = await Promise.all([
    adminClient
      .from('gw_paid_leave_grant_lots')
      .select('id, employee_id, user_id, grant_date, expires_on, granted_days, grant_source, grant_status, initial_assumption, attendance_rate, notes')
      .eq('employee_id', employee.id)
      .order('grant_date', { ascending: false }),
    adminClient
      .from('gw_paid_leave_requests')
      .select('id, employee_id, user_id, leave_date, leave_unit, requested_days, request_source, request_status, scheduled_minutes_snapshot, hourly_rate_snapshot, payable_minutes_snapshot, paid_wage_amount, employee_memo, manager_memo, requested_at, raw_payload')
      .eq('employee_id', employee.id)
      .order('leave_date', { ascending: false }),
    adminClient
      .from('gw_workday_resolutions')
      .select('id, employee_id, user_id, work_date, shift_period_id, shift_assignment_id, scheduled_minutes_snapshot, resolution_type, resolution_status, paid_leave_request_id, employee_memo, manager_memo, employee_answered_at, confirmed_at')
      .eq('employee_id', employee.id)
      .order('work_date', { ascending: false }),
    loadConfirmedAssignments(employee, pendingStart, addDays(today, -1)),
    loadPunchDates(employee, pendingStart, addDays(today, -1)),
    loadThreeMonthAverage(employee, addDays(today, -1) as ISODate),
    adminClient
      .from('gw_paid_leave_profiles')
      .select('next_grant_date, projected_grant_days, attendance_threshold, grant_when_equal_to_threshold, wage_method, half_day_enabled, notes')
      .eq('employee_id', employee.id)
      .maybeSingle(),
    adminClient
      .from('gw_paid_leave_grant_balances')
      .select('grant_lot_id, grant_date, expires_on, granted_days, allocated_days, remaining_days')
      .eq('employee_id', employee.id)
      .order('expires_on', { ascending: true }),
  ])
  const dbError = grantsResult.error || requestsResult.error || resolutionsResult.error || profileResult.error || balanceLotsResult.error
  if (dbError) throw dbError

  const grants = (grantsResult.data || []) as GrantRow[]
  const requests = (requestsResult.data || []) as RequestRow[]
  const resolutions = (resolutionsResult.data || []) as ResolutionRow[]
  const balanceLots = (balanceLotsResult.data || []).map((lot) => {
    const expired = lot.expires_on <= today
    return {
      id: lot.grant_lot_id,
      grantDate: lot.grant_date,
      expiresOn: lot.expires_on,
      grantedDays: toNumber(lot.granted_days),
      allocatedDays: toNumber(lot.allocated_days),
      remainingDays: toNumber(lot.remaining_days),
      expired,
    }
  })
  const balance = {
    asOf: today,
    availableDays: balanceLots
      .filter((lot) => !lot.expired && lot.grantDate <= today)
      .reduce((sum, lot) => sum + lot.remainingDays, 0),
    expiredUnusedDays: balanceLots
      .filter((lot) => lot.expired)
      .reduce((sum, lot) => sum + lot.remainingDays, 0),
    allocatedDays: balanceLots.reduce((sum, lot) => sum + lot.allocatedDays, 0),
    allocations: [],
    shortfalls: [],
    lots: balanceLots,
  }

  const punchDates = validPunchDateSet(punches)
  const resolutionDates = new Set(resolutions.filter((row) => row.resolution_status !== 'voided').map((row) => row.work_date))
  const fullPaidLeaveDates = new Set(
    requests
      .filter((row) => (
        ACTIVE_REQUEST_STATUSES.has(row.request_status)
        && row.leave_unit === 'full_day'
        && !isOpeningBalanceAdjustment(row)
      ))
      .map((row) => row.leave_date),
  )
  const unresolved = assignments
    .filter((assignment) => Boolean(assignment.shift_label))
    .filter((assignment) => !PAID_LEAVE_SHIFT_LABELS.has(assignment.shift_label || ''))
    .filter((assignment) => !punchDates.has(assignment.work_date))
    .filter((assignment) => !resolutionDates.has(assignment.work_date))
    .filter((assignment) => !fullPaidLeaveDates.has(assignment.work_date))
    .map((assignment) => ({
      assignmentId: assignment.id,
      periodId: assignment.period_id,
      workDate: assignment.work_date,
      shiftLabel: assignment.shift_label,
      startTime: assignment.start_time,
      endTime: assignment.end_time,
      scheduledMinutes: assignment.work_minutes ?? minutesBetween(assignment.start_time, assignment.end_time, assignment.break_minutes),
    }))

  const confirmedAbsences = resolutions.filter((row) => row.resolution_type === 'absence' && row.resolution_status === 'admin_confirmed')
  const currentMonth = today.slice(0, 7)
  const currentYear = today.slice(0, 4)
  const attendanceMeasuring = today < PAID_LEAVE_ATTENDANCE_DISPLAY_DATE
  const attendanceEnd = attendanceMeasuring
    ? PAID_LEAVE_ATTENDANCE_MEASUREMENT_END_DATE
    : addDays(today, -1)
  const attendanceStart = attendanceMeasuring
    ? PAID_LEAVE_SYSTEM_START_DATE
    : addMonths(today, -3)
  const rollingAttendance = attendanceMeasuring
    ? { numeratorDays: 0, denominatorDays: 0 }
    : await attendanceForPeriod(employee, attendanceStart, attendanceEnd)
  const attendance = calculateAttendanceEligibility({
    ...rollingAttendance,
    threshold: toNumber(profileResult.data?.attendance_threshold) || 0.8,
    thresholdInclusive: Boolean(profileResult.data?.grant_when_equal_to_threshold),
  })

  return {
    managed,
    today,
    employee: {
      id: employee.id,
      userId: employee.user_id,
      employeeCode: employee.employee_code,
      name: displayName(employee),
      hireDate: employee.hire_date,
      department: employee.department,
      workStyle: employee.work_style,
    },
    profile: profileResult.data,
    balance,
    grants,
    requests,
    resolutions,
    unresolved,
    absences: {
      month: confirmedAbsences.filter((row) => row.work_date.startsWith(currentMonth)).length,
      year: confirmedAbsences.filter((row) => row.work_date.startsWith(currentYear)).length,
      tenure: confirmedAbsences.length,
    },
    attendance: {
      ...attendance,
      referenceStart: attendanceStart,
      referenceEnd: attendanceEnd,
      isMeasuring: attendanceMeasuring,
      measurementReadyDate: PAID_LEAVE_ATTENDANCE_DISPLAY_DATE,
    },
    average,
  }
}

export async function paidLeaveWageSnapshot(
  employeeId: string,
  scheduledMinutes: number,
  requestedDays: 0.5 | 1,
  effectiveDate: ISODate = jstDate(),
) {
  const [
    { data: employee, error: employeeError },
    { data: rates, error: ratesError },
    { data: profiles, error: profileError },
  ] = await Promise.all([
    adminClient
      .from('gw_payroll_employees')
      .select('id, user_id, employee_code, display_name, real_name, hire_date, department, work_style, payroll_status')
      .eq('id', employeeId)
      .maybeSingle(),
    adminClient
      .from('gw_pay_rates')
      .select('amount, effective_to')
      .eq('employee_id', employeeId)
      .eq('rate_type', 'hourly')
      .lte('effective_from', effectiveDate)
      .or(`effective_to.is.null,effective_to.gte.${effectiveDate}`)
      .order('effective_from', { ascending: false })
      .limit(1),
    adminClient
      .from('gw_payroll_calculation_profiles')
      .select('hourly_rate, calculation_type, effective_to')
      .eq('employee_id', employeeId)
      .lte('effective_from', effectiveDate)
      .or(`effective_to.is.null,effective_to.gte.${effectiveDate}`)
      .order('effective_from', { ascending: false })
      .limit(1),
  ])
  if (employeeError || ratesError || profileError) throw employeeError || ratesError || profileError
  if (!employee) throw new Error('有給賃金を計算するスタッフが見つかりません')

  const hourlyRate = toNumber(rates?.[0]?.amount || profiles?.[0]?.hourly_rate)
  const isPartWorker = ['part_time_under_29_5h', 'full_time_part'].includes(employee.work_style || '')
  const average = isPartWorker
    ? await loadThreeMonthAverage(employee as EmployeeRow, addDays(effectiveDate, -1) as ISODate)
    : null
  const basisMinutes = isPartWorker && Number(average?.averageMinutesPerDay || 0) > 0
    ? Number(average?.averageMinutesPerDay)
    : scheduledMinutes
  const calculationType = profiles?.[0]?.calculation_type || 'unknown'
  const isMonthlySalary = ['monthly_fixed', 'monthly_with_overtime', 'officer_fixed'].includes(calculationType)
  const wage = calculateOrdinaryPaidLeaveWage({
    scheduledMinutes: basisMinutes,
    hourlyRate,
    leaveDays: requestedDays,
  })
  return {
    hourlyRate,
    payableMinutes: wage.payableMinutes,
    amount: isMonthlySalary ? 0 : wage.amount,
    basis: isPartWorker && average?.averageMinutesPerDay ? 'three_month_average_hours' : 'confirmed_shift',
    includedInMonthlySalary: isMonthlySalary,
  }
}

function profileWorkMinutes(rawPayload: Record<string, unknown> | null | undefined) {
  const profile = rawPayload?.hr_profile
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null
  const row = profile as { basic_work_start?: string | null; basic_work_end?: string | null; basic_break_minutes?: number | null }
  return minutesBetween(row.basic_work_start || null, row.basic_work_end || null, Number(row.basic_break_minutes || 0))
}

export async function syncShiftPaidLeaveRequests(periodId: string, actorUserId: string) {
  const { data: period, error: periodError } = await adminClient
    .from('gw_shift_periods')
    .select('id, is_test_mode')
    .eq('id', periodId)
    .maybeSingle()
  if (periodError) throw periodError
  if (!period) throw new Error('シフト期間が見つかりません')
  if (period.is_test_mode) return { synced: 0, skippedTestMode: true }

  const { data: shiftRequests, error: requestsError } = await adminClient
    .from('gw_shift_requests')
    .select('id, user_id, employee_id, work_date, request_type, memo')
    .eq('period_id', periodId)
    .in('request_type', ['paid_leave_full', 'paid_leave_half'])
    .order('work_date', { ascending: true })
  if (requestsError) throw requestsError
  if (!shiftRequests?.length) return { synced: 0 }

  const employeesQuery = adminClient
    .from('gw_payroll_employees')
    .select('id, user_id, employee_code, display_name, real_name, hire_date, department, work_style, payroll_status, raw_payload')
    .eq('payroll_status', 'active')
  const [{ data: employees, error: employeesError }, { data: assignments, error: assignmentsError }] = await Promise.all([
    employeesQuery,
    adminClient
      .from('gw_shift_assignments')
      .select('id, period_id, user_id, employee_id, work_date, shift_label, start_time, end_time, break_minutes, work_minutes, note')
      .eq('period_id', periodId),
  ])
  if (employeesError || assignmentsError) throw employeesError || assignmentsError

  const employeeById = new Map((employees || []).map((employee) => [employee.id, employee]))
  const employeeByUser = new Map((employees || []).map((employee) => [employee.user_id, employee]))
  const assignmentByKey = new Map(((assignments || []) as AssignmentRow[]).map((assignment) => [`${assignment.user_id}:${assignment.work_date}`, assignment]))
  const batchRows: Record<string, unknown>[] = []

  for (const shiftRequest of shiftRequests) {
    const employee = employeeById.get(shiftRequest.employee_id) || employeeByUser.get(shiftRequest.user_id)
    if (!employee?.user_id) throw new Error(`${shiftRequest.work_date} の有給希望に人事連携スタッフが見つかりません`)
    await syncPaidLeaveAccount(employee as EmployeeRow, actorUserId)

    const assignment = assignmentByKey.get(`${employee.user_id}:${shiftRequest.work_date}`) || null
    const average = await loadThreeMonthAverage(employee as EmployeeRow, shiftRequest.work_date as ISODate)
    const scheduledMinutes = assignment?.work_minutes
      ?? minutesBetween(assignment?.start_time || null, assignment?.end_time || null, assignment?.break_minutes || 0)
      ?? profileWorkMinutes(employee.raw_payload as Record<string, unknown> | null)
      ?? average.averageMinutesPerDay
      ?? 0
    if (scheduledMinutes <= 0) {
      throw new Error(`${displayName(employee as EmployeeRow)} ${shiftRequest.work_date}: 有給賃金の基準となる所定時間を人事管理で設定してください`)
    }

    const sourceKey = `shift:${periodId}:${employee.user_id}:${shiftRequest.work_date}`
    const requestedDays = shiftRequest.request_type === 'paid_leave_full' ? 1 : 0.5
    const wage = await paidLeaveWageSnapshot(
      employee.id,
      scheduledMinutes,
      requestedDays,
      shiftRequest.work_date as ISODate,
    )
    const rawProfile = ((employee.raw_payload as Record<string, unknown> | null)?.hr_profile || {}) as {
      basic_work_start?: string | null
      basic_work_end?: string | null
      basic_break_minutes?: number | null
    }
    batchRows.push({
      shift_request_id: shiftRequest.id,
      employee_id: employee.id,
      user_id: employee.user_id,
      work_date: shiftRequest.work_date,
      leave_unit: shiftRequest.request_type === 'paid_leave_full' ? 'full_day' : 'half_day',
      shift_assignment_id: assignment?.id || '',
      start_time: assignment?.start_time || rawProfile.basic_work_start || '',
      end_time: assignment?.end_time || rawProfile.basic_work_end || '',
      break_minutes: assignment?.break_minutes ?? Number(rawProfile.basic_break_minutes || 0),
      scheduled_minutes_snapshot: scheduledMinutes,
      hourly_rate_snapshot: wage.hourlyRate || '',
      payable_minutes_snapshot: wage.payableMinutes,
      paid_wage_amount: wage.amount,
      raw_payload: {
        wage_basis: wage.basis,
        included_in_monthly_salary: wage.includedInMonthlySalary,
      },
      employee_memo: shiftRequest.memo || null,
      source_key: sourceKey,
    })
  }

  const { data: syncResult, error: syncError } = await adminClient.rpc('gw_sync_shift_paid_leave_batch', {
    p_period_id: periodId,
    p_rows: batchRows,
    p_actor_user_id: actorUserId,
  })
  if (syncError) throw syncError
  const result = syncResult && typeof syncResult === 'object'
    ? syncResult as { synced?: number; skipped_test_mode?: boolean }
    : {}
  return {
    synced: Number(result.synced || 0),
    skippedTestMode: Boolean(result.skipped_test_mode),
  }
}
