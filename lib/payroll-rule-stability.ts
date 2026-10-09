import type { PayrollLaborInput, PayrollProfile } from '@/lib/payroll-calculation'
import type { MailComparisonProfile } from '@/lib/payroll-mail-comparison'

export type PayrollStabilityRecord = {
  month: string
  employeeId: string
  profile: PayrollProfile | null
  labor: PayrollLaborInput
}
export type PayrollStabilityIssue = {
  employeeId: string
  component: string
  kind: 'rule_change' | 'rule_reversal' | 'settings_change' | 'formula_mismatch' | 'missing_input'
  months: string[]
  message: string
  fromRules?: string[]
  toRules?: string[]
}
type Status = 'matched' | 'mismatch' | 'ambiguous' | 'unverified'
export type PayrollStabilityObservation = {
  month: string
  employeeId: string
  component: string
  status: Status
  compatibleRules: string[]
  reason: string | null
  rateSource?: 'labor_declared' | 'stored' | 'prior_learned' | 'configured_divisor'
}
type Evidence = PayrollStabilityObservation & { context: string | null }
const learnedKeys = [
  'base_payment_amount', 'base_salary', 'payment_total', 'work_minutes',
  'weekday_saturday_overtime_amount', 'weekday_saturday_overtime_minutes',
  'weekday_saturday_overtime_hourly_rate', 'sunday_overtime_amount',
  'sunday_overtime_minutes', 'sunday_overtime_hourly_rate',
]
const rounders = { nearest: Math.round, floor: Math.floor, ceil: Math.ceil }
const finite = (value: unknown): number | null => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
const positive = (value: unknown) => { const number = finite(value); return number != null && number > 0 ? number : null }
const validMonth = (month: string) => /^\d{4}-(0[1-9]|1[0-2])-01$/.test(month)
const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1
const adjacent = (before: string, after: string) => validMonth(before) && validMonth(after) && monthIndex(after) - monthIndex(before) === 1

function learnedProfileIsIndependent(profile: PayrollProfile, month: string): boolean {
  const source = profile.source_snapshot || {}
  const effective = (profile as PayrollProfile & { effective_from?: string }).effective_from
  const sourceMonth = typeof source.payroll_month === 'string' ? source.payroll_month.slice(0, 7) : null
  const learned = learnedKeys.some(key => source[key] != null)
    || (typeof source.source === 'string' && /labor|payroll_zip/.test(source.source))
  if (!learned) return true
  if (sourceMonth && sourceMonth >= month.slice(0, 7)) return false
  if (effective && effective.slice(0, 7) >= month.slice(0, 7)) return false
  // A derived unit with no source date cannot prove independence from the target.
  return Boolean(sourceMonth || effective)
}

export function selectStabilityProfile(profiles: MailComparisonProfile[], employeeId: string, month: string): MailComparisonProfile | null {
  if (!validMonth(month)) return null
  return profiles.filter(profile => profile.employee_id === employeeId
    && profile.effective_from <= month
    && (!profile.effective_to || profile.effective_to >= month)
    && learnedProfileIsIndependent(profile, month))
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || a.id.localeCompare(b.id))[0] || null
}

function evidenceFor(record: PayrollStabilityRecord, duplicate: boolean): Evidence[] {
  const { month, employeeId, labor } = record
  const make = (component: string, reason: string): Evidence => ({ month, employeeId, component, status: 'unverified', compatibleRules: [], reason, context: null })
  if (!validMonth(month) || !employeeId || duplicate) return [make('input', duplicate ? 'duplicate_month' : 'invalid_input')]
  if (!Array.isArray(labor?.items)
    || [labor.paymentTotal, labor.netPayment, labor.deductionTotal, labor.nonTaxablePaymentTotal].some(value => finite(value) == null)
    || labor.items.some(item => finite(item.amount) == null || [item.minutes, item.days, item.rate].some(value => value != null && finite(value) == null))) return [make('input', 'invalid_input')]
  const items = labor.items
  const find = (codes: string[]) => items.find(item => codes.includes(item.code))
  const amount = (codes: string[]) => items.filter(item => codes.includes(item.code)).reduce((sum, item) => sum + item.amount, 0)
  const rawProfile = record.profile
  const profile = rawProfile && learnedProfileIsIndependent(rawProfile, month) ? rawProfile : null
  const excludedProfile = Boolean(rawProfile && !profile)
  const base = find(['base_salary'])
  const regular = find(['regular_salary'])
  const declaredHourly = positive(regular?.rate)
  const type = declaredHourly ? 'hourly' : profile?.calculation_type
  const evaluate = (component: string, target: number, minutes: number, rate: number, context: string, rateSource: PayrollStabilityObservation['rateSource'], unitRounding: boolean): Evidence => {
    if (minutes <= 0 || target < 0) return make(component, minutes <= 0 ? 'no_positive_time' : 'invalid_input')
    const candidates: Record<string, number> = {}
    for (const [name, rounding] of Object.entries(rounders)) {
      candidates[`amount_${name}`] = rounding(minutes * rate / 60)
      if (unitRounding) candidates[`unit_nearest_amount_${name}`] = rounding(minutes * Math.round(rate) / 60)
    }
    const compatibleRules = Object.entries(candidates).filter(([, value]) => value === target).map(([rule]) => rule)
    return { month, employeeId, component, compatibleRules, reason: compatibleRules.length ? null : 'no_candidate_matches',
      status: compatibleRules.length === 1 ? 'matched' : compatibleRules.length > 1 ? 'ambiguous' : 'mismatch', context, rateSource }
  }
  const result: Evidence[] = []
  if (type === 'hourly') {
    const minutes = finite(find(['work_minutes'])?.minutes)
    const rate = declaredHourly || positive(profile?.hourly_rate)
    if (!base || minutes == null || !rate) result.push(make('hourly_base', excludedProfile ? 'same_or_future_learned_profile' : 'missing_rate_or_time'))
    else result.push(evaluate('hourly_base', base.amount, minutes, rate, `hourly:${rate}`, declaredHourly ? 'labor_declared' : 'stored', false))
    return result
  }
  if (!profile || !type || type === 'unknown') return [make('base_salary', excludedProfile ? 'same_or_future_learned_profile' : 'missing_settings')]
  const monthly = finite(profile.monthly_base_amount)
  if (!base || monthly == null || monthly < 0) result.push(make('monthly_base', 'missing_settings'))
  else result.push({ month, employeeId, component: 'monthly_base', status: base.amount === Math.round(monthly) ? 'matched' : 'mismatch',
    compatibleRules: base.amount === Math.round(monthly) ? ['fixed_monthly'] : [], reason: base.amount === Math.round(monthly) ? null : 'pay_condition_difference',
    context: `${type}:${monthly}`, rateSource: 'stored' })
  if (type !== 'monthly_with_overtime') return result
  const overtime = (component: string, timeCodes: string[], earningCodes: string[], sourceKey: string, multiplierValue: unknown, defaultMultiplier: number) => {
    const time = find(timeCodes)
    const earning = items.filter(item => earningCodes.includes(item.code))
    if (!time && !earning.length) return
    const minutes = finite(time?.minutes)
    if (minutes == null || !earning.length) { result.push(make(component, 'missing_rate_or_time')); return }
    const declaredRates = [...new Set(earning.map(item => positive(item.rate)).filter((rate): rate is number => rate != null))]
    if (declaredRates.length > 1) { result.push(make(component, 'conflicting_declared_rates')); return }
    const known = positive(profile.source_snapshot?.[sourceKey])
    const divisor = positive(profile.overtime_divisor)
    const multiplier = positive(multiplierValue) || defaultMultiplier
    const rate = declaredRates[0] || known || (monthly != null && monthly > 0 && divisor ? monthly / divisor * multiplier : null)
    if (!rate) { result.push(make(component, 'missing_rate_or_time')); return }
    const rateSource = declaredRates[0] ? 'labor_declared' as const : known ? 'prior_learned' as const : 'configured_divisor' as const
    // Prior learned units contain the earlier amount's rounding noise. Keep the
    // same integer unit as one condition, but never claim an exact rule reversal
    // from changing fractional estimates alone.
    const condition = known && !declaredRates[0] ? `prior-unit:${Math.round(rate)}` : `unit:${rate}`
    const context = `${type}:${monthly}:${divisor || ''}:${multiplier}:${condition}`
    result.push(evaluate(component, amount(earningCodes), minutes, rate, context, rateSource, true))
  }
  overtime('weekday_overtime', ['weekday_saturday_overtime_minutes', 'regular_overtime_minutes'], ['weekday_saturday_overtime', 'regular_overtime', 'overtime_allowance'], 'weekday_saturday_overtime_hourly_rate', profile.weekday_saturday_overtime_multiplier, 1.25)
  overtime('sunday_overtime', ['sunday_overtime_minutes'], ['sunday_overtime', 'holiday_work_allowance'], 'sunday_overtime_hourly_rate', profile.sunday_overtime_multiplier, 1.35)
  return result
}

export function auditPayrollRuleStability(records: PayrollStabilityRecord[]) {
  const duplicateKeys = new Map<string, number>()
  for (const record of records) {
    const key = `${record.employeeId}:${record.month}`
    duplicateKeys.set(key, (duplicateKeys.get(key) || 0) + 1)
  }
  const evidence = records.flatMap(record => evidenceFor(record, (duplicateKeys.get(`${record.employeeId}:${record.month}`) || 0) > 1))
    .sort((a, b) => a.month.localeCompare(b.month) || a.employeeId.localeCompare(b.employeeId) || a.component.localeCompare(b.component))
  const issues: PayrollStabilityIssue[] = []
  const groups = new Map<string, Evidence[]>()
  for (const row of evidence) {
    const key = `${row.employeeId}:${row.component}`
    groups.set(key, [...(groups.get(key) || []), row])
    if (row.status === 'mismatch') issues.push({ employeeId: row.employeeId, component: row.component, kind: 'formula_mismatch', months: [row.month],
      message: row.reason === 'pay_condition_difference' ? '保存された給与条件と明細の固定給に差があります。丸め方式の変更とは判定しません。' : '既知の単価・時間による候補式では再現できません。給与条件または明細入力の確認が必要です。' })
    if (row.status === 'unverified') issues.push({ employeeId: row.employeeId, component: row.component, kind: 'missing_input', months: [row.month],
      message: '独立した設定・単価・正の勤務時間が不足するため、計算方式の継続性は未確認です。' })
  }
  const disjoint = (a: string[], b: string[]) => a.length > 0 && b.length > 0 && !a.some(rule => b.includes(rule))
  for (const rows of groups.values()) {
    for (let index = 1; index < rows.length; index++) {
      const before = rows[index - 1], now = rows[index]
      if (!adjacent(before.month, now.month) || !before.context || !now.context) continue
      if (before.context !== now.context) {
        issues.push({ employeeId: now.employeeId, component: now.component, kind: 'settings_change', months: [before.month, now.month], message: '時給・固定給・残業単価などの給与条件が変わっています。前後の丸め方式を同じ条件として比較しません。' })
        continue
      }
      if (disjoint(before.compatibleRules, now.compatibleRules)) issues.push({ employeeId: now.employeeId, component: now.component, kind: 'rule_change', months: [before.month, now.month], fromRules: before.compatibleRules, toRules: now.compatibleRules,
        message: '同じ給与条件の連続月で、両月を再現できる共通の丸め候補がありません。計算方式の変更候補です。' })
      const first = rows[index - 2]
      if (!first || !adjacent(first.month, before.month) || first.context !== now.context
        || [first, before, now].some(row => row.compatibleRules.length !== 1 || row.rateSource === 'prior_learned')) continue
      if (first.compatibleRules[0] === now.compatibleRules[0] && disjoint(before.compatibleRules, now.compatibleRules)) issues.push({ employeeId: now.employeeId, component: now.component, kind: 'rule_reversal', months: [first.month, before.month, now.month], fromRules: first.compatibleRules, toRules: before.compatibleRules,
        message: '同じ給与条件の連続する3か月で、丸め候補が A→B→A に戻っています。計算方式が往復した候補です。' })
    }
  }
  const counts = (rows: Evidence[]) => ({
    checkedComponents: rows.filter(row => row.status !== 'unverified').length,
    matchedComponents: rows.filter(row => row.status === 'matched').length,
    mismatchedComponents: rows.filter(row => row.status === 'mismatch').length,
    ambiguousComponents: rows.filter(row => row.status === 'ambiguous').length,
    unverifiedComponents: rows.filter(row => row.status === 'unverified').length,
  })
  const months = [...new Set(evidence.map(row => row.month))].sort().map(month => ({ month, ...counts(evidence.filter(row => row.month === month)) }))
  return { version: '2026-10-09.1', months, observations: evidence.map(row => ({ month: row.month, employeeId: row.employeeId,
    component: row.component, status: row.status, compatibleRules: row.compatibleRules, reason: row.reason, rateSource: row.rateSource })), issues,
    totals: { ...counts(evidence), ruleChanges: issues.filter(issue => issue.kind === 'rule_change').length, ruleReversals: issues.filter(issue => issue.kind === 'rule_reversal').length, settingsChanges: issues.filter(issue => issue.kind === 'settings_change').length } }
}
