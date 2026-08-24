import { NextRequest, NextResponse } from 'next/server'
import { getRequestIp } from '@/lib/attendance-network'
import { DEFAULT_USER_DEPARTMENT, USER_DEPARTMENTS, type UserDepartment } from '@/lib/departments'
import { adminClient } from '@/lib/supabase/admin'

type PunchType = 'clock_in' | 'clock_out'

type UserRow = {
  id: string
  display_name: string
  real_name?: string | null
  picture_url?: string | null
  department?: string | null
  line_user_id?: string | null
}

type PunchRow = {
  id: string
  user_id: string
  device_id: string | null
  punch_type: PunchType
  work_date: string
  punched_at: string
  source_type?: string | null
  memo?: string | null
  private_vehicle_place?: string | null
  private_vehicle_distance_km?: number | string | null
  break_override_minutes?: number | null
  break_override_reason?: string | null
}

type PayrollEmployeeRow = {
  user_id: string | null
  hire_date: string | null
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

function displayName(user: UserRow) {
  return user.real_name || user.display_name
}

function isTimeClockStaff(user: UserRow) {
  const lineUserId = user.line_user_id || ''
  return !lineUserId.startsWith('system_tsg_') && user.display_name !== 'TSG君' && user.real_name !== 'TSG君'
}

function normalizeDepartment(value: string | null | undefined): UserDepartment {
  return USER_DEPARTMENTS.includes(value as UserDepartment) ? value as UserDepartment : DEFAULT_USER_DEPARTMENT
}

function allowedDepartmentsForDevice(device: { code?: string | null; name?: string | null; location?: string | null }): UserDepartment[] {
  const marker = `${device.code || ''} ${device.name || ''} ${device.location || ''}`
  if (marker.includes('michinoeki') || marker.includes('道の駅')) return ['道の駅']
  if (marker.includes('hq') || marker.includes('本社')) return ['フロア', '製造']
  return [...USER_DEPARTMENTS]
}

function isRoadsideStationDevice(device: { code?: string | null; name?: string | null; location?: string | null }) {
  const marker = `${device.code || ''} ${device.name || ''} ${device.location || ''}`
  return marker.includes('michinoeki') || marker.includes('道の駅')
}

function isAllowedForDevice(user: UserRow, device: { code?: string | null; name?: string | null; location?: string | null }) {
  return allowedDepartmentsForDevice(device).includes(normalizeDepartment(user.department))
}

function cleanMemo(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 500) : ''
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

function hireDateSortValue(value: string | null | undefined) {
  if (!value) return Number.MAX_SAFE_INTEGER
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}

async function getDevice(deviceKey: string) {
  const { data, error } = await adminClient
    .from('gw_attendance_devices')
    .select('id, code, name, location, device_key, is_active, workplace_id')
    .eq('device_key', deviceKey)
    .eq('is_active', true)
    .single()

  if (error || !data) return null
  return data
}

async function getTodayPunches(workDate: string) {
  const { data, error } = await adminClient
    .from('gw_attendance_punches')
    .select('id, user_id, device_id, punch_type, work_date, punched_at, source_type, memo, private_vehicle_place, private_vehicle_distance_km, break_override_minutes, break_override_reason')
    .eq('work_date', workDate)
    .eq('is_voided', false)
    .order('punched_at', { ascending: true })

  if (error) throw error
  return (data || []) as PunchRow[]
}

async function getEmployeeIdForUser(userId: string) {
  const { data } = await adminClient
    .from('gw_payroll_employees')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle()

  return data?.id || null
}

function buildUserStates(punches: PunchRow[]) {
  const states: Record<string, { isClockedIn: boolean; lastPunch: PunchRow | null }> = {}
  for (const punch of punches) {
    states[punch.user_id] = {
      isClockedIn: punch.punch_type === 'clock_in',
      lastPunch: punch,
    }
  }
  return states
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ deviceKey: string }> },
) {
  const { deviceKey } = await context.params
  const device = await getDevice(deviceKey)
  if (!device) {
    return NextResponse.json({ error: 'タイムレコーダー端末が見つかりません' }, { status: 404 })
  }

  try {
    const workDate = getJstDate()
    const [{ data: users, error: usersError }, { data: employees, error: employeesError }, punches] = await Promise.all([
      adminClient
        .from('gw_users')
        .select('id, display_name, real_name, picture_url, department, line_user_id')
        .eq('status', 'approved')
        .order('department', { ascending: true })
        .order('display_name', { ascending: true }),
      adminClient
        .from('gw_payroll_employees')
        .select('user_id, hire_date')
        .not('user_id', 'is', null),
      getTodayPunches(workDate),
    ])

    if (usersError) {
      return NextResponse.json({ error: usersError.message }, { status: 500 })
    }
    if (employeesError) {
      return NextResponse.json({ error: employeesError.message }, { status: 500 })
    }

    const states = buildUserStates(punches)
    const departmentOrder: Record<UserDepartment, number> = { フロア: 0, 製造: 1, 道の駅: 2 }
    const hireDateMap = new Map<string, string | null>()
    for (const employee of (employees || []) as PayrollEmployeeRow[]) {
      if (!employee.user_id) continue
      const current = hireDateMap.get(employee.user_id)
      if (!current || hireDateSortValue(employee.hire_date) < hireDateSortValue(current)) {
        hireDateMap.set(employee.user_id, employee.hire_date)
      }
    }
    const staff = ((users || []) as UserRow[])
      .filter(isTimeClockStaff)
      .filter((user) => isAllowedForDevice(user, device))
      .map((user) => ({
        ...user,
        display_name: displayName(user),
        department: user.department || '製造',
        state: states[user.id] || { isClockedIn: false, lastPunch: null },
      }))
      .map((user) => ({ ...user, department: normalizeDepartment(user.department) }))
      .sort((a, b) => {
        const departmentDiff = departmentOrder[a.department] - departmentOrder[b.department]
        const hireDateDiff = hireDateSortValue(hireDateMap.get(a.id)) - hireDateSortValue(hireDateMap.get(b.id))
        return departmentDiff || hireDateDiff || a.display_name.localeCompare(b.display_name, 'ja')
      })

    return NextResponse.json({
      device,
      workDate,
      serverNow: new Date().toISOString(),
      users: staff,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'タイムレコーダー情報の取得に失敗しました' },
      { status: 500 },
    )
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ deviceKey: string }> },
) {
  const { deviceKey } = await context.params
  const device = await getDevice(deviceKey)
  if (!device) {
    return NextResponse.json({ error: 'タイムレコーダー端末が見つかりません' }, { status: 404 })
  }

  const body = await request.json().catch(() => ({}))
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : ''
  if (!userId) {
    return NextResponse.json({ error: 'user_id が必要です' }, { status: 400 })
  }

  const { data: targetUser, error: userError } = await adminClient
    .from('gw_users')
    .select('id, display_name, real_name, picture_url, department, status, line_user_id')
    .eq('id', userId)
    .eq('status', 'approved')
    .single()

  if (userError || !targetUser) {
    return NextResponse.json({ error: 'スタッフが見つかりません' }, { status: 404 })
  }

  if (!isTimeClockStaff(targetUser as UserRow)) {
    return NextResponse.json({ error: 'この端末では対象外のスタッフです' }, { status: 403 })
  }

  if (!isAllowedForDevice(targetUser as UserRow, device)) {
    return NextResponse.json({ error: 'この端末では対象外のスタッフです' }, { status: 403 })
  }

  const workDate = getJstDate()

  try {
    const punches = (await getTodayPunches(workDate)).filter((punch) => punch.user_id === userId)
    const lastPunch = punches[punches.length - 1] || null
    const punchType: PunchType = lastPunch?.punch_type === 'clock_in' ? 'clock_out' : 'clock_in'
    if (punchType === 'clock_in') {
      const { data: fullDayLeave, error: leaveError } = await adminClient
        .from('gw_paid_leave_requests')
        .select('id')
        .eq('user_id', userId)
        .eq('leave_date', workDate)
        .eq('leave_unit', 'full_day')
        .in('request_status', ['approved', 'consumed'])
        .maybeSingle()
      if (leaveError) throw leaveError
      if (fullDayLeave) {
        return NextResponse.json({
          error: '本日は有給（全休）が承認済みです。出勤へ変更する場合は、先に管理者へ有給取消を依頼してください',
        }, { status: 409 })
      }
    }
    const acceptsClockOutExtras = punchType === 'clock_out' && !isRoadsideStationDevice(device)
    const breakOverrideMinutes = acceptsClockOutExtras ? normalizeBreakOverride(body.break_override_minutes) : null
    const privateVehiclePlace = acceptsClockOutExtras ? cleanMemo(body.private_vehicle_place) : ''
    const privateVehicleDistanceKm = acceptsClockOutExtras ? normalizeDistance(body.private_vehicle_distance_km) : null
    const memo = punchType === 'clock_out' ? cleanMemo(body.memo) : ''
    const employeeId = await getEmployeeIdForUser(userId)

    const { data: punch, error } = await adminClient
      .from('gw_attendance_punches')
      .insert({
        user_id: userId,
        employee_id: employeeId,
        workplace_id: device.workplace_id || null,
        device_id: device.id,
        punch_type: punchType,
        work_date: workDate,
        source_type: 'terminal',
        client_ip: getRequestIp(request),
        network_label: device.location,
        ip_allowed: true,
        user_agent: request.headers.get('user-agent')?.slice(0, 500) || null,
        memo: memo || null,
        private_vehicle_place: privateVehiclePlace || null,
        private_vehicle_distance_km: privateVehicleDistanceKm,
        break_override_minutes: breakOverrideMinutes,
        break_override_reason: breakOverrideMinutes === 30 ? '30分休憩ボタン' : null,
        break_override_requested_by: breakOverrideMinutes ? userId : null,
        break_override_requested_at: breakOverrideMinutes ? new Date().toISOString() : null,
      })
      .select('id, user_id, device_id, punch_type, work_date, punched_at, source_type, memo, private_vehicle_place, private_vehicle_distance_km, break_override_minutes, break_override_reason')
      .single()

    if (error || !punch) {
      return NextResponse.json({ error: error?.message || '打刻に失敗しました' }, { status: 500 })
    }

    return NextResponse.json({
      device,
      user: {
        ...targetUser,
        display_name: displayName(targetUser as UserRow),
        department: targetUser.department || '製造',
      },
      punch,
      state: {
        isClockedIn: punchType === 'clock_in',
        lastPunch: punch,
      },
      workDate,
      serverNow: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '打刻に失敗しました' },
      { status: 500 },
    )
  }
}
