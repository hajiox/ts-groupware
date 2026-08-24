import { NextResponse } from 'next/server'
import { USER_DEPARTMENTS, normalizeUserDepartment, type UserDepartment } from '@/lib/departments'
import { getUserSession } from '@/lib/session'
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
  raw_payload: Record<string, unknown> | null
}

function jstDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function addDays(dateText: string, days: number) {
  const [year, month, day] = dateText.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

function normalizedDepartment(value: unknown): UserDepartment | null {
  if (typeof value !== 'string' || !value.trim()) return null
  if (USER_DEPARTMENTS.includes(value as UserDepartment)) return value as UserDepartment
  if (value.includes('道の駅')) return '道の駅'
  if (value.includes('フロア') || value.includes('売上') || value.includes('ブランド館')) return 'フロア'
  if (value.includes('製造') || value.includes('本社')) return '製造'
  return null
}

function employeeName(employee: EmployeeRow | undefined, fallback?: string | null) {
  return employee?.real_name || employee?.display_name || fallback || 'スタッフ'
}

function employeeProfile(employee: EmployeeRow) {
  const value = employee.raw_payload?.hr_profile
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as { shift_sort_order?: number | null }
    : {}
}

function workStyleOrder(value: string | null) {
  if (value === 'regular_5d_8h' || value === 'regular_6d_6_5h' || value === 'officer') return 0
  if (value === 'part_time_under_29_5h' || value === 'full_time_part') return 1
  return 2
}

const ROAD_STATION_ORDER = ['佐藤正彦', '佐藤ちさと', '生井美穂', '内海美穂', '武藤志保', '角田聖子', '新田奈美']

function compactName(value: string) {
  return value.replace(/[\s　（）()]/g, '')
}

function roadStationOrder(employee: EmployeeRow) {
  const name = compactName(employeeName(employee))
  const index = ROAD_STATION_ORDER.findIndex((candidate) => {
    const normalized = compactName(candidate)
    return name === normalized || name.startsWith(normalized)
  })
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER
}

function employeeComparator(department: UserDepartment) {
  return (left: EmployeeRow, right: EmployeeRow) => {
    const leftCustom = employeeProfile(left).shift_sort_order
    const rightCustom = employeeProfile(right).shift_sort_order
    const leftHasCustom = typeof leftCustom === 'number' && Number.isFinite(leftCustom)
    const rightHasCustom = typeof rightCustom === 'number' && Number.isFinite(rightCustom)
    if (leftHasCustom || rightHasCustom) {
      if (leftHasCustom && rightHasCustom && leftCustom !== rightCustom) return leftCustom! - rightCustom!
      if (leftHasCustom !== rightHasCustom) return leftHasCustom ? -1 : 1
    }
    if (department === '道の駅') {
      const roadOrder = roadStationOrder(left) - roadStationOrder(right)
      if (roadOrder) return roadOrder
    }
    const styleOrder = workStyleOrder(left.work_style) - workStyleOrder(right.work_style)
    if (styleOrder) return styleOrder
    const hireOrder = String(left.hire_date || '9999-12-31').localeCompare(String(right.hire_date || '9999-12-31'))
    if (hireOrder) return hireOrder
    return employeeName(left).localeCompare(employeeName(right), 'ja')
  }
}

export async function GET() {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

  try {
    const today = jstDate()
    const historyStart = addDays(today, -45)
    const { data: ownEmployee, error: ownEmployeeError } = await adminClient
      .from('gw_payroll_employees')
      .select('department')
      .eq('user_id', user.id)
      .maybeSingle()
    if (ownEmployeeError) throw ownEmployeeError

    const homeDepartment =
      normalizedDepartment(user.department)
      || normalizedDepartment(ownEmployee?.department)
      || normalizeUserDepartment(user.department)

    const { data: periods, error: periodsError } = await adminClient
      .from('gw_shift_periods')
      .select('id, department, title, start_date, end_date, status, confirmed_at')
      .in('status', ['confirmed', 'exported'])
      .eq('is_test_mode', false)
      .gte('end_date', historyStart)
      .order('start_date', { ascending: false })
      .limit(36)
    if (periodsError) throw periodsError

    const periodRows = (periods || []).map((period) => ({
      ...period,
      department: normalizedDepartment(period.department) || period.department,
    }))
    const periodIds = periodRows.map((period) => period.id)
    if (!periodIds.length) {
      return NextResponse.json({
        today,
        userId: user.id,
        homeDepartment,
        periods: [],
        assignments: [],
        requirements: [],
        requests: [],
        cellStyles: [],
        holidays: [],
      }, { headers: { 'Cache-Control': 'no-store' } })
    }

    const [
      { data: assignmentRows, error: assignmentsError },
      { data: requirementRows, error: requirementsError },
      { data: requestRows, error: requestsError },
      { data: cellStyleRows, error: cellStylesError },
      { data: holidayRows, error: holidaysError },
      { data: saleRows, error: salesError },
    ] = await Promise.all([
      adminClient
        .from('gw_shift_assignments')
        .select('id, period_id, user_id, employee_id, work_date, shift_label, start_time, end_time, assignment_type, note')
        .in('period_id', periodIds)
        .order('work_date', { ascending: true }),
      adminClient
        .from('gw_shift_requirements')
        .select('id, period_id, work_date, required_count, workplace_label, notes, notes2, notes3, production_plan, timee_count, ec_sale_tags')
        .in('period_id', periodIds)
        .order('work_date', { ascending: true }),
      adminClient
        .from('gw_shift_requests')
        .select('period_id, user_id, employee_id, work_date, request_type')
        .in('period_id', periodIds)
        .in('request_type', ['day_off', 'unavailable', 'paid_leave_full', 'paid_leave_half'])
        .order('work_date', { ascending: true }),
      adminClient
        .from('gw_shift_cell_styles')
        .select('period_id, work_date, cell_key, background_color')
        .in('period_id', periodIds)
        .order('work_date', { ascending: true }),
      adminClient
        .from('gw_holidays')
        .select('holiday_date, name, holiday_type')
        .gte('holiday_date', periodRows.reduce((earliest, period) => period.start_date < earliest ? period.start_date : earliest, periodRows[0].start_date))
        .lte('holiday_date', periodRows.reduce((latest, period) => period.end_date > latest ? period.end_date : latest, periodRows[0].end_date))
        .order('holiday_date', { ascending: true }),
      adminClient
        .from('gw_shift_ec_sales')
        .select('id, label'),
    ])
    if (assignmentsError || requirementsError || requestsError || cellStylesError || holidaysError || salesError) {
      throw assignmentsError || requirementsError || requestsError || cellStylesError || holidaysError || salesError
    }

    const employeeIds = [...new Set((assignmentRows || []).map((row) => row.employee_id).filter(Boolean))]
    const userIds = [...new Set((assignmentRows || []).map((row) => row.user_id).filter(Boolean))]
    const [{ data: employeesById, error: employeesByIdError }, { data: employeesByUser, error: employeesByUserError }] = await Promise.all([
      employeeIds.length
        ? adminClient
          .from('gw_payroll_employees')
          .select('id, user_id, employee_code, display_name, real_name, hire_date, department, work_style, raw_payload')
          .in('id', employeeIds)
        : Promise.resolve({ data: [], error: null }),
      userIds.length
        ? adminClient
          .from('gw_payroll_employees')
          .select('id, user_id, employee_code, display_name, real_name, hire_date, department, work_style, raw_payload')
          .in('user_id', userIds)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (employeesByIdError || employeesByUserError) throw employeesByIdError || employeesByUserError

    const allEmployees = new Map<string, EmployeeRow>()
    for (const row of [...(employeesById || []), ...(employeesByUser || [])] as EmployeeRow[]) allEmployees.set(row.id, row)
    const employeeById = new Map([...allEmployees.values()].map((employee) => [employee.id, employee]))
    const employeeByUser = new Map(
      [...allEmployees.values()]
        .filter((employee) => employee.user_id)
        .map((employee) => [employee.user_id!, employee]),
    )
    const periodById = new Map(periodRows.map((period) => [period.id, period]))
    const sortIndexByDepartment = new Map<UserDepartment, Map<string, number>>()
    for (const department of USER_DEPARTMENTS) {
      const ordered = [...allEmployees.values()]
        .filter((employee) => normalizedDepartment(employee.department) === department)
        .sort(employeeComparator(department))
      sortIndexByDepartment.set(department, new Map(ordered.flatMap((employee, index) => [
        [employee.id, index],
        ...(employee.user_id ? [[employee.user_id, index] as [string, number]] : []),
      ])))
    }

    const salesById = new Map((saleRows || []).map((sale) => [sale.id, sale.label]))
    const assignments = (assignmentRows || []).map((assignment) => {
      const employee = (assignment.employee_id ? employeeById.get(assignment.employee_id) : undefined)
        || (assignment.user_id ? employeeByUser.get(assignment.user_id) : undefined)
      const period = periodById.get(assignment.period_id)
      const department = normalizedDepartment(period?.department) || 'フロア'
      const sortMap = sortIndexByDepartment.get(department)
      return {
        ...assignment,
        user_id: assignment.user_id || employee?.user_id || null,
        employee_name: employeeName(employee, assignment.assignment_type === 'timee' ? 'Timee' : null),
        employee_code: employee?.employee_code || null,
        sort_order: sortMap?.get(employee?.id || assignment.employee_id || '')
          ?? sortMap?.get(employee?.user_id || assignment.user_id || '')
          ?? 9999,
      }
    })

    const requirements = (requirementRows || []).map((requirement) => ({
      ...requirement,
      ec_sale_labels: (requirement.ec_sale_tags || [])
        .map((id: string) => salesById.get(id))
        .filter(Boolean),
    }))

    return NextResponse.json({
      today,
      userId: user.id,
      homeDepartment,
      periods: periodRows,
      assignments,
      requirements,
      requests: requestRows || [],
      cellStyles: cellStyleRows || [],
      holidays: holidayRows || [],
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : '確定シフトを取得できませんでした',
    }, { status: 500 })
  }
}
