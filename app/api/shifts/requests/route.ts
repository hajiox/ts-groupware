import { NextRequest, NextResponse } from 'next/server'
import { USER_DEPARTMENTS, normalizeUserDepartment, type UserDepartment } from '@/lib/departments'
import { getUserSession } from '@/lib/session'
import { resolveShiftConstraints } from '@/lib/shift-constraints'
import { isShiftRequestDeadlineOpen } from '@/lib/shift-deadline'
import { isShiftRequestCollectionExcluded } from '@/lib/shift-request-exclusions'
import { adminClient } from '@/lib/supabase/admin'

type ShiftRequestType = 'day_off' | 'unavailable' | 'paid_leave_full' | 'paid_leave_half' | 'available' | 'time_preference' | 'note'
type ShiftPriority = 'must' | 'prefer' | 'ok'

const REQUEST_TYPES = new Set<ShiftRequestType>(['day_off', 'unavailable', 'paid_leave_full', 'paid_leave_half', 'available', 'time_preference', 'note'])
const PRIORITIES = new Set<ShiftPriority>(['must', 'prefer', 'ok'])
const STAFF_EDITABLE_STATUSES = new Set(['collecting', 'generated', 'editing'])

function cleanText(value: unknown, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function cleanDate(value: unknown) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
}

function cleanTime(value: unknown) {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d{2}):(\d{2})(?::\d{2})?$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return `${match[1]}:${match[2]}`
}

function cleanInteger(value: unknown) {
  if (value === '' || value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : null
}

function periodDayCount(startDate: string, endDate: string) {
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const end = Date.parse(`${endDate}T00:00:00Z`)
  return Math.max(1, Math.floor((end - start) / 86400000) + 1)
}

function getJstDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  return `${year}-${month}-${day}`
}

function tsgDepartmentFromText(value: unknown): UserDepartment | null {
  if (typeof value !== 'string' || !value.trim()) return null
  if (USER_DEPARTMENTS.includes(value as UserDepartment)) return value as UserDepartment
  if (value.includes('道の駅')) return '道の駅'
  if (value.includes('フロア') || value.includes('売上') || value.includes('ブランド館')) return 'フロア'
  if (value.includes('製造') || value.includes('本社')) return '製造'
  return null
}

function hrProfile(rawPayload: Record<string, unknown> | null | undefined) {
  const value = rawPayload?.hr_profile
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as { deleted_at?: string }
    : {}
}

async function getEmployeeForUser(userId: string) {
  const { data, error } = await adminClient
    .from('gw_payroll_employees')
    .select('id, user_id, employee_code, display_name, real_name, department, work_style, payroll_status, raw_payload')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  if (!data || hrProfile(data.raw_payload as Record<string, unknown> | null).deleted_at) return null
  return data as {
    id: string
    user_id: string
    employee_code: string | null
    display_name: string
    real_name: string | null
    department: string | null
    work_style: string | null
    payroll_status: string
    raw_payload: Record<string, unknown> | null
  }
}

async function loadPayload(user: Awaited<ReturnType<typeof getUserSession>>) {
  if (!user) throw new Error('認証が必要です')
  const requestCollectionExcluded = isShiftRequestCollectionExcluded(user)
  const employee = await getEmployeeForUser(user.id)
  const department =
    tsgDepartmentFromText(user.department) ||
    tsgDepartmentFromText(employee?.department) ||
    normalizeUserDepartment(user.department)
  const today = getJstDate()

  const { data: rawPeriods, error: periodsError } = await adminClient
    .from('gw_shift_periods')
    .select('id, department, title, start_date, end_date, request_deadline, status, notes, is_test_mode')
    .in('status', ['collecting', 'generated', 'editing', 'confirmed'])
    .gte('end_date', today)
    .order('start_date', { ascending: true })
    .limit(24)

  if (periodsError) throw periodsError

  const rawPeriodIds = (rawPeriods || []).map((period) => period.id)
  const [targetsResult, exclusionsResult] = rawPeriodIds.length
    ? await Promise.all([
      adminClient
        .from('gw_shift_request_targets')
        .select('id, period_id, user_id, employee_id, requested_at')
        .in('period_id', rawPeriodIds),
      adminClient
        .from('gw_shift_period_exclusions')
        .select('period_id, user_id')
        .eq('user_id', user.id)
        .in('period_id', rawPeriodIds),
    ])
    : [{ data: [], error: null }, { data: [], error: null }]

  if (targetsResult.error || exclusionsResult.error) throw targetsResult.error || exclusionsResult.error

  const targetRows = targetsResult.data || []
  const excludedPeriodIds = new Set((exclusionsResult.data || []).map((row) => row.period_id))
  const periodTargetCounts = new Map<string, number>()
  const userTargetPeriodIds = new Set<string>()
  for (const target of targetRows as Array<{ period_id: string; user_id: string }>) {
    periodTargetCounts.set(target.period_id, (periodTargetCounts.get(target.period_id) || 0) + 1)
    if (target.user_id === user.id) userTargetPeriodIds.add(target.period_id)
  }
  const periods = (rawPeriods || []).filter((period) => {
    if (period.is_test_mode) return false
    if (period.department !== department) return false
    if (excludedPeriodIds.has(period.id)) return false
    if (requestCollectionExcluded && period.status !== 'confirmed') return false
    const targetCount = periodTargetCounts.get(period.id) || 0
    return targetCount === 0 || userTargetPeriodIds.has(period.id)
  })

  const periodIds = periods.map((period) => period.id)
  const [requestsResult, submissionsResult, assignmentsResult, requirementsResult] = await Promise.all([
    periodIds.length
      ? adminClient
        .from('gw_shift_requests')
        .select('id, period_id, user_id, employee_id, work_date, request_type, priority, start_time, end_time, memo, status, is_test')
        .eq('user_id', user.id)
        .in('period_id', periodIds)
        .order('work_date', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    periodIds.length
      ? adminClient
        .from('gw_shift_request_submissions')
        .select('id, period_id, user_id, employee_id, submitted_at, request_comment, max_work_days, target_work_days, min_days_off, max_consecutive_days, is_test')
        .eq('user_id', user.id)
        .in('period_id', periodIds)
        .order('submitted_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    periodIds.length
      ? adminClient
        .from('gw_shift_assignments')
        .select('id, period_id, user_id, employee_id, work_date, shift_label, start_time, end_time, note, source')
        .eq('user_id', user.id)
        .in('period_id', periodIds)
        .order('work_date', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    periodIds.length
      ? adminClient
        .from('gw_shift_requirements')
        .select('id, period_id, work_date, workplace_label, notes, notes2, notes3, production_plan, ec_sale_tags')
        .in('period_id', periodIds)
        .order('work_date', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ])

  const dbError = requestsResult.error || submissionsResult.error || assignmentsResult.error || requirementsResult.error
  if (dbError) throw dbError

  return {
    user,
    employee,
    department,
    periods: periods || [],
    targets: targetRows.filter((target) => periodIds.includes(target.period_id) && target.user_id === user.id),
    requests: requestsResult.data || [],
    submissions: submissionsResult.data || [],
    assignments: assignmentsResult.data || [],
    requirements: requirementsResult.data || [],
    requestCollectionExcluded,
  }
}

export async function GET() {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

  try {
    const payload = await loadPayload(user)
    return NextResponse.json(payload)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'シフト希望の取得に失敗しました' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const periodId = cleanText(body.period_id, 80)
  const rows = Array.isArray(body.requests) ? body.requests : []
  const requestComment = cleanText(body.request_comment, 1000)
  const maxWorkDays = cleanInteger(body.max_work_days)
  const targetWorkDays = cleanInteger(body.target_work_days)
  const minDaysOff = cleanInteger(body.min_days_off)
  const maxConsecutiveDays = cleanInteger(body.max_consecutive_days)
  if (!periodId) return NextResponse.json({ error: 'シフト期間が必要です' }, { status: 400 })
  if (rows.length > 90) return NextResponse.json({ error: '一度に送信できる希望は90日分までです' }, { status: 400 })

  try {
    const employee = await getEmployeeForUser(user.id)
    const { data: period, error: periodError } = await adminClient
      .from('gw_shift_periods')
      .select('id, department, start_date, end_date, request_deadline, status, is_test_mode')
      .eq('id', periodId)
      .single()

    if (periodError || !period) {
      return NextResponse.json({ error: periodError?.message || 'シフト期間が見つかりません' }, { status: 404 })
    }
    if (!STAFF_EDITABLE_STATUSES.has(period.status)) {
      return NextResponse.json({ error: 'このシフト期間は希望修正できません' }, { status: 400 })
    }
    const deadlineOpen = isShiftRequestDeadlineOpen(period.request_deadline)
    const { data: periodTargets, error: targetError } = await adminClient
      .from('gw_shift_request_targets')
      .select('user_id')
      .eq('period_id', periodId)
    if (targetError) throw targetError
    const isTarget = (periodTargets || []).some((target) => target.user_id === user.id)

    if (period.is_test_mode) {
      return NextResponse.json({ error: '希望回収テストは管理画面内だけで使用できます' }, { status: 403 })
    } else {
      if (isShiftRequestCollectionExcluded(user)) {
        return NextResponse.json({ error: 'シフト希望回収の対象外です' }, { status: 403 })
      }
      const { data: exclusion, error: exclusionError } = await adminClient
        .from('gw_shift_period_exclusions')
        .select('id')
        .eq('period_id', periodId)
        .eq('user_id', user.id)
        .maybeSingle()
      if (exclusionError) throw exclusionError
      if (exclusion) {
        return NextResponse.json({ error: 'このシフト期間の対象外です' }, { status: 403 })
      }
      if ((periodTargets || []).length > 0 && !isTarget) {
        return NextResponse.json({ error: 'このシフトの希望回収対象ではありません' }, { status: 403 })
      }
    }

    const [{ data: existingRequests, error: existingRequestsError }, { data: existingSubmission, error: existingSubmissionError }] = deadlineOpen
      ? [{ data: [], error: null }, { data: null, error: null }]
      : await Promise.all([
        adminClient
          .from('gw_shift_requests')
          .select('work_date, request_type')
          .eq('period_id', periodId)
          .eq('user_id', user.id)
          .eq('is_test', Boolean(period.is_test_mode)),
        adminClient
          .from('gw_shift_request_submissions')
          .select('request_comment, max_work_days, target_work_days, min_days_off, max_consecutive_days, submitted_at')
          .eq('period_id', periodId)
          .eq('user_id', user.id)
          .maybeSingle(),
      ])
    if (existingRequestsError || existingSubmissionError) throw existingRequestsError || existingSubmissionError
    const existingRequestByDate = new Map((existingRequests || []).map((row) => [row.work_date, row.request_type]))

    const days = periodDayCount(period.start_date, period.end_date)
    const submittedNumbers = [maxWorkDays, targetWorkDays, minDaysOff]
    if (deadlineOpen && submittedNumbers.some((value) => value !== null && (value < 0 || value > days))) {
      return NextResponse.json({ error: `日数は0〜${days}日の範囲で入力してください` }, { status: 400 })
    }
    if (deadlineOpen && maxConsecutiveDays !== null && (maxConsecutiveDays < 1 || maxConsecutiveDays > days)) {
      return NextResponse.json({ error: `最大連続勤務日数は1〜${days}日の範囲で入力してください` }, { status: 400 })
    }
    const constraints = resolveShiftConstraints(employee?.work_style, days, {
      maxWorkDays,
      targetWorkDays,
      minDaysOff,
      maxConsecutiveDays,
    })
    if (deadlineOpen && targetWorkDays !== null && targetWorkDays > constraints.effectiveMaxWorkDays) {
      return NextResponse.json({
        error: `希望出勤日数は、有効な出勤上限${constraints.effectiveMaxWorkDays}日以内にしてください`,
      }, { status: 400 })
    }

    const upserts: Record<string, unknown>[] = []
    const deleteDates: string[] = []
    const blockedDates: string[] = []

    for (const row of rows as Record<string, unknown>[]) {
      const workDate = cleanDate(row.work_date)
      if (!workDate || workDate < period.start_date || workDate > period.end_date) continue
      const requestType = cleanText(row.request_type, 40) as ShiftRequestType
      if (!deadlineOpen) {
        const existingType = existingRequestByDate.get(workDate)
        const incomingPaidLeave = requestType === 'paid_leave_full' || requestType === 'paid_leave_half'
        const removingPaidLeave = !requestType && (existingType === 'paid_leave_full' || existingType === 'paid_leave_half')
        if (!incomingPaidLeave && !removingPaidLeave) continue
      }
      if (!requestType) {
        deleteDates.push(workDate)
        continue
      }
      if (!REQUEST_TYPES.has(requestType)) continue
      if (requestType === 'day_off' || requestType === 'unavailable' || requestType === 'paid_leave_full') blockedDates.push(workDate)
      const priority = cleanText(row.priority, 20) as ShiftPriority
      upserts.push({
        period_id: periodId,
        user_id: user.id,
        employee_id: employee?.id || null,
        work_date: workDate,
        request_type: requestType,
        priority: PRIORITIES.has(priority) ? priority : 'must',
        start_time: cleanTime(row.start_time),
        end_time: cleanTime(row.end_time),
        memo: cleanText(row.memo, 300) || null,
        status: 'submitted',
        is_test: Boolean(period.is_test_mode),
        updated_at: new Date().toISOString(),
      })
    }

    if (deleteDates.length > 0) {
      const { error } = await adminClient
        .from('gw_shift_requests')
        .delete()
        .eq('period_id', periodId)
        .eq('user_id', user.id)
        .eq('is_test', Boolean(period.is_test_mode))
        .in('work_date', deleteDates)
      if (error) throw error
    }

    if (upserts.length > 0) {
      const { error } = await adminClient
        .from('gw_shift_requests')
        .upsert(upserts, { onConflict: 'period_id,user_id,work_date' })
      if (error) throw error
    }

    if (blockedDates.length > 0 && !period.is_test_mode) {
      const { error } = await adminClient
        .from('gw_shift_assignments')
        .delete()
        .eq('period_id', periodId)
        .eq('user_id', user.id)
        .in('work_date', blockedDates)
      if (error) throw error
    }

    const submissionValues = deadlineOpen ? {
      request_comment: requestComment || null,
      max_work_days: maxWorkDays,
      target_work_days: targetWorkDays,
      min_days_off: minDaysOff,
      max_consecutive_days: maxConsecutiveDays,
    } : {
      request_comment: existingSubmission?.request_comment || null,
      max_work_days: existingSubmission?.max_work_days ?? null,
      target_work_days: existingSubmission?.target_work_days ?? null,
      min_days_off: existingSubmission?.min_days_off ?? null,
      max_consecutive_days: existingSubmission?.max_consecutive_days ?? null,
    }
    const { error: submissionError } = await adminClient
      .from('gw_shift_request_submissions')
      .upsert({
        period_id: periodId,
        user_id: user.id,
        employee_id: employee?.id || null,
        ...submissionValues,
        is_test: Boolean(period.is_test_mode),
        submitted_at: existingSubmission?.submitted_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'period_id,user_id' })
    if (submissionError) throw submissionError

    const payload = await loadPayload(user)
    return NextResponse.json({ success: true, ...payload })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'シフト希望の保存に失敗しました' }, { status: 500 })
  }
}
