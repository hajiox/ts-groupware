export type PayrollCalculationType =
  | 'hourly'
  | 'monthly_fixed'
  | 'monthly_with_overtime'
  | 'officer_fixed'
  | 'unknown'

export type PayrollProfile = {
  calculation_type: PayrollCalculationType
  monthly_base_amount?: number | string | null
  hourly_rate?: number | string | null
  overtime_divisor?: number | string | null
  weekday_saturday_overtime_multiplier?: number | string | null
  sunday_overtime_multiplier?: number | string | null
  scheduled_minutes?: number | string | null
  taxable_additions?: Record<string, unknown> | null
  deduction_snapshot?: Record<string, unknown> | null
  source_snapshot?: Record<string, unknown> | null
}

export type PunchLike = {
  punch_type: 'clock_in' | 'clock_out'
  punched_at: string
  work_date: string
  break_override_minutes?: number | string | null
}

export type AttendanceDailySummary = {
  workDate: string
  clockInAt: string | null
  clockOutAt: string | null
  grossMinutes: number
  breakMinutes: number
  netWorkMinutes: number
  weekdaySaturdayOvertimeMinutes: number
  sundayOvertimeMinutes: number
}

export type AttendanceSummary = {
  workDays: number
  workMinutes: number
  weekdaySaturdayOvertimeMinutes: number
  sundayOvertimeMinutes: number
  daily: AttendanceDailySummary[]
}

export type PaidLeavePaymentSummary = {
  days: number
  minutes: number
  amount: number
}

export type PaidLeavePaymentLike = {
  leave_date: string
  leave_unit: 'full_day' | 'half_day' | 'half_day_am' | 'half_day_pm'
  requested_days: number | string
  payable_minutes_snapshot: number | string | null
  paid_wage_amount: number | string | null
  raw_payload?: Record<string, unknown> | null
}

export type PaidLeavePaymentCalculation = {
  summary: PaidLeavePaymentSummary
  conflicts: Array<{
    leaveDate: string
    reason: 'full_day_with_physical_punch'
  }>
}

export type PunchConsistency = {
  incompleteDates: string[]
  multipleSessionDates: string[]
}

export type AttendanceRoundingMethod = 'none' | 'floor' | 'ceil' | 'nearest'

export type AttendanceBreakRule = {
  minWorkMinutesExclusive: number
  maxWorkMinutesInclusive: number | null
  breakMinutes: number
}

export type AttendanceCalculationPolicy = {
  roundingUnitMinutes: number
  clockInMethod: AttendanceRoundingMethod
  clockOutMethod: AttendanceRoundingMethod
  totalMinutesMethod: AttendanceRoundingMethod
  breakRules: AttendanceBreakRule[]
}

export type PayrollCalculationResult = {
  taxablePaymentTotal: number
  nonTaxablePaymentTotal: number
  paymentTotal: number
  deductionTotal: number
  netPayment: number
  baseAmount: number
  overtimeAmount: number
  paidLeaveDays: number
  paidLeaveMinutes: number
  paidLeaveAmount: number
  taxableAdditions: number
  deductionSnapshot: Record<string, number>
  attendance: AttendanceSummary
}

function numberValue(value: unknown): number {
  const next = typeof value === 'number' ? value : Number(value || 0)
  return Number.isFinite(next) ? next : 0
}

function yen(value: number): number {
  return Math.round(value)
}

export const DEFAULT_ATTENDANCE_CALCULATION_POLICY: AttendanceCalculationPolicy = {
  roundingUnitMinutes: 15,
  clockInMethod: 'nearest',
  clockOutMethod: 'nearest',
  totalMinutesMethod: 'nearest',
  breakRules: [
    { minWorkMinutesExclusive: -1, maxWorkMinutesInclusive: 300, breakMinutes: 0 },
    { minWorkMinutesExclusive: 300, maxWorkMinutesInclusive: 360, breakMinutes: 30 },
    { minWorkMinutesExclusive: 360, maxWorkMinutesInclusive: 480, breakMinutes: 45 },
    { minWorkMinutesExclusive: 480, maxWorkMinutesInclusive: null, breakMinutes: 60 },
  ],
}

function roundValue(value: number, unit: number, method: AttendanceRoundingMethod) {
  if (!Number.isFinite(value) || method === 'none' || unit <= 0) return value
  const scaled = value / unit
  if (method === 'floor') return Math.floor(scaled) * unit
  if (method === 'ceil') return Math.ceil(scaled) * unit
  return Math.round(scaled) * unit
}

function jstWeekday(dateText: string): number {
  const [year, month, day] = dateText.split('-').map(Number)
  if (![year, month, day].every(Number.isFinite)) return -1
  return new Date(Date.UTC(year, month - 1, day, 15, 0, 0)).getUTCDay()
}

function roundedSessionMinutes(
  startIso: string,
  endIso: string,
  policy: AttendanceCalculationPolicy,
): number {
  const start = new Date(startIso).getTime() / 60000
  const end = new Date(endIso).getTime() / 60000
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  const roundedStart = roundValue(start, policy.roundingUnitMinutes, policy.clockInMethod)
  const roundedEnd = roundValue(end, policy.roundingUnitMinutes, policy.clockOutMethod)
  return Math.max(0, Math.round(roundedEnd - roundedStart))
}

function defaultBreakMinutes(grossMinutes: number, policy: AttendanceCalculationPolicy): number {
  const rule = [...policy.breakRules]
    .sort((a, b) => a.minWorkMinutesExclusive - b.minWorkMinutesExclusive)
    .find((candidate) => (
      grossMinutes > candidate.minWorkMinutesExclusive
      && (candidate.maxWorkMinutesInclusive === null || grossMinutes <= candidate.maxWorkMinutesInclusive)
    ))
  return Math.max(0, Math.round(rule?.breakMinutes || 0))
}

function taxableAdditionTotal(profile: PayrollProfile): number {
  return Object.values(profile.taxable_additions || {}).reduce<number>(
    (sum, value) => sum + numberValue(value),
    0,
  )
}

function deductionSnapshot(profile: PayrollProfile): Record<string, number> {
  const deductions = Object.fromEntries(
    Object.entries(profile.deduction_snapshot || {}).map(([key, value]) => [key, numberValue(value)]),
  )

  // Older ledgers expose subtotal columns alongside their components. Keep the
  // subtotal as the authoritative value so taxes and insurance are not counted twice.
  const otherDeductionTotal = numberValue(deductions.other_deduction_total)
  if (otherDeductionTotal !== 0) {
    for (const key of [
      'income_tax',
      'resident_tax',
      'other_deduction',
      'company_housing_rent',
      'year_end_adjustment',
    ]) {
      delete deductions[key]
    }
  }

  const socialInsuranceTotal = numberValue(deductions.social_insurance_total)
  if (socialInsuranceTotal !== 0) {
    for (const key of [
      'health_insurance',
      'care_insurance',
      'child_childcare_contribution',
      'welfare_pension',
      'employment_insurance',
      'insurance_adjustment',
    ]) {
      delete deductions[key]
    }
  }

  return deductions
}

function scaledCommuteAmount(profile: PayrollProfile, attendance: AttendanceSummary) {
  const source = profile.source_snapshot || {}
  const sourceAmount = numberValue(source.non_taxable_payment_total ?? source.non_taxable_commute)
  const sourceWorkDays = numberValue(source.work_days)
  if (!sourceAmount) return 0
  if (sourceWorkDays > 0 && attendance.workDays > 0) {
    return yen((sourceAmount / sourceWorkDays) * attendance.workDays)
  }
  return attendance.workDays > 0 ? yen(sourceAmount) : 0
}

function calculatedDeductions(
  profile: PayrollProfile,
  paymentTotal: number,
) {
  const deductions = deductionSnapshot(profile)
  const source = profile.source_snapshot || {}
  const hasSourceDeductionTotal = Object.prototype.hasOwnProperty.call(source, 'deduction_total')
  const sourceDeductionTotal = numberValue(source.deduction_total)
  const sourceEmploymentInsurance = numberValue(source.employment_insurance)
  const sourcePaymentTotal = numberValue(source.payment_total)
  if (
    hasSourceDeductionTotal
    && sourceDeductionTotal >= 0
    && sourcePaymentTotal > 0
    && Math.abs(paymentTotal - sourcePaymentTotal) < 1
  ) {
    return { confirmed_deduction_total: sourceDeductionTotal }
  }
  if (sourceEmploymentInsurance > 0 && sourcePaymentTotal > 0 && paymentTotal > 0) {
    deductions.employment_insurance = yen(paymentTotal * (sourceEmploymentInsurance / sourcePaymentTotal))
  }
  return deductions
}

function completePunchPairs(rows: PunchLike[]) {
  const sorted = [...rows].sort((a, b) => a.punched_at.localeCompare(b.punched_at))
  const pairs: Array<{ clockIn: PunchLike; clockOut: PunchLike }> = []
  let pendingClockIn: PunchLike | null = null

  for (const row of sorted) {
    if (row.punch_type === 'clock_in') {
      if (!pendingClockIn) pendingClockIn = row
      continue
    }
    if (!pendingClockIn) continue
    pairs.push({ clockIn: pendingClockIn, clockOut: row })
    pendingClockIn = null
  }

  return pairs
}

export function hasCompleteAttendancePair(punches: PunchLike[]) {
  const byDate = new Map<string, PunchLike[]>()
  for (const punch of punches) {
    const rows = byDate.get(punch.work_date) || []
    rows.push(punch)
    byDate.set(punch.work_date, rows)
  }
  return [...byDate.values()].some((rows) => completePunchPairs(rows).length > 0)
}

export function analyzePunchConsistency(punches: PunchLike[]): PunchConsistency {
  const byDate = new Map<string, PunchLike[]>()
  for (const punch of punches) {
    const rows = byDate.get(punch.work_date) || []
    rows.push(punch)
    byDate.set(punch.work_date, rows)
  }

  const incompleteDates: string[] = []
  const multipleSessionDates: string[] = []
  for (const [workDate, rows] of byDate) {
    const pairs = completePunchPairs(rows)
    if (pairs.length * 2 !== rows.length) incompleteDates.push(workDate)
    if (pairs.length > 1) multipleSessionDates.push(workDate)
  }
  return {
    incompleteDates: incompleteDates.sort(),
    multipleSessionDates: multipleSessionDates.sort(),
  }
}

export function summarizePaidLeavePayments(
  rows: PaidLeavePaymentLike[],
  punches: PunchLike[],
): PaidLeavePaymentCalculation {
  const punchedDates = new Set(punches.map((punch) => punch.work_date))
  const summary = { days: 0, minutes: 0, amount: 0 }
  const conflicts: PaidLeavePaymentCalculation['conflicts'] = []

  for (const row of rows) {
    if (row.raw_payload?.opening_balance_adjustment === true) continue
    if (row.leave_unit === 'full_day' && punchedDates.has(row.leave_date)) {
      conflicts.push({
        leaveDate: row.leave_date,
        reason: 'full_day_with_physical_punch',
      })
      continue
    }
    summary.days += numberValue(row.requested_days)
    summary.minutes += numberValue(row.payable_minutes_snapshot)
    summary.amount += numberValue(row.paid_wage_amount)
  }

  return { summary, conflicts }
}

export function summarizeAttendance(
  punches: PunchLike[],
  profile: PayrollProfile,
  policy: AttendanceCalculationPolicy = DEFAULT_ATTENDANCE_CALCULATION_POLICY,
): AttendanceSummary {
  const byDate = new Map<string, PunchLike[]>()
  for (const punch of punches) {
    const bucket = byDate.get(punch.work_date) || []
    bucket.push(punch)
    byDate.set(punch.work_date, bucket)
  }

  const scheduledMinutes = numberValue(profile.scheduled_minutes)
  const isMonthly = profile.calculation_type === 'monthly_fixed' || profile.calculation_type === 'monthly_with_overtime' || profile.calculation_type === 'officer_fixed'
  const daily: AttendanceDailySummary[] = []

  for (const [workDate, rows] of Array.from(byDate.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const pairs = completePunchPairs(rows)
    const clockIn = pairs[0]?.clockIn || null
    const clockOut = pairs.at(-1)?.clockOut || null
    const roundedSessionTotal = pairs.reduce((sum, pair) => (
      sum + roundedSessionMinutes(pair.clockIn.punched_at, pair.clockOut.punched_at, policy)
    ), 0)
    const grossMinutes = Math.max(
      0,
      Math.round(
        roundValue(
          roundedSessionTotal,
          policy.roundingUnitMinutes,
          policy.totalMinutesMethod,
        ),
      ),
    )
    const overrideBreak = clockOut?.break_override_minutes ?? clockIn?.break_override_minutes
    const breakMinutes = overrideBreak !== null && overrideBreak !== undefined && overrideBreak !== ''
      ? numberValue(overrideBreak)
      : defaultBreakMinutes(grossMinutes, policy)
    const netWorkMinutes = Math.max(0, grossMinutes - breakMinutes)
    const isSunday = jstWeekday(workDate) === 0
    const weekdaySaturdayOvertimeMinutes = isSunday
      ? 0
      : isMonthly
        ? Math.max(0, netWorkMinutes - scheduledMinutes)
        : 0
    const sundayOvertimeMinutes = isSunday && isMonthly ? netWorkMinutes : 0

    daily.push({
      workDate,
      clockInAt: clockIn?.punched_at || null,
      clockOutAt: clockOut?.punched_at || null,
      grossMinutes,
      breakMinutes,
      netWorkMinutes,
      weekdaySaturdayOvertimeMinutes,
      sundayOvertimeMinutes,
    })
  }

  return {
    workDays: daily.filter((row) => row.netWorkMinutes > 0).length,
    workMinutes: daily.reduce((sum, row) => sum + row.netWorkMinutes, 0),
    weekdaySaturdayOvertimeMinutes: daily.reduce((sum, row) => sum + row.weekdaySaturdayOvertimeMinutes, 0),
    sundayOvertimeMinutes: daily.reduce((sum, row) => sum + row.sundayOvertimeMinutes, 0),
    daily,
  }
}

export function calculatePayroll(
  profile: PayrollProfile,
  attendance: AttendanceSummary,
  paidLeave: PaidLeavePaymentSummary = { days: 0, minutes: 0, amount: 0 },
): PayrollCalculationResult {
  const monthlyBase = numberValue(profile.monthly_base_amount)
  const hourlyRate = numberValue(profile.hourly_rate)
  const divisor = numberValue(profile.overtime_divisor)
  const weekdayMultiplier = numberValue(profile.weekday_saturday_overtime_multiplier) || 1.25
  const sundayMultiplier = numberValue(profile.sunday_overtime_multiplier) || 1.35
  const taxableAdditions = taxableAdditionTotal(profile)

  let baseAmount = 0
  let overtimeAmount = 0
  const paidLeaveAmount = profile.calculation_type === 'hourly'
    ? yen(numberValue(paidLeave.amount))
    : 0

  if (profile.calculation_type === 'hourly') {
    const source = profile.source_snapshot || {}
    const sourceBaseAmount = numberValue(source.base_payment_amount ?? source.base_salary)
    const sourceWorkMinutes = numberValue(source.work_minutes)
    const effectiveHourlyRate = sourceBaseAmount > 0 && sourceWorkMinutes > 0
      ? sourceBaseAmount / (sourceWorkMinutes / 60)
      : hourlyRate
    baseAmount = yen((attendance.workMinutes / 60) * effectiveHourlyRate) + paidLeaveAmount
  } else if (profile.calculation_type === 'monthly_with_overtime') {
    baseAmount = yen(monthlyBase)
    const source = profile.source_snapshot || {}
    const sourceWeekdayMinutes = numberValue(source.weekday_saturday_overtime_minutes)
    const sourceSundayMinutes = numberValue(source.sunday_overtime_minutes)
    const learnedWeekdayRate = numberValue(source.weekday_saturday_overtime_hourly_rate)
      || (sourceWeekdayMinutes > 0
        ? numberValue(source.weekday_saturday_overtime_amount) / (sourceWeekdayMinutes / 60)
        : 0)
    const learnedSundayRate = numberValue(source.sunday_overtime_hourly_rate)
      || (sourceSundayMinutes > 0
        ? numberValue(source.sunday_overtime_amount) / (sourceSundayMinutes / 60)
        : 0)
    if (learnedWeekdayRate > 0) {
      overtimeAmount += yen(learnedWeekdayRate * (attendance.weekdaySaturdayOvertimeMinutes / 60))
    } else if (divisor > 0) {
      overtimeAmount += yen((monthlyBase / divisor) * weekdayMultiplier * (attendance.weekdaySaturdayOvertimeMinutes / 60))
    }
    if (learnedSundayRate > 0) {
      overtimeAmount += yen(learnedSundayRate * (attendance.sundayOvertimeMinutes / 60))
    } else if (divisor > 0) {
      overtimeAmount += yen((monthlyBase / divisor) * sundayMultiplier * (attendance.sundayOvertimeMinutes / 60))
    }
  } else if (profile.calculation_type === 'monthly_fixed' || profile.calculation_type === 'officer_fixed') {
    baseAmount = yen(monthlyBase)
  }

  const taxablePaymentTotal = yen(baseAmount + overtimeAmount + taxableAdditions)
  const nonTaxablePaymentTotal = scaledCommuteAmount(profile, attendance)
  const paymentTotal = taxablePaymentTotal + nonTaxablePaymentTotal
  const deductions = calculatedDeductions(profile, paymentTotal)
  const deductionTotal = yen(Object.values(deductions).reduce((sum, value) => sum + value, 0))

  return {
    taxablePaymentTotal,
    nonTaxablePaymentTotal,
    paymentTotal,
    deductionTotal,
    netPayment: paymentTotal - deductionTotal,
    baseAmount,
    overtimeAmount,
    paidLeaveDays: numberValue(paidLeave.days),
    paidLeaveMinutes: numberValue(paidLeave.minutes),
    paidLeaveAmount,
    taxableAdditions,
    deductionSnapshot: deductions,
    attendance,
  }
}
