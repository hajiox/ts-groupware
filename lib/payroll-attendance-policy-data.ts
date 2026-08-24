import {
  DEFAULT_ATTENDANCE_CALCULATION_POLICY,
  type AttendanceBreakRule,
  type AttendanceCalculationPolicy,
  type AttendanceRoundingMethod,
} from '@/lib/payroll-calculation'
import { adminClient } from '@/lib/supabase/admin'

type RoundingRuleRow = {
  rounding_unit_minutes: number | string
  clock_in_method: AttendanceRoundingMethod
  clock_out_method: AttendanceRoundingMethod
  total_minutes_method: AttendanceRoundingMethod
}

type BreakRuleRow = {
  min_work_minutes_exclusive: number | string
  max_work_minutes_inclusive: number | string | null
  break_minutes: number | string
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export async function loadAttendanceCalculationPolicy(
  effectiveDate: string,
  ruleSet = 'default',
): Promise<AttendanceCalculationPolicy> {
  const [roundingResult, breakResult] = await Promise.all([
    adminClient
      .from('gw_attendance_rounding_rules')
      .select('rounding_unit_minutes, clock_in_method, clock_out_method, total_minutes_method')
      .eq('rule_set', ruleSet)
      .lte('effective_from', effectiveDate)
      .or(`effective_to.is.null,effective_to.gte.${effectiveDate}`)
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle(),
    adminClient
      .from('gw_break_rules')
      .select('min_work_minutes_exclusive, max_work_minutes_inclusive, break_minutes')
      .eq('rule_set', ruleSet)
      .lte('effective_from', effectiveDate)
      .or(`effective_to.is.null,effective_to.gte.${effectiveDate}`)
      .order('sort_order', { ascending: true }),
  ])

  if (roundingResult.error || breakResult.error) {
    throw roundingResult.error || breakResult.error
  }

  const rounding = roundingResult.data as RoundingRuleRow | null
  const breakRules = ((breakResult.data || []) as BreakRuleRow[]).map<AttendanceBreakRule>((row) => ({
    minWorkMinutesExclusive: numberValue(row.min_work_minutes_exclusive, -1),
    maxWorkMinutesInclusive: row.max_work_minutes_inclusive === null
      ? null
      : numberValue(row.max_work_minutes_inclusive),
    breakMinutes: Math.max(0, numberValue(row.break_minutes)),
  }))

  return {
    roundingUnitMinutes: Math.max(
      1,
      numberValue(
        rounding?.rounding_unit_minutes,
        DEFAULT_ATTENDANCE_CALCULATION_POLICY.roundingUnitMinutes,
      ),
    ),
    clockInMethod: rounding?.clock_in_method || DEFAULT_ATTENDANCE_CALCULATION_POLICY.clockInMethod,
    clockOutMethod: rounding?.clock_out_method || DEFAULT_ATTENDANCE_CALCULATION_POLICY.clockOutMethod,
    totalMinutesMethod: rounding?.total_minutes_method || DEFAULT_ATTENDANCE_CALCULATION_POLICY.totalMinutesMethod,
    breakRules: breakRules.length
      ? breakRules
      : DEFAULT_ATTENDANCE_CALCULATION_POLICY.breakRules,
  }
}
