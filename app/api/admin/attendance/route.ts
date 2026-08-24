import { NextRequest, NextResponse } from 'next/server'
import { getManagementPermissions } from '@/lib/management-permissions'
import { loadPaidLeaveAttendanceDays } from '@/lib/paid-leave-attendance-data'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'
import {
  isAttendanceUserEligibleForRange,
  loadAttendanceWorkforceForRange,
} from '@/lib/workforce-employment'

type PunchType = 'clock_in' | 'clock_out'

type UserRow = {
  id: string
  display_name: string
  real_name?: string | null
  picture_url?: string | null
  department?: string | null
}

type PunchRow = {
  id: string
  user_id: string | null
  employee_id?: string | null
  device_id: string | null
  punch_type: PunchType
  work_date: string
  punched_at: string
  source_type: string | null
  is_voided: boolean
  memo: string | null
  private_vehicle_place?: string | null
  private_vehicle_distance_km?: number | string | null
  break_override_minutes?: number | null
  break_override_reason?: string | null
}

type MonthlyCheckRow = {
  id: string
  check_month: string
  user_id: string
  checked_by: string | null
  checked_at: string
  note: string | null
}

type DailyNoteRow = {
  id: string
  user_id: string
  work_date: string
  memo: string
  updated_at: string
}

const THIRTY_MINUTE_BREAK_NOTE = '30分休憩'

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

function displayName(user?: UserRow | null) {
  return user?.real_name || user?.display_name || '不明'
}

function cleanDate(value: string | null) {
  if (!value) return getJstDate()
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : getJstDate()
}

function cleanMonthStart(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (/^\d{4}-\d{2}$/.test(text)) return `${text}-01`
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text.slice(0, 7)}-01`
  return `${getJstDate().slice(0, 7)}-01`
}

function addDays(dateText: string, days: number) {
  const [year, month, day] = dateText.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return date.toISOString().slice(0, 10)
}

function monthEndFromStart(monthStart: string) {
  const [year, month] = monthStart.split('-').map(Number)
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

function cleanDateRange(request: NextRequest) {
  const dateParam = request.nextUrl.searchParams.get('date')
  const defaultDate = cleanDate(dateParam)
  let dateFrom = cleanDate(request.nextUrl.searchParams.get('date_from') || dateParam)
  let dateTo = cleanDate(request.nextUrl.searchParams.get('date_to') || dateParam || dateFrom)

  if (dateFrom > dateTo) {
    const next = dateFrom
    dateFrom = dateTo
    dateTo = next
  }

  const maxDateTo = addDays(dateFrom, 30)
  if (dateTo > maxDateTo) {
    dateTo = maxDateTo
  }

  return { workDate: defaultDate, dateFrom, dateTo }
}

function normalizePunchType(value: unknown): PunchType | null {
  if (value === 'clock_in' || value === 'clock_out') return value
  return null
}

function cleanMemo(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 500) : ''
}

function stripBreakMemoPrefix(value: unknown, breakOverrideMinutes: number | null | undefined) {
  const memo = cleanMemo(value)
  if (breakOverrideMinutes !== 30) return memo
  if (memo === THIRTY_MINUTE_BREAK_NOTE) return ''
  if (memo.startsWith(`${THIRTY_MINUTE_BREAK_NOTE} / `)) {
    return memo.slice(`${THIRTY_MINUTE_BREAK_NOTE} / `.length).trim().slice(0, 500)
  }
  if (memo.startsWith(`${THIRTY_MINUTE_BREAK_NOTE}\n`)) {
    return memo.slice(`${THIRTY_MINUTE_BREAK_NOTE}\n`.length).trim().slice(0, 500)
  }
  return memo
}

function normalizeDistance(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(',', '.'))
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.round(parsed * 100) / 100
}

function normalizeBreakOverride(value: unknown) {
  if (value === null || value === undefined || value === '' || value === false) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return [0, 30, 45, 60].includes(parsed) ? parsed : null
}

function jstDateTimeToIso(workDate: string, timeText: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate) || !/^\d{2}:\d{2}$/.test(timeText)) return null

  const [year, month, day] = workDate.split('-').map(Number)
  const [hour, minute] = timeText.split(':').map(Number)
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null

  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, 0)).toISOString()
}

async function requireAttendanceAdmin() {
  const user = await getUserSession()
  if (!user) return { error: '認証が必要です', status: 401, user: null }

  const permissions = getManagementPermissions(user)
  if (!permissions.canManageAttendance) {
    return { error: '勤怠管理権限が必要です', status: 403, user: null }
  }

  return { error: null, status: 0, user }
}

async function getEmployeeIdForUser(userId: string) {
  const { data } = await adminClient
    .from('gw_payroll_employees')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle()

  return data?.id || null
}

async function getWorkplaceIdForDevice(deviceId: string | null) {
  if (!deviceId) return null

  const { data } = await adminClient
    .from('gw_attendance_devices')
    .select('workplace_id')
    .eq('id', deviceId)
    .maybeSingle()

  return data?.workplace_id || null
}

async function writeCorrectionLog(payload: {
  punchId: string
  employeeId?: string | null
  correctionType: 'admin_edit' | 'void'
  reason?: string | null
  beforePayload: unknown
  afterPayload: unknown
  actorId: string
}) {
  await adminClient
    .from('gw_attendance_corrections')
    .insert({
      punch_id: payload.punchId,
      employee_id: payload.employeeId || null,
      correction_type: payload.correctionType,
      reason: payload.reason || null,
      before_payload: payload.beforePayload,
      after_payload: payload.afterPayload,
      status: 'approved',
      requested_by: payload.actorId,
      approved_by: payload.actorId,
      approved_at: new Date().toISOString(),
    })
}

function buildPunchOptions(body: Record<string, unknown>, actorId: string) {
  const privateVehicleDistanceKm = normalizeDistance(body.private_vehicle_distance_km)
  const breakOverrideMinutes = normalizeBreakOverride(body.break_override_minutes)
  const breakOverrideReason = breakOverrideMinutes === 30 ? '30分休憩ボタン' : cleanMemo(body.break_override_reason)
  const memo = stripBreakMemoPrefix(body.memo, breakOverrideMinutes)

  return {
    memo: memo || null,
    private_vehicle_place: cleanMemo(body.private_vehicle_place) || null,
    private_vehicle_distance_km: privateVehicleDistanceKm,
    break_override_minutes: breakOverrideMinutes,
    break_override_reason: breakOverrideMinutes ? breakOverrideReason || null : null,
    break_override_requested_by: breakOverrideMinutes ? actorId : null,
    break_override_requested_at: breakOverrideMinutes ? new Date().toISOString() : null,
  }
}

export async function GET(request: NextRequest) {
  const { error, status } = await requireAttendanceAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const { workDate, dateFrom, dateTo } = cleanDateRange(request)
  const includeVoided = request.nextUrl.searchParams.get('include_voided') === '1'
  const filterUserId = request.nextUrl.searchParams.get('user_id')?.trim() || ''
  const filterDeviceId = request.nextUrl.searchParams.get('device_id')?.trim() || ''

  const [
    { data: devices, error: devicesError },
    { data: users, error: usersError },
    punchResult,
    monthlyCheckResult,
    dailyNoteResult,
    bereavementResult,
  ] = await Promise.all([
    adminClient
      .from('gw_attendance_devices')
      .select('id, code, name, location, device_key, is_active, sort_order, workplace_id')
      .order('sort_order', { ascending: true }),
    loadAttendanceWorkforceForRange({ startDate: dateFrom, endDate: dateTo })
      .then((result) => ({ data: result.users, error: result.error })),
    (() => {
      let query = adminClient
      .from('gw_attendance_punches')
      .select('id, user_id, employee_id, workplace_id, device_id, punch_type, work_date, punched_at, source_type, created_by, is_voided, voided_by, voided_at, void_reason, memo, private_vehicle_place, private_vehicle_distance_km, break_override_minutes, break_override_reason, break_override_requested_by, break_override_requested_at, created_at, updated_at')
      .gte('work_date', dateFrom)
      .lte('work_date', dateTo)
      .order('punched_at', { ascending: false })
      .limit(1000)

      if (!includeVoided) query = query.eq('is_voided', false)
      if (filterUserId) query = query.eq('user_id', filterUserId)
      if (filterDeviceId) query = query.eq('device_id', filterDeviceId)
      return query
    })(),
    adminClient
      .from('gw_attendance_monthly_checks')
      .select('id, check_month, user_id, checked_by, checked_at, note')
      .eq('check_month', cleanMonthStart(dateFrom)),
    (() => {
      let query = adminClient
        .from('gw_attendance_daily_notes')
        .select('id, user_id, work_date, memo, updated_at')
        .gte('work_date', dateFrom)
        .lte('work_date', dateTo)
        .order('work_date', { ascending: true })

      if (filterUserId) query = query.eq('user_id', filterUserId)
      return query
    })(),
    (() => {
      let query = adminClient
        .from('gw_workday_resolutions')
        .select('id, user_id, work_date')
        .eq('resolution_type', 'bereavement_leave')
        .eq('resolution_status', 'admin_confirmed')
        .gte('work_date', dateFrom)
        .lte('work_date', dateTo)
        .order('work_date', { ascending: true })

      if (filterUserId) query = query.eq('user_id', filterUserId)
      return query
    })(),
  ])

  const dbError = devicesError
    || usersError
    || punchResult.error
    || monthlyCheckResult.error
    || dailyNoteResult.error
    || bereavementResult.error
  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  const userRows = (users || []) as UserRow[]
  const eligibleUserIds = new Set(userRows.map((user) => user.id))
  const punchRows = ((punchResult.data || []) as PunchRow[])
    .filter((punch) => !punch.user_id || eligibleUserIds.has(punch.user_id))
  const monthlyCheckRows = ((monthlyCheckResult.data || []) as MonthlyCheckRow[])
    .filter((check) => eligibleUserIds.has(check.user_id))
  const dailyNoteRows = ((dailyNoteResult.data || []) as DailyNoteRow[])
    .filter((note) => eligibleUserIds.has(note.user_id))
  const bereavementRows = (bereavementResult.data || [])
    .filter((row) => eligibleUserIds.has(row.user_id))
  let paidLeaveDays: Awaited<ReturnType<typeof loadPaidLeaveAttendanceDays>> = []
  try {
    paidLeaveDays = await loadPaidLeaveAttendanceDays({
      userIds: userRows.map((user) => user.id),
      startDate: dateFrom,
      endDate: dateTo,
      punches: punchRows,
    })
  } catch (paidLeaveError) {
    const message = paidLeaveError instanceof Error ? paidLeaveError.message : '有給の提出用打刻を読み込めませんでした'
    return NextResponse.json({ error: message }, { status: 500 })
  }
  const userMap = Object.fromEntries(userRows.map((user) => [
    user.id,
    { ...user, display_name: displayName(user), department: user.department || '製造' },
  ]))
  const deviceMap = Object.fromEntries((devices || []).map((device) => [device.id, device]))

  return NextResponse.json({
    workDate,
    dateFrom,
    dateTo,
    includeVoided,
    devices: devices || [],
    users: userRows.map((user) => ({
      ...user,
      display_name: displayName(user),
      department: user.department || '製造',
    })),
    punches: punchRows.map((punch) => ({
      ...punch,
      memo: stripBreakMemoPrefix(punch.memo, punch.break_override_minutes) || null,
      user: punch.user_id ? userMap[punch.user_id] || null : null,
      device: punch.device_id ? deviceMap[punch.device_id] || null : null,
    })),
    paidLeaveDays,
    monthlyChecks: monthlyCheckRows,
    dailyNotes: dailyNoteRows,
    bereavementDays: bereavementRows,
    summary: {
      total: punchRows.length,
      active: punchRows.filter((punch) => !punch.is_voided).length,
      voided: punchRows.filter((punch) => punch.is_voided).length,
      limit: 1000,
    },
  })
}

export async function POST(request: NextRequest) {
  const { error, status, user } = await requireAttendanceAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const body = await request.json().catch(() => ({}))
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : ''
  const punchType = normalizePunchType(body.punch_type)
  const workDate = cleanDate(typeof body.work_date === 'string' ? body.work_date : null)
  const timeText = typeof body.time === 'string' ? body.time.trim() : ''
  const punchedAt = jstDateTimeToIso(workDate, timeText)

  if (!userId || !punchType || !punchedAt) {
    return NextResponse.json({ error: 'スタッフ、打刻種別、時刻を確認してください' }, { status: 400 })
  }

  const eligibility = await isAttendanceUserEligibleForRange(userId, workDate, workDate)
  if (eligibility.error) {
    return NextResponse.json({ error: eligibility.error.message }, { status: 500 })
  }
  if (!eligibility.eligible) {
    return NextResponse.json({ error: 'スタッフが見つかりません' }, { status: 404 })
  }

  const deviceId = typeof body.device_id === 'string' && body.device_id.trim() ? body.device_id.trim() : null
  const [employeeId, workplaceId] = await Promise.all([
    getEmployeeIdForUser(userId),
    getWorkplaceIdForDevice(deviceId),
  ])
  const options = buildPunchOptions(body, user!.id)
  const insertPayload = {
    user_id: userId,
    employee_id: employeeId,
    workplace_id: workplaceId,
    device_id: deviceId,
    punch_type: punchType,
    work_date: workDate,
    punched_at: punchedAt,
    source_type: 'admin',
    created_by: user!.id,
    ip_allowed: true,
    ...options,
  }

  const { data, error: dbError } = await adminClient
    .from('gw_attendance_punches')
    .insert(insertPayload)
    .select('id')
    .single()

  if (dbError || !data) {
    return NextResponse.json({ error: dbError?.message || '打刻修正に失敗しました' }, { status: 500 })
  }

  await writeCorrectionLog({
    punchId: data.id,
    employeeId,
    correctionType: 'admin_edit',
    reason: options.memo || '打刻忘れ/打刻間違いの管理者追加',
    beforePayload: {},
    afterPayload: insertPayload,
    actorId: user!.id,
  }).catch(() => {})

  return NextResponse.json({ success: true, id: data.id })
}

export async function PATCH(request: NextRequest) {
  const { error, status, user } = await requireAttendanceAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const body = await request.json().catch(() => ({}))
  if (body.action === 'bulk_void') {
    const ids = Array.isArray(body.ids)
      ? [...new Set(body.ids.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0).map((id: string) => id.trim()))]
      : []
    const reason = cleanMemo(body.reason) || 'テスト打刻の一括削除'

    if (ids.length === 0) {
      return NextResponse.json({ error: '対象の打刻を選択してください' }, { status: 400 })
    }
    if (ids.length > 500) {
      return NextResponse.json({ error: '一括削除は500件以内で実行してください' }, { status: 400 })
    }

    const { data: beforePunches, error: beforeError } = await adminClient
      .from('gw_attendance_punches')
      .select('id, user_id, employee_id, device_id, punch_type, work_date, punched_at, source_type, is_voided, memo, private_vehicle_place, private_vehicle_distance_km, break_override_minutes, break_override_reason')
      .in('id', ids)

    if (beforeError) {
      return NextResponse.json({ error: beforeError.message }, { status: 500 })
    }

    const activePunches = ((beforePunches || []) as PunchRow[]).filter((punch) => !punch.is_voided)
    if (activePunches.length === 0) {
      return NextResponse.json({ success: true, voided: 0 })
    }

    const now = new Date().toISOString()
    const { error: dbError } = await adminClient
      .from('gw_attendance_punches')
      .update({
        is_voided: true,
        voided_by: user!.id,
        voided_at: now,
        void_reason: reason,
        updated_at: now,
      })
      .in('id', activePunches.map((punch) => punch.id))

    if (dbError) {
      return NextResponse.json({ error: dbError.message }, { status: 500 })
    }

    await Promise.allSettled(activePunches.map((punch) => writeCorrectionLog({
      punchId: punch.id,
      employeeId: punch.employee_id || null,
      correctionType: 'void',
      reason,
      beforePayload: punch,
      afterPayload: { is_voided: true, void_reason: reason },
      actorId: user!.id,
    })))

    return NextResponse.json({ success: true, voided: activePunches.length })
  }

  if (body.action === 'monthly_day_delete') {
    const userId = typeof body.user_id === 'string' ? body.user_id.trim() : ''
    const workDate = cleanDate(typeof body.work_date === 'string' ? body.work_date : null)
    const reason = cleanMemo(body.reason) || '月次勤怠修正で日別削除'

    if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
      return NextResponse.json({ error: 'スタッフと日付を確認してください' }, { status: 400 })
    }

    const eligibility = await isAttendanceUserEligibleForRange(userId, workDate, workDate)
    if (eligibility.error) {
      return NextResponse.json({ error: eligibility.error.message }, { status: 500 })
    }
    if (!eligibility.eligible) {
      return NextResponse.json({ error: 'スタッフが見つかりません' }, { status: 404 })
    }

    const { data: beforePunches, error: beforeError } = await adminClient
      .from('gw_attendance_punches')
      .select('id, user_id, employee_id, device_id, punch_type, work_date, punched_at, source_type, is_voided, memo, private_vehicle_place, private_vehicle_distance_km, break_override_minutes, break_override_reason')
      .eq('user_id', userId)
      .eq('work_date', workDate)
      .eq('is_voided', false)
      .order('punched_at', { ascending: true })

    if (beforeError) {
      return NextResponse.json({ error: beforeError.message }, { status: 500 })
    }

    const activePunches = ((beforePunches || []) as PunchRow[]).filter((punch) => !punch.is_voided)
    const { error: dailyNoteError } = await adminClient
      .from('gw_attendance_daily_notes')
      .delete()
      .eq('user_id', userId)
      .eq('work_date', workDate)

    if (dailyNoteError) {
      return NextResponse.json({ error: dailyNoteError.message }, { status: 500 })
    }

    if (activePunches.length === 0) {
      return NextResponse.json({ success: true, voided: 0 })
    }

    const now = new Date().toISOString()
    const { error: dbError } = await adminClient
      .from('gw_attendance_punches')
      .update({
        is_voided: true,
        voided_by: user!.id,
        voided_at: now,
        void_reason: reason,
        updated_at: now,
      })
      .in('id', activePunches.map((punch) => punch.id))

    if (dbError) {
      return NextResponse.json({ error: dbError.message }, { status: 500 })
    }

    await Promise.allSettled(activePunches.map((punch) => writeCorrectionLog({
      punchId: punch.id,
      employeeId: punch.employee_id || null,
      correctionType: 'void',
      reason,
      beforePayload: punch,
      afterPayload: { is_voided: true, void_reason: reason },
      actorId: user!.id,
    })))

    return NextResponse.json({ success: true, voided: activePunches.length })
  }

  if (body.action === 'monthly_day_update') {
    const userId = typeof body.user_id === 'string' ? body.user_id.trim() : ''
    const workDate = cleanDate(typeof body.work_date === 'string' ? body.work_date : null)
    const clockInTime = typeof body.clock_in_time === 'string' ? body.clock_in_time.trim() : ''
    const clockOutTime = typeof body.clock_out_time === 'string' ? body.clock_out_time.trim() : ''

    if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
      return NextResponse.json({ error: 'スタッフと日付を確認してください' }, { status: 400 })
    }
    if (clockInTime && !jstDateTimeToIso(workDate, clockInTime)) {
      return NextResponse.json({ error: '出勤時刻を確認してください' }, { status: 400 })
    }
    if (clockOutTime && !jstDateTimeToIso(workDate, clockOutTime)) {
      return NextResponse.json({ error: '退勤時刻を確認してください' }, { status: 400 })
    }

    const eligibility = await isAttendanceUserEligibleForRange(userId, workDate, workDate)
    if (eligibility.error) {
      return NextResponse.json({ error: eligibility.error.message }, { status: 500 })
    }
    if (!eligibility.eligible) {
      return NextResponse.json({ error: 'スタッフが見つかりません' }, { status: 404 })
    }

    const { data: beforePunches, error: beforeError } = await adminClient
      .from('gw_attendance_punches')
      .select('id, user_id, employee_id, device_id, punch_type, work_date, punched_at, source_type, is_voided, memo, private_vehicle_place, private_vehicle_distance_km, break_override_minutes, break_override_reason')
      .eq('user_id', userId)
      .eq('work_date', workDate)
      .eq('is_voided', false)
      .order('punched_at', { ascending: true })

    if (beforeError) {
      return NextResponse.json({ error: beforeError.message }, { status: 500 })
    }

    const employeeId = await getEmployeeIdForUser(userId)
    const clockIns = ((beforePunches || []) as PunchRow[]).filter((punch) => punch.punch_type === 'clock_in')
    const clockOuts = ((beforePunches || []) as PunchRow[]).filter((punch) => punch.punch_type === 'clock_out')
    const currentClockIn = clockIns[0] || null
    const currentClockOut = clockOuts[clockOuts.length - 1] || null
    const options = buildPunchOptions(body, user!.id)
    const now = new Date().toISOString()
    const touched: string[] = []

    async function upsertPunch(type: PunchType, timeText: string, current: PunchRow | null) {
      if (!timeText) {
        if (!current) return
        const { error: voidError } = await adminClient
          .from('gw_attendance_punches')
          .update({
            is_voided: true,
            voided_by: user!.id,
            voided_at: now,
            void_reason: '月次修正で空欄に変更',
            updated_at: now,
          })
          .eq('id', current.id)
        if (voidError) throw voidError
        await writeCorrectionLog({
          punchId: current.id,
          employeeId: current.employee_id || employeeId,
          correctionType: 'void',
          reason: '月次修正で空欄に変更',
          beforePayload: current,
          afterPayload: { is_voided: true },
          actorId: user!.id,
        }).catch(() => {})
        touched.push(current.id)
        return
      }

      const punchedAt = jstDateTimeToIso(workDate, timeText)
      if (!punchedAt) throw new Error('時刻を確認してください')
      const isClockOut = type === 'clock_out'
      const payload = {
        user_id: userId,
        employee_id: employeeId,
        device_id: current?.device_id || null,
        punch_type: type,
        work_date: workDate,
        punched_at: punchedAt,
        source_type: current?.source_type || 'admin',
        memo: isClockOut || !clockOutTime ? options.memo : null,
        private_vehicle_place: isClockOut ? options.private_vehicle_place : null,
        private_vehicle_distance_km: isClockOut ? options.private_vehicle_distance_km : null,
        break_override_minutes: isClockOut ? options.break_override_minutes : null,
        break_override_reason: isClockOut ? options.break_override_reason : null,
        break_override_requested_by: isClockOut ? options.break_override_requested_by : null,
        break_override_requested_at: isClockOut ? options.break_override_requested_at : null,
        updated_at: now,
      }

      if (current) {
        const { error: updateError } = await adminClient
          .from('gw_attendance_punches')
          .update(payload)
          .eq('id', current.id)
        if (updateError) throw updateError
        await writeCorrectionLog({
          punchId: current.id,
          employeeId,
          correctionType: 'admin_edit',
          reason: options.memo || '月次勤怠修正',
          beforePayload: current,
          afterPayload: payload,
          actorId: user!.id,
        }).catch(() => {})
        touched.push(current.id)
      } else {
        const { data: inserted, error: insertError } = await adminClient
          .from('gw_attendance_punches')
          .insert({
            ...payload,
            created_by: user!.id,
            ip_allowed: true,
          })
          .select('id')
          .single()
        if (insertError || !inserted) throw insertError || new Error('打刻追加に失敗しました')
        await writeCorrectionLog({
          punchId: inserted.id,
          employeeId,
          correctionType: 'admin_edit',
          reason: options.memo || '月次勤怠修正で追加',
          beforePayload: {},
          afterPayload: payload,
          actorId: user!.id,
        }).catch(() => {})
        touched.push(inserted.id)
      }
    }

    try {
      await upsertPunch('clock_in', clockInTime, currentClockIn)
      await upsertPunch('clock_out', clockOutTime, currentClockOut)

      if (options.memo) {
        const { error: dailyNoteError } = await adminClient
          .from('gw_attendance_daily_notes')
          .upsert({
            user_id: userId,
            work_date: workDate,
            memo: options.memo,
            created_by: user!.id,
            updated_by: user!.id,
            updated_at: now,
          }, { onConflict: 'user_id,work_date' })
        if (dailyNoteError) throw dailyNoteError
      } else {
        const { error: dailyNoteError } = await adminClient
          .from('gw_attendance_daily_notes')
          .delete()
          .eq('user_id', userId)
          .eq('work_date', workDate)
        if (dailyNoteError) throw dailyNoteError
      }
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : '月次勤怠修正に失敗しました' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, touched })
  }

  if (body.action === 'monthly_staff_check') {
    const targetUserId = typeof body.user_id === 'string' ? body.user_id.trim() : ''
    const checkMonth = cleanMonthStart(body.month)
    const checked = body.checked !== false

    if (!targetUserId) {
      return NextResponse.json({ error: 'スタッフを選択してください' }, { status: 400 })
    }

    const eligibility = await isAttendanceUserEligibleForRange(
      targetUserId,
      checkMonth,
      monthEndFromStart(checkMonth),
    )
    if (eligibility.error) {
      return NextResponse.json({ error: eligibility.error.message }, { status: 500 })
    }
    if (!eligibility.eligible) {
      return NextResponse.json({ error: 'スタッフが見つかりません' }, { status: 404 })
    }

    if (!checked) {
      const { error: deleteError } = await adminClient
        .from('gw_attendance_monthly_checks')
        .delete()
        .eq('check_month', checkMonth)
        .eq('user_id', targetUserId)

      if (deleteError) {
        return NextResponse.json({ error: deleteError.message }, { status: 500 })
      }

      return NextResponse.json({ success: true, checked: false })
    }

    const now = new Date().toISOString()
    const { error: upsertError } = await adminClient
      .from('gw_attendance_monthly_checks')
      .upsert({
        check_month: checkMonth,
        user_id: targetUserId,
        checked_by: user!.id,
        checked_at: now,
        updated_at: now,
      }, { onConflict: 'check_month,user_id' })

    if (upsertError) {
      return NextResponse.json({ error: upsertError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, checked: true })
  }

  const punchId = typeof body.id === 'string' ? body.id.trim() : ''
  if (!punchId) {
    return NextResponse.json({ error: 'id が必要です' }, { status: 400 })
  }

  const { data: beforePunch, error: beforeError } = await adminClient
    .from('gw_attendance_punches')
    .select('id, user_id, employee_id, device_id, punch_type, work_date, punched_at, source_type, is_voided, memo, private_vehicle_place, private_vehicle_distance_km, break_override_minutes, break_override_reason')
    .eq('id', punchId)
    .single()

  if (beforeError || !beforePunch) {
    return NextResponse.json({ error: beforeError?.message || '打刻が見つかりません' }, { status: 404 })
  }

  if (body.action === 'update') {
    const userId = typeof body.user_id === 'string' ? body.user_id.trim() : ''
    const punchType = normalizePunchType(body.punch_type)
    const workDate = cleanDate(typeof body.work_date === 'string' ? body.work_date : null)
    const timeText = typeof body.time === 'string' ? body.time.trim() : ''
    const punchedAt = jstDateTimeToIso(workDate, timeText)

    if (!userId || !punchType || !punchedAt) {
      return NextResponse.json({ error: 'スタッフ、打刻種別、日付、時刻を確認してください' }, { status: 400 })
    }

    const eligibility = await isAttendanceUserEligibleForRange(userId, workDate, workDate)
    if (eligibility.error) {
      return NextResponse.json({ error: eligibility.error.message }, { status: 500 })
    }
    if (!eligibility.eligible) {
      return NextResponse.json({ error: 'スタッフが見つかりません' }, { status: 404 })
    }

    const deviceId = typeof body.device_id === 'string' && body.device_id.trim() ? body.device_id.trim() : null
    const [employeeId, workplaceId] = await Promise.all([
      getEmployeeIdForUser(userId),
      getWorkplaceIdForDevice(deviceId),
    ])
    const options = buildPunchOptions(body, user!.id)
    const updatePayload = {
      user_id: userId,
      employee_id: employeeId,
      workplace_id: workplaceId,
      device_id: deviceId,
      punch_type: punchType,
      work_date: workDate,
      punched_at: punchedAt,
      updated_at: new Date().toISOString(),
      ...options,
    }

    const { error: updateError } = await adminClient
      .from('gw_attendance_punches')
      .update(updatePayload)
      .eq('id', punchId)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    await writeCorrectionLog({
      punchId,
      employeeId,
      correctionType: 'admin_edit',
      reason: cleanMemo(body.reason) || '打刻間違いの管理者修正',
      beforePayload: beforePunch as PunchRow,
      afterPayload: updatePayload,
      actorId: user!.id,
    }).catch(() => {})

    return NextResponse.json({ success: true })
  }

  const reason = cleanMemo(body.reason)
  const { error: dbError } = await adminClient
    .from('gw_attendance_punches')
    .update({
      is_voided: true,
      voided_by: user!.id,
      voided_at: new Date().toISOString(),
      void_reason: reason || '管理者による無効化',
      updated_at: new Date().toISOString(),
    })
    .eq('id', punchId)

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  await writeCorrectionLog({
    punchId,
    employeeId: (beforePunch as PunchRow).employee_id || null,
    correctionType: 'void',
    reason: reason || '管理者による無効化',
    beforePayload: beforePunch as PunchRow,
    afterPayload: { is_voided: true, void_reason: reason || '管理者による無効化' },
    actorId: user!.id,
  }).catch(() => {})

  return NextResponse.json({ success: true })
}
