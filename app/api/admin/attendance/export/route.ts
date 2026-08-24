import { NextRequest, NextResponse } from 'next/server'
import { USER_DEPARTMENTS, normalizeUserDepartment, type UserDepartment } from '@/lib/departments'
import { getManagementPermissions } from '@/lib/management-permissions'
import {
  loadPaidLeaveAttendanceDays,
  type PaidLeaveAttendanceDay,
} from '@/lib/paid-leave-attendance-data'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'
import { loadAttendanceWorkforceForRange } from '@/lib/workforce-employment'

type PunchType = 'clock_in' | 'clock_out'

type UserRow = {
  id: string
  display_name: string
  real_name?: string | null
  department?: string | null
  status?: string | null
}

type EmployeeRow = {
  user_id: string | null
  employee_code: string | null
  hire_date: string | null
  resigned_date?: string | null
  payroll_status?: string | null
}

type PunchRow = {
  id: string
  user_id: string | null
  punch_type: PunchType
  work_date: string
  punched_at: string
  is_voided: boolean
  memo: string | null
  private_vehicle_place?: string | null
  private_vehicle_distance_km?: number | string | null
  break_override_minutes?: number | null
  break_override_reason?: string | null
}

type DailyNoteRow = {
  user_id: string
  work_date: string
  memo: string
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
const THIRTY_MINUTE_BREAK_NOTE = '30分休憩'

async function requireAttendanceAdmin() {
  const user = await getUserSession()
  if (!user) return { error: '認証が必要です', status: 401 }

  const permissions = getManagementPermissions(user)
  if (!permissions.canManageAttendance) {
    return { error: '勤怠管理権限が必要です', status: 403 }
  }

  return { error: null, status: 0 }
}

function cleanMonth(value: string | null) {
  const today = new Date()
  const fallback = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
  return value && /^\d{4}-\d{2}$/.test(value) ? value : fallback
}

function monthRange(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  const start = new Date(Date.UTC(year, monthNumber - 1, 1))
  const end = new Date(Date.UTC(year, monthNumber, 0))
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  }
}

function eachDate(startDate: string, endDate: string) {
  const dates: string[] = []
  const [startYear, startMonth, startDay] = startDate.split('-').map(Number)
  const [endYear, endMonth, endDay] = endDate.split('-').map(Number)
  const current = new Date(Date.UTC(startYear, startMonth - 1, startDay))
  const end = new Date(Date.UTC(endYear, endMonth - 1, endDay))

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10))
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return dates
}

function displayName(user: UserRow) {
  return user.real_name || user.display_name
}

function sortDate(value: string | null | undefined) {
  if (!value) return Number.MAX_SAFE_INTEGER
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}

function xmlEscape(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function sheetName(value: string, fallback: string) {
  const cleaned = (value || fallback)
    .replace(/[\[\]\*\/\\\?:]/g, '')
    .trim()
    .slice(0, 31)
  return cleaned || fallback
}

function formatTime(value?: string | null) {
  if (!value) return ''
  return new Date(value).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function weekday(dateText: string) {
  const [year, month, day] = dateText.split('-').map(Number)
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day, 15, 0, 0)).getUTCDay()] || ''
}

function row(cells: unknown[], styleId?: string) {
  return `<Row>${cells.map((cell) => {
    const style = styleId ? ` ss:StyleID="${styleId}"` : ''
    return `<Cell${style}><Data ss:Type="String">${xmlEscape(cell)}</Data></Cell>`
  }).join('')}</Row>`
}

function stripBreakMemoPrefix(value: string | null | undefined, hasThirtyMinuteBreak: boolean) {
  const memo = (value || '').trim()
  if (!hasThirtyMinuteBreak) return memo
  if (memo === THIRTY_MINUTE_BREAK_NOTE) return ''
  if (memo.startsWith(`${THIRTY_MINUTE_BREAK_NOTE} / `)) {
    return memo.slice(`${THIRTY_MINUTE_BREAK_NOTE} / `.length).trim()
  }
  if (memo.startsWith(`${THIRTY_MINUTE_BREAK_NOTE}\n`)) {
    return memo.slice(`${THIRTY_MINUTE_BREAK_NOTE}\n`.length).trim()
  }
  return memo
}

function completePunchSessions(punches: PunchRow[]) {
  const sorted = [...punches].sort((a, b) => a.punched_at.localeCompare(b.punched_at))
  const sessions: Array<{ clockIn: PunchRow; clockOut: PunchRow }> = []
  let pendingClockIn: PunchRow | null = null
  for (const punch of sorted) {
    if (punch.punch_type === 'clock_in') {
      if (!pendingClockIn) pendingClockIn = punch
      continue
    }
    if (!pendingClockIn) continue
    sessions.push({ clockIn: pendingClockIn, clockOut: punch })
    pendingClockIn = null
  }
  return sessions
}

function notesFor(
  clockIn: PunchRow | null,
  clockOut: PunchRow | null,
  punches: PunchRow[],
  dailyMemo: string | null = null,
  isBereavementLeave = false,
) {
  const hasThirtyMinuteBreak = clockOut?.break_override_minutes === 30 || clockIn?.break_override_minutes === 30
  const memo = dailyMemo ?? stripBreakMemoPrefix(clockOut?.memo || clockIn?.memo || '', hasThirtyMinuteBreak)
  const sessions = completePunchSessions(punches)
  const hasIncompletePunch = sessions.length * 2 !== punches.length
  const notes = [
    isBereavementLeave ? '忌引き休' : '',
    sessions.length > 1
      ? `複数勤務: ${sessions.map((session) => (
        `${formatTime(session.clockIn.punched_at)}-${formatTime(session.clockOut.punched_at)}`
      )).join(' / ')}`
      : '',
    hasIncompletePunch ? '要確認: 出勤・退勤が対になっていない打刻あり' : '',
    clockOut?.private_vehicle_place ? `自家用車場所: ${clockOut.private_vehicle_place}` : '',
    clockOut?.private_vehicle_distance_km !== null && clockOut?.private_vehicle_distance_km !== undefined
      ? `距離: ${clockOut.private_vehicle_distance_km}km`
      : '',
    memo,
  ].filter(Boolean)
  return notes.join(' / ')
}

function workbookXml(options: {
  month: string
  department: UserDepartment
  users: UserRow[]
  employeesByUserId: Map<string, EmployeeRow>
  punchesByUserDate: Map<string, PunchRow[]>
  dailyNotesByUserDate: Map<string, string>
  bereavementDates: Set<string>
  paidLeaveByUserDate: Map<string, PaidLeaveAttendanceDay>
  dates: string[]
}) {
  const worksheets = options.users.map((user, index) => {
    const employee = options.employeesByUserId.get(user.id) || null
    const rows = [
      row(['対象月', options.month]),
      row(['所属', options.department]),
      row(['氏名', displayName(user)]),
      row(['社員NO', employee?.employee_code || '']),
      row([]),
      row(['日付', '曜日', '出勤', '退勤', '30分休憩', '労務士への連絡備考'], 'Header'),
      ...options.dates.map((date) => {
        const punches = options.punchesByUserDate.get(`${user.id}:${date}`) || []
        const clockIns = punches
          .filter((punch) => punch.punch_type === 'clock_in')
          .sort((a, b) => a.punched_at.localeCompare(b.punched_at))
        const clockOuts = punches
          .filter((punch) => punch.punch_type === 'clock_out')
          .sort((a, b) => b.punched_at.localeCompare(a.punched_at))
        const clockIn = clockIns[0] || null
        const clockOut = clockOuts[0] || null
        const paidLeave = options.paidLeaveByUserDate.get(`${user.id}:${date}`) || null
        return row([
          date,
          weekday(date),
          paidLeave?.clockInTime || formatTime(clockIn?.punched_at),
          paidLeave?.clockOutTime || formatTime(clockOut?.punched_at),
          paidLeave
            ? paidLeave.breakMinutes === 30 ? 'あり' : ''
            : clockOut?.break_override_minutes === 30 || clockIn?.break_override_minutes === 30 ? 'あり' : '',
          notesFor(
            clockIn,
            clockOut,
            punches,
            options.dailyNotesByUserDate.get(`${user.id}:${date}`) ?? null,
            options.bereavementDates.has(`${user.id}:${date}`),
          ),
        ])
      }),
    ].join('')

    return `<Worksheet ss:Name="${xmlEscape(sheetName(displayName(user), `staff${index + 1}`))}"><Table>${rows}</Table></Worksheet>`
  }).join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="Header">
   <Font ss:Bold="1"/>
   <Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 ${worksheets}
</Workbook>`
}

export async function GET(request: NextRequest) {
  const auth = await requireAttendanceAdmin()
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const month = cleanMonth(request.nextUrl.searchParams.get('month'))
  const rawDepartment = request.nextUrl.searchParams.get('department')
  const department = normalizeUserDepartment(rawDepartment)
  if (!USER_DEPARTMENTS.includes(department)) {
    return NextResponse.json({ error: '所属を確認してください' }, { status: 400 })
  }

  const { startDate, endDate } = monthRange(month)
  const workforce = await loadAttendanceWorkforceForRange({ startDate, endDate, department })
  if (workforce.error) return NextResponse.json({ error: workforce.error.message }, { status: 500 })

  const userRows = (workforce.users as UserRow[])
    .map((user) => ({ ...user, display_name: displayName(user), department: normalizeUserDepartment(user.department) }))

  const userIds = userRows.map((user) => user.id)
  const [punchesResult, dailyNotesResult, bereavementResult] = await Promise.all([
    userIds.length
      ? adminClient
        .from('gw_attendance_punches')
        .select('id, user_id, punch_type, work_date, punched_at, is_voided, memo, private_vehicle_place, private_vehicle_distance_km, break_override_minutes, break_override_reason')
        .in('user_id', userIds)
        .eq('is_voided', false)
        .gte('work_date', startDate)
        .lte('work_date', endDate)
        .order('punched_at', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    userIds.length
      ? adminClient
        .from('gw_attendance_daily_notes')
        .select('user_id, work_date, memo')
        .in('user_id', userIds)
        .gte('work_date', startDate)
        .lte('work_date', endDate)
      : Promise.resolve({ data: [], error: null }),
    userIds.length
      ? adminClient
        .from('gw_workday_resolutions')
        .select('user_id, work_date')
        .in('user_id', userIds)
        .eq('resolution_type', 'bereavement_leave')
        .eq('resolution_status', 'admin_confirmed')
        .gte('work_date', startDate)
        .lte('work_date', endDate)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (punchesResult.error) return NextResponse.json({ error: punchesResult.error.message }, { status: 500 })
  if (dailyNotesResult.error) return NextResponse.json({ error: dailyNotesResult.error.message }, { status: 500 })
  if (bereavementResult.error) return NextResponse.json({ error: bereavementResult.error.message }, { status: 500 })

  const employeesByUserId = new Map<string, EmployeeRow>()
  for (const [userId, employee] of workforce.employeesByUserId) {
    employeesByUserId.set(userId, employee as EmployeeRow)
  }

  const sortedUsers = [...userRows].sort((a, b) => {
    const employeeA = employeesByUserId.get(a.id)
    const employeeB = employeesByUserId.get(b.id)
    const hireDiff = sortDate(employeeA?.hire_date) - sortDate(employeeB?.hire_date)
    return hireDiff || displayName(a).localeCompare(displayName(b), 'ja')
  })

  const punchesByUserDate = new Map<string, PunchRow[]>()
  for (const punch of (punchesResult.data || []) as PunchRow[]) {
    if (!punch.user_id) continue
    const key = `${punch.user_id}:${punch.work_date}`
    const bucket = punchesByUserDate.get(key) || []
    bucket.push(punch)
    punchesByUserDate.set(key, bucket)
  }

  const dailyNotesByUserDate = new Map<string, string>()
  for (const note of (dailyNotesResult.data || []) as DailyNoteRow[]) {
    dailyNotesByUserDate.set(`${note.user_id}:${note.work_date}`, note.memo)
  }
  const bereavementDates = new Set(
    (bereavementResult.data || []).map((row) => `${row.user_id}:${row.work_date}`),
  )

  let paidLeaveDays: PaidLeaveAttendanceDay[] = []
  try {
    paidLeaveDays = await loadPaidLeaveAttendanceDays({
      userIds,
      startDate,
      endDate,
      punches: (punchesResult.data || []) as PunchRow[],
    })
  } catch (paidLeaveError) {
    const message = paidLeaveError instanceof Error ? paidLeaveError.message : '有給の提出用打刻を作成できませんでした'
    return NextResponse.json({ error: message }, { status: 500 })
  }
  const paidLeaveByUserDate = new Map(
    paidLeaveDays.map((day) => [`${day.userId}:${day.workDate}`, day]),
  )

  const xml = workbookXml({
    month,
    department,
    users: sortedUsers,
    employeesByUserId,
    punchesByUserDate,
    dailyNotesByUserDate,
    bereavementDates,
    paidLeaveByUserDate,
    dates: eachDate(startDate, endDate),
  })

  const encodedName = encodeURIComponent(`勤怠提出_${department}_${month}.xls`)
  return new NextResponse(xml, {
    headers: {
      'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
      'Cache-Control': 'no-store',
    },
  })
}
