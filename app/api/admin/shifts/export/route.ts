import { NextRequest, NextResponse } from 'next/server'
import { USER_DEPARTMENTS, normalizeUserDepartment, type UserDepartment } from '@/lib/departments'
import { countsTowardDepartmentHeadcount } from '@/lib/shift-assignments'
import { isShiftRosterExcluded } from '@/lib/shift-request-exclusions'
import { getManagementPermissions } from '@/lib/management-permissions'
import { getUserSession } from '@/lib/session'
import { shiftEcSaleLabels, type ShiftEcSaleOption, type ShiftEcSaleTimes } from '@/lib/shift-sales'
import { shiftTimeeDisplay, shiftTimeeHeadcount } from '@/lib/shift-timee'
import { adminClient } from '@/lib/supabase/admin'

type ShiftPeriod = {
  id: string
  department: UserDepartment
  title: string
  start_date: string
  end_date: string
  status: string
}

type ShiftEmployee = {
  id: string
  user_id: string
  employee_code: string | null
  display_name: string
  real_name: string | null
  hire_date: string | null
  department: UserDepartment
}

type ShiftAssignment = {
  user_id: string | null
  employee_id: string | null
  work_date: string
  shift_label: string | null
  start_time: string | null
  end_time: string | null
  note: string | null
  source: string
}

type ShiftRequirement = {
  work_date: string
  required_count: number | string | null
  workplace_label: string | null
  notes: string | null
  notes2: string | null
  notes3: string | null
  production_plan: string | null
  timee_count: number | string | null
  ec_sale_tags: string[]
  ec_sale_times: ShiftEcSaleTimes
}

type ShiftRequest = {
  user_id: string
  work_date: string
  request_type: string
  priority: string
  start_time: string | null
  end_time: string | null
  memo: string | null
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

async function requireShiftAdmin() {
  const user = await getUserSession()
  if (!user) return { error: '認証が必要です', status: 401 }

  const permissions = getManagementPermissions(user)
  if (!permissions.canManageAttendance) {
    return { error: '勤怠管理権限が必要です', status: 403 }
  }

  return { error: null, status: 0 }
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
  const cleaned = (value || fallback).replace(/[\[\]\*\/\\\?:]/g, '').trim().slice(0, 31)
  return cleaned || fallback
}

function row(cells: unknown[], styleId?: string) {
  return `<Row>${cells.map((cell) => {
    const style = styleId ? ` ss:StyleID="${styleId}"` : ''
    return `<Cell${style}><Data ss:Type="String">${xmlEscape(cell)}</Data></Cell>`
  }).join('')}</Row>`
}

function addDays(dateText: string, days: number) {
  const [year, month, day] = dateText.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return date.toISOString().slice(0, 10)
}

function eachDate(startDate: string, endDate: string) {
  const dates: string[] = []
  let current = startDate
  while (current <= endDate) {
    dates.push(current)
    current = addDays(current, 1)
  }
  return dates
}

function weekday(dateText: string) {
  const [year, month, day] = dateText.split('-').map(Number)
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day, 15)).getUTCDay()] || ''
}

function displayName(row: { display_name?: string | null; real_name?: string | null }) {
  return row.real_name || row.display_name || '名称未設定'
}

function sortDate(value: string | null | undefined) {
  if (!value) return Number.MAX_SAFE_INTEGER
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}

function hrProfile(rawPayload: Record<string, unknown> | null | undefined) {
  const value = rawPayload?.hr_profile
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as { deleted_at?: string; provisional_hire?: boolean; shift_visible_before_hire?: boolean }
    : {}
}

function isProvisionalShiftProfile(profile: ReturnType<typeof hrProfile>) {
  return profile.provisional_hire === true && profile.shift_visible_before_hire === true
}

function tsgDepartmentFromText(value: unknown): UserDepartment | null {
  if (typeof value !== 'string' || !value.trim()) return null
  if (USER_DEPARTMENTS.includes(value as UserDepartment)) return value as UserDepartment
  if (value.includes('道の駅')) return '道の駅'
  if (value.includes('フロア') || value.includes('売上') || value.includes('ブランド館')) return 'フロア'
  if (value.includes('製造') || value.includes('本社')) return '製造'
  return null
}

async function loadShiftEmployees(department: UserDepartment) {
  const [
    { data: employees, error: employeesError },
    { data: users, error: usersError },
  ] = await Promise.all([
    adminClient
      .from('gw_payroll_employees')
      .select('id, user_id, employee_code, display_name, real_name, hire_date, department, payroll_status, raw_payload')
      .in('payroll_status', ['active', 'inactive']),
    adminClient
      .from('gw_users')
      .select('id, display_name, real_name, department, status')
      .eq('status', 'approved'),
  ])

  const dbError = employeesError || usersError
  if (dbError) throw dbError

  const userMap = new Map((users || []).map((user) => [user.id, user]))
  return ((employees || []) as Array<ShiftEmployee & { payroll_status?: string; raw_payload?: Record<string, unknown> | null }>)
    .filter((employee) => {
      const profile = hrProfile(employee.raw_payload)
      return employee.user_id && !profile.deleted_at && (
        employee.payroll_status === 'active' || isProvisionalShiftProfile(profile)
      )
    })
    .map((employee) => {
      const user = employee.user_id ? userMap.get(employee.user_id) : null
      const normalizedDepartment =
        tsgDepartmentFromText(user?.department) ||
        tsgDepartmentFromText(employee.department) ||
        normalizeUserDepartment(employee.department)
      return {
        id: employee.id,
        user_id: employee.user_id!,
        employee_code: employee.employee_code,
        display_name: displayName({ display_name: user?.display_name || employee.display_name, real_name: user?.real_name || employee.real_name }),
        real_name: user?.real_name || employee.real_name || null,
        hire_date: employee.hire_date,
        department: normalizedDepartment,
      }
    })
    .filter((employee) => employee.department === department && !isShiftRosterExcluded(employee))
    .sort((a, b) => sortDate(a.hire_date) - sortDate(b.hire_date) || displayName(a).localeCompare(displayName(b), 'ja'))
}

function requestLabel(request?: ShiftRequest) {
  if (!request) return ''
  const labels: Record<string, string> = {
    day_off: '休み希望',
    unavailable: '不可',
    available: '出勤可',
    time_preference: '時間希望',
    note: 'メモ',
  }
  const time = request.start_time || request.end_time ? ` ${request.start_time || ''}-${request.end_time || ''}` : ''
  const memo = request.memo ? ` ${request.memo}` : ''
  return `${labels[request.request_type] || request.request_type}${time}${memo}`.trim()
}

function workbookXml(options: {
  period: ShiftPeriod
  employees: ShiftEmployee[]
  requirements: ShiftRequirement[]
  assignments: ShiftAssignment[]
  requests: ShiftRequest[]
  saleOptions: ShiftEcSaleOption[]
}) {
  const assignmentsByUserDate = new Map<string, ShiftAssignment>()
  for (const assignment of options.assignments) {
    if (assignment.user_id) assignmentsByUserDate.set(`${assignment.user_id}:${assignment.work_date}`, assignment)
  }

  const requestsByUserDate = new Map<string, ShiftRequest>()
  for (const request of options.requests) {
    requestsByUserDate.set(`${request.user_id}:${request.work_date}`, request)
  }

  const requirementsByDate = new Map(options.requirements.map((requirement) => [requirement.work_date, requirement]))
  const dates = eachDate(options.period.start_date, options.period.end_date)
  const header = ['日付', '曜日', '必要', '実割当', ...options.employees.map((employee) => displayName(employee)), 'Timee', '勤務場所', '備考', '備考2', '備考3', '作業予定']
  const shiftRows = [
    row(['シフト名', options.period.title]),
    row(['所属', options.period.department]),
    row(['期間', `${options.period.start_date}〜${options.period.end_date}`]),
    row([]),
    row(header, 'Header'),
    ...dates.map((date) => {
      const requirement = requirementsByDate.get(date)
      const labels = options.employees.map((employee) => {
        const assignment = assignmentsByUserDate.get(`${employee.user_id}:${date}`)
        const request = requestsByUserDate.get(`${employee.user_id}:${date}`)
        const shift = assignment?.shift_label || ''
        const requestText = requestLabel(request)
        return requestText ? `${shift}${shift ? ' / ' : ''}${requestText}` : shift
      })
      const assignedStaff = options.employees.filter((employee) => {
        const assignment = assignmentsByUserDate.get(`${employee.user_id}:${date}`)
        const request = requestsByUserDate.get(`${employee.user_id}:${date}`)
        if (request?.request_type === 'paid_leave_full') return false
        return countsTowardDepartmentHeadcount(options.period.department, assignment)
      }).length
      const assigned = assignedStaff + (options.period.department === '道の駅'
        ? shiftTimeeHeadcount(requirement?.notes2, requirement?.notes3, requirement?.timee_count)
        : 0)
      const saleLabels = options.period.department === 'フロア'
        ? shiftEcSaleLabels(requirement?.ec_sale_tags, options.saleOptions, requirement?.ec_sale_times)
        : []
      const manufacturingNote2 = [...new Set(
        [requirement?.notes2, requirement?.production_plan]
          .map((value) => value?.trim() || '')
          .filter(Boolean),
      )].join(' / ')
      const freeNote = options.period.department === '道の駅' || options.period.department === '製造'
        ? requirement?.notes || ''
        : requirement?.notes2 || requirement?.notes || ''
      const combinedNotes = [
        ...saleLabels,
        options.period.department === '道の駅' || options.period.department === '製造' ? freeNote : '',
      ].filter(Boolean).join(' / ')
      const roadStationTimee = options.period.department === '道の駅'
        ? shiftTimeeDisplay(requirement?.notes2, requirement?.notes3, requirement?.timee_count)
        : ''
      return row([
        date,
        weekday(date),
        requirement?.required_count ?? '',
        assigned,
        ...labels,
        options.period.department === '道の駅' ? roadStationTimee : requirement?.timee_count ?? '',
        requirement?.workplace_label || '',
        combinedNotes,
        options.period.department === '道の駅' ? '' : options.period.department === '製造' ? manufacturingNote2 : freeNote,
        options.period.department === '道の駅' ? '' : requirement?.notes3 || '',
        options.period.department === '製造' ? '' : requirement?.production_plan || '',
      ])
    }),
  ].join('')

  const requestRows = [
    row(['日付', '氏名', '希望', '優先', '開始', '終了', 'メモ'], 'Header'),
    ...options.requests.map((request) => {
      const employee = options.employees.find((item) => item.user_id === request.user_id)
      return row([
        request.work_date,
        employee ? displayName(employee) : request.user_id,
        request.request_type,
        request.priority,
        request.start_time || '',
        request.end_time || '',
        request.memo || '',
      ])
    }),
  ].join('')

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
 <Worksheet ss:Name="${xmlEscape(sheetName(options.period.department, 'シフト'))}"><Table>${shiftRows}</Table></Worksheet>
 <Worksheet ss:Name="希望一覧"><Table>${requestRows}</Table></Worksheet>
</Workbook>`
}

export async function GET(request: NextRequest) {
  const auth = await requireShiftAdmin()
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const periodId = request.nextUrl.searchParams.get('period_id') || ''
  if (!periodId) return NextResponse.json({ error: 'シフト期間が必要です' }, { status: 400 })

  const { data: period, error: periodError } = await adminClient
    .from('gw_shift_periods')
    .select('id, department, title, start_date, end_date, status')
    .eq('id', periodId)
    .single()

  if (periodError || !period) {
    return NextResponse.json({ error: periodError?.message || 'シフト期間が見つかりません' }, { status: 404 })
  }

  const shiftPeriod = period as ShiftPeriod
  try {
    const [allEmployees, requirementsResult, assignmentsResult, requestsResult, saleOptionsResult, exclusionsResult] = await Promise.all([
      loadShiftEmployees(shiftPeriod.department),
      adminClient
        .from('gw_shift_requirements')
        .select('work_date, required_count, workplace_label, notes, notes2, notes3, production_plan, timee_count, ec_sale_tags, ec_sale_times')
        .eq('period_id', shiftPeriod.id)
        .order('work_date', { ascending: true }),
      adminClient
        .from('gw_shift_assignments')
        .select('user_id, employee_id, work_date, shift_label, start_time, end_time, note, source')
        .eq('period_id', shiftPeriod.id)
        .order('work_date', { ascending: true }),
      adminClient
        .from('gw_shift_requests')
        .select('user_id, work_date, request_type, priority, start_time, end_time, memo')
        .eq('period_id', shiftPeriod.id)
        .order('work_date', { ascending: true }),
      adminClient
        .from('gw_shift_ec_sales')
        .select('id, label, color, start_time, end_time, sort_order, is_active')
        .order('sort_order', { ascending: true }),
      adminClient
        .from('gw_shift_period_exclusions')
        .select('user_id')
        .eq('period_id', shiftPeriod.id),
    ])

    const dbError = requirementsResult.error || assignmentsResult.error || requestsResult.error || saleOptionsResult.error || exclusionsResult.error
    if (dbError) throw dbError

    const excludedUserIds = new Set((exclusionsResult.data || []).map((row) => row.user_id))
    const employees = allEmployees.filter((employee) => !excludedUserIds.has(employee.user_id))

    const xml = workbookXml({
      period: shiftPeriod,
      employees,
      requirements: (requirementsResult.data || []) as ShiftRequirement[],
      assignments: (assignmentsResult.data || []) as ShiftAssignment[],
      requests: (requestsResult.data || []) as ShiftRequest[],
      saleOptions: (saleOptionsResult.data || []) as ShiftEcSaleOption[],
    })

    const encodedName = encodeURIComponent(`シフト_${shiftPeriod.department}_${shiftPeriod.start_date}_${shiftPeriod.end_date}.xls`)
    return new NextResponse(xml, {
      headers: {
        'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'シフト出力に失敗しました' }, { status: 500 })
  }
}
