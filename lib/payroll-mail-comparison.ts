import {
  analyzePunchConsistency, calculatePayroll, hasCompleteAttendancePair,
  summarizeAttendance, summarizePaidLeavePayments,
  type AttendanceCalculationPolicy, type PaidLeavePaymentLike,
  type PayrollProfile, type PunchLike,
} from '@/lib/payroll-calculation'
import type { ParsedPayrollResult } from '@/lib/labor-payroll-zip'

export type MailComparisonProfile = PayrollProfile & {
  id: string
  employee_id: string
  effective_from: string
  effective_to?: string | null
}
export type MailComparisonRow = {
  employeeId: string
  status: 'matched' | 'mismatch' | 'unverified'
  reason: string | null
  profileId: string | null
  paymentDelta: number | null
  netDelta: number | null
  deductionDelta: number | null
  attendanceDifference?: boolean
}

// A current-period labor-derived profile would compare the ZIP to itself.
export function selectIndependentProfile(profiles: MailComparisonProfile[], employeeId: string, payrollMonth: string) {
  return profiles.filter(profile => {
    if (profile.employee_id !== employeeId || profile.effective_from > payrollMonth) return false
    if (profile.effective_to && profile.effective_to < payrollMonth) return false
    const source = profile.source_snapshot || {}
    const laborDerived = typeof source.source === 'string' && /labor|payroll_zip/.test(source.source)
    const sourceMonth = typeof source.payroll_month === 'string' ? source.payroll_month.slice(0, 7) : ''
    return !(laborDerived && ((sourceMonth && sourceMonth >= payrollMonth.slice(0, 7)) || profile.effective_from.slice(0, 7) === payrollMonth.slice(0, 7)))
  }).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] || null
}

export function comparePayrollMailEmployee(input: {
  employeeId: string
  labor: ParsedPayrollResult
  profile: MailComparisonProfile | null
  punches: PunchLike[]
  paidLeave: PaidLeavePaymentLike[]
  policy: AttendanceCalculationPolicy
}): MailComparisonRow {
  const { employeeId, labor, profile, punches, policy } = input
  const unavailable = (reason: string): MailComparisonRow => ({
    employeeId, status: 'unverified', reason, profileId: profile?.id || null,
    paymentDelta: null, netDelta: null, deductionDelta: null,
  })
  if (!profile || profile.calculation_type === 'unknown') return unavailable('calculation_settings_missing')
  if (!Object.keys(profile.deduction_snapshot || {}).length && !Object.prototype.hasOwnProperty.call(profile.source_snapshot || {},'deduction_total')) {
    return unavailable('deduction_settings_missing')
  }
  if (profile.calculation_type === 'hourly' && !(Number(profile.hourly_rate) > 0)) return unavailable('hourly_rate_missing')
  if (profile.calculation_type !== 'hourly' && (profile.monthly_base_amount == null || !(Number(profile.monthly_base_amount) >= 0))) return unavailable('monthly_base_missing')
  if (analyzePunchConsistency(punches).incompleteDates.length) return unavailable('attendance_incomplete')
  const leave = summarizePaidLeavePayments(input.paidLeave, punches)
  if (leave.conflicts.length) return unavailable('paid_leave_conflict')
  if (input.paidLeave.some(row => row.raw_payload?.opening_balance_adjustment !== true &&
    (row.payable_minutes_snapshot == null || (profile.calculation_type === 'hourly' && row.paid_wage_amount == null)))) {
    return unavailable('paid_leave_wage_missing')
  }
  if (profile.calculation_type !== 'officer_fixed' && !hasCompleteAttendancePair(punches)) return unavailable('attendance_missing')
  if (profile.calculation_type === 'monthly_with_overtime' && !(Number(profile.overtime_divisor) > 0)
    && !(Number(profile.source_snapshot?.weekday_saturday_overtime_hourly_rate) > 0)) return unavailable('overtime_settings_missing')
  const attendance = summarizeAttendance(punches, profile, policy)
  const calculated = calculatePayroll(profile, attendance, leave.summary)
  const values = [calculated.paymentTotal, calculated.netPayment, calculated.deductionTotal, labor.paymentTotal, labor.netPayment, labor.deductionTotal]
  if (values.some(value => !Number.isFinite(value))) return unavailable('invalid_calculation')
  const paymentDelta = calculated.paymentTotal - labor.paymentTotal
  const netDelta = calculated.netPayment - labor.netPayment
  const deductionDelta = calculated.deductionTotal - labor.deductionTotal
  const laborDays=labor.items.find(item=>item.code==='attendance_days')?.days
  const laborMinutes=labor.items.find(item=>item.code==='work_minutes')?.minutes
  const attendanceDifference=(laborDays!=null&&laborDays!==attendance.workDays)||(laborMinutes!=null&&laborMinutes!==attendance.workMinutes)
  return {
    employeeId, profileId: profile.id,
    status: attendanceDifference || [paymentDelta, netDelta, deductionDelta].some(value => Math.abs(value) >= 1) ? 'mismatch' : 'matched',
    reason: attendanceDifference?'attendance_difference':null, paymentDelta, netDelta, deductionDelta,attendanceDifference,
  }
}

export function payrollMailComparisonCounts(rows: MailComparisonRow[]) {
  return {
    employees: rows.length,
    compared: rows.filter(row => row.status !== 'unverified').length,
    mismatches: rows.filter(row => row.status === 'mismatch').length,
    unverified: rows.filter(row => row.status === 'unverified').length,
  }
}
