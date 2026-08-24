import { NextRequest, NextResponse } from 'next/server'
import { getManagementPermissions } from '@/lib/management-permissions'
import { getUserSession } from '@/lib/session'
import { loadAttendanceCalculationPolicy } from '@/lib/payroll-attendance-policy-data'
import { adminClient } from '@/lib/supabase/admin'
import { isEmployeePayrollEligibleForRange } from '@/lib/workforce-employment'
import {
  analyzePunchConsistency,
  calculatePayroll,
  summarizeAttendance,
  summarizePaidLeavePayments,
  type PaidLeavePaymentLike,
  type PayrollProfile,
  type PunchLike,
} from '@/lib/payroll-calculation'

type EmployeeRow = {
  id: string
  employee_code: string | null
  display_name: string
  real_name: string | null
  department: string | null
  work_style: string | null
  payroll_status: string
  hire_date: string | null
  resigned_date: string | null
}

type ProfileRow = PayrollProfile & {
  id: string
  employee_id: string
  effective_from: string
  effective_to: string | null
  public_holidays_per_month: number | string | null
  paid_leave_mode: string | null
  source_snapshot: Record<string, unknown> | null
  verification: Record<string, unknown> | null
  source_note: string | null
}

type PunchRow = PunchLike & {
  employee_id: string | null
}

type PaidLeaveRow = PaidLeavePaymentLike & {
  employee_id: string
}

function jstMonthStart(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  return `${year}-${month}-01`
}

function jstDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function normalizeMonth(value: string | null) {
  if (!value) return jstMonthStart()
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.slice(0, 8) + '01'
  return jstMonthStart()
}

function monthEnd(monthStart: string) {
  const [year, month] = monthStart.split('-').map(Number)
  const last = new Date(Date.UTC(year, month, 0))
  return last.toISOString().slice(0, 10)
}

function amount(value: unknown) {
  const next = typeof value === 'number' ? value : Number(value || 0)
  return Number.isFinite(next) ? next : 0
}

function profileApplies(profile: ProfileRow, monthStart: string, monthEndDate: string) {
  return profile.effective_from <= monthEndDate && (!profile.effective_to || profile.effective_to >= monthStart)
}

export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const permissions = getManagementPermissions(user)
  if (!permissions.canViewPayroll) {
    return NextResponse.json({ error: '給与計算の閲覧権限が必要です' }, { status: 403 })
  }

  const attendanceMonth = normalizeMonth(request.nextUrl.searchParams.get('month'))
  const attendanceMonthEnd = monthEnd(attendanceMonth)
  const today = jstDate()

  const [
    { data: employees, error: employeesError },
    { data: profiles, error: profilesError },
    { data: punches, error: punchesError },
    { data: paidLeaveRows, error: paidLeaveError },
    attendancePolicy,
  ] = await Promise.all([
    adminClient
      .from('gw_payroll_employees')
      .select('id, employee_code, display_name, real_name, department, work_style, payroll_status, hire_date, resigned_date')
      .order('employee_code', { ascending: true, nullsFirst: false }),
    adminClient
      .from('gw_payroll_calculation_profiles')
      .select('id, employee_id, effective_from, effective_to, calculation_type, monthly_base_amount, hourly_rate, overtime_divisor, weekday_saturday_overtime_multiplier, sunday_overtime_multiplier, scheduled_minutes, public_holidays_per_month, paid_leave_mode, taxable_additions, deduction_snapshot, source_snapshot, verification, source_note')
      .order('effective_from', { ascending: false }),
    adminClient
      .from('gw_attendance_punches')
      .select('employee_id, punch_type, work_date, punched_at, break_override_minutes')
      .eq('is_voided', false)
      .gte('work_date', attendanceMonth)
      .lte('work_date', attendanceMonthEnd)
      .not('employee_id', 'is', null),
    adminClient
      .from('gw_paid_leave_requests')
      .select('employee_id, leave_date, leave_unit, requested_days, payable_minutes_snapshot, paid_wage_amount, raw_payload')
      .in('request_status', ['approved', 'consumed'])
      .gte('leave_date', attendanceMonth)
      .lte('leave_date', attendanceMonthEnd),
    loadAttendanceCalculationPolicy(attendanceMonthEnd),
  ])

  const dbError = employeesError || profilesError || punchesError || paidLeaveError
  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  const employeeMap = new Map(((employees || []) as EmployeeRow[]).map((employee) => [employee.id, employee]))
  const punchesByEmployee = new Map<string, PunchLike[]>()
  for (const punch of (punches || []) as PunchRow[]) {
    if (!punch.employee_id) continue
    const rows = punchesByEmployee.get(punch.employee_id) || []
    rows.push(punch)
    punchesByEmployee.set(punch.employee_id, rows)
  }
  const paidLeaveRowsByEmployee = new Map<string, PaidLeaveRow[]>()
  for (const row of (paidLeaveRows || []) as PaidLeaveRow[]) {
    const rows = paidLeaveRowsByEmployee.get(row.employee_id) || []
    rows.push(row)
    paidLeaveRowsByEmployee.set(row.employee_id, rows)
  }

  const latestProfiles = new Map<string, ProfileRow>()
  for (const profile of (profiles || []) as ProfileRow[]) {
    if (!profileApplies(profile, attendanceMonth, attendanceMonthEnd)) continue
    if (!latestProfiles.has(profile.employee_id)) {
      latestProfiles.set(profile.employee_id, profile)
    }
  }

  const rows = Array.from(latestProfiles.values())
    .map((profile) => {
      const employee = employeeMap.get(profile.employee_id)
      if (!employee || !isEmployeePayrollEligibleForRange(employee, attendanceMonth, attendanceMonthEnd)) return null
      const employeePunches = punchesByEmployee.get(profile.employee_id) || []
      const attendance = summarizeAttendance(employeePunches, profile, attendancePolicy)
      const paidLeave = summarizePaidLeavePayments(
        paidLeaveRowsByEmployee.get(profile.employee_id) || [],
        employeePunches,
      )
      const punchConsistency = analyzePunchConsistency(employeePunches)
      const calculation = calculatePayroll(
        profile,
        attendance,
        paidLeave.summary,
      )
      return {
        profileId: profile.id,
        employeeId: profile.employee_id,
        employeeCode: employee?.employee_code || null,
        employeeName: employee?.real_name || employee?.display_name || '未設定',
        department: employee?.department || null,
        workStyle: employee?.work_style || null,
        payrollStatus: employee?.payroll_status || 'unknown',
        effectiveFrom: profile.effective_from,
        effectiveTo: profile.effective_to,
        calculationType: profile.calculation_type,
        monthlyBaseAmount: amount(profile.monthly_base_amount),
        hourlyRate: amount(profile.hourly_rate),
        overtimeDivisor: amount(profile.overtime_divisor),
        scheduledMinutes: amount(profile.scheduled_minutes),
        publicHolidaysPerMonth: amount(profile.public_holidays_per_month),
        paidLeaveMode: profile.paid_leave_mode,
        verification: profile.verification || {},
        sourceSnapshot: profile.source_snapshot || {},
        consistencyWarnings: [
          ...paidLeave.conflicts.map((conflict) => (
            `${conflict.leaveDate}: 有給（全休）と実打刻が重複しています。有給取消または打刻修正が必要です`
          )),
          ...punchConsistency.incompleteDates.filter((workDate) => workDate < today).map((workDate) => (
            `${workDate}: 出勤・退勤が対になっていない打刻があります。未完了分は給与試算から除外しています`
          )),
          ...punchConsistency.multipleSessionDates.map((workDate) => (
            `${workDate}: 複数勤務区間を合算して給与試算しています`
          )),
        ],
        calculation,
      }
    })
    .filter((row): row is NonNullable<typeof row> => !!row)
    .sort((a, b) => {
      const aCode = Number(a.employeeCode || 999999)
      const bCode = Number(b.employeeCode || 999999)
      return aCode - bCode || a.employeeName.localeCompare(b.employeeName, 'ja')
    })

  return NextResponse.json({
    attendanceMonth,
    attendanceMonthEnd,
    summary: {
      profiles: rows.length,
      calculatedEmployees: rows.filter((row) => row.calculation.attendance.workDays > 0).length,
      taxablePaymentTotal: rows.reduce((sum, row) => sum + row.calculation.taxablePaymentTotal, 0),
      paymentTotal: rows.reduce((sum, row) => sum + row.calculation.paymentTotal, 0),
      deductionTotal: rows.reduce((sum, row) => sum + row.calculation.deductionTotal, 0),
      netPayment: rows.reduce((sum, row) => sum + row.calculation.netPayment, 0),
    },
    profiles: rows,
  })
}
