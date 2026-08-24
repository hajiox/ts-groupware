import { NextRequest, NextResponse } from 'next/server'
import { getManagementPermissions } from '@/lib/management-permissions'
import { getUserSession } from '@/lib/session'
import { loadAttendanceCalculationPolicy } from '@/lib/payroll-attendance-policy-data'
import {
  calculatePayroll,
  hasCompleteAttendancePair,
  summarizeAttendance,
  summarizePaidLeavePayments,
  type AttendanceSummary,
  type PaidLeavePaymentLike,
  type PayrollProfile,
  type PunchLike,
} from '@/lib/payroll-calculation'
import { adminClient } from '@/lib/supabase/admin'
import { isEmployeePayrollEligibleForRange } from '@/lib/workforce-employment'

type PeriodRow = {
  id: string
  payroll_month: string
  payroll_kind: string
  attendance_month: string
  pay_date: string
}

type EmployeeRow = {
  id: string
  user_id: string | null
  employee_code: string | null
  display_name: string
  real_name: string | null
  department: string | null
  payroll_status: string
  hire_date: string | null
  resigned_date: string | null
  raw_payload: Record<string, unknown> | null
}

type PayrollNameAlias = {
  source_employee_id?: string
  name?: string
  employee_code?: string | null
}

type ProfileRow = PayrollProfile & {
  id: string
  employee_id: string
  effective_from: string
  effective_to: string | null
  source_snapshot: Record<string, unknown> | null
}

type ResultRow = {
  id: string
  payroll_period_id: string
  employee_id: string
  taxable_payment_total: number | string | null
  non_taxable_payment_total: number | string | null
  payment_total: number | string | null
  social_insurance_total: number | string | null
  deduction_total: number | string | null
  taxable_income: number | string | null
  net_payment: number | string | null
}

type PayrollItemRow = {
  id: string
  code: string
  name: string
  item_type: string
  taxable: boolean | null
}

type ResultItemRow = {
  payroll_result_id: string
  payroll_item_id: string
  amount: number | string | null
  minutes: number | string | null
  days: number | string | null
  rate: number | string | null
}

type LaborItemDetail = {
  code: string
  name: string
  itemType: string
  taxable: boolean
  amount: number
  minutes: number | null
  days: number | null
  rate: number | null
}

type PayrollBreakdownItem = {
  code: string
  label: string
  amount: number
  meta: string
}

type PayrollBreakdown = {
  baseAmount: number
  overtimeAmount: number
  taxableAdditions: number
  nonTaxableAmount: number
  deductionTotal: number
  hasItemDetails: boolean
  earningItems: PayrollBreakdownItem[]
  deductionItems: PayrollBreakdownItem[]
  attendanceItems: PayrollBreakdownItem[]
}

type PunchRow = PunchLike & {
  employee_id: string | null
}

type PaidLeaveRow = PaidLeavePaymentLike & {
  employee_id: string
}

type LaborResultMatch = {
  result: ResultRow
  sourceEmployee: EmployeeRow | null
  matchedBy: 'direct' | 'employee_code' | 'registered_alias' | 'normalized_name' | 'base_name' | 'contains_name' | 'possible_old_surname'
  confidence: number
}

type DiffReviewRow = {
  employeeName: string
  hasLaborResult: boolean
  hasProfile: boolean
  calculationUnavailableReason: string | null
  laborMatch: { matchedBy: string } | null
  laborCandidates: unknown[]
  laborBreakdown: PayrollBreakdown | null
  calculatedBreakdown: PayrollBreakdown | null
  hasOperationalAttendanceDifference: boolean
  operationalPaymentDelta: number | null
  delta: {
    paymentTotal: number | null
    netPayment: number | null
  }
  issue: string
}

type ReviewChangePointId =
  | 'employee_match'
  | 'labor_result_missing'
  | 'calculation_profile'
  | 'attendance_input'
  | 'operational_attendance'
  | 'source_detail'
  | 'base_amount'
  | 'overtime'
  | 'taxable_additions'
  | 'non_taxable'
  | 'deductions'
  | 'rounding_unclassified'

type ReviewChangePointDefinition = {
  label: string
  priority: 'blocker' | 'high' | 'medium'
  diagnosis: string
  action: string
  target: string
}

const REVIEW_CHANGE_POINT_DEFINITIONS: Record<ReviewChangePointId, ReviewChangePointDefinition> = {
  employee_match: {
    label: '社員の突合',
    priority: 'blocker',
    diagnosis: '社員NO、旧姓、括弧付き氏名などにより、労務士結果と人事マスタの対応が確定していません。',
    action: '社員NOと氏名履歴を確認し、同一人物の対応を確定します。',
    target: '人事管理 / 労務士データ突合',
  },
  labor_result_missing: {
    label: '労務士給与結果',
    priority: 'blocker',
    diagnosis: '対象社員の労務士確定額が取り込まれていないため、正解データとの比較ができません。',
    action: '対象月の支給控除一覧・賃金台帳を解析し、社員別の支給・控除結果を取り込みます。',
    target: '労務データ / ZIP解析',
  },
  calculation_profile: {
    label: '給与計算設定',
    priority: 'blocker',
    diagnosis: '社内計算に必要な月給・時給・残業除数などの設定が不足しています。',
    action: '労務士の賃金台帳と雇用条件を根拠に、社員別の計算設定を登録します。',
    target: '給与計算 / 社員別計算設定',
  },
  attendance_input: {
    label: '計算勤怠の不足',
    priority: 'blocker',
    diagnosis: '社内計算に必要な打刻または労務士勤怠が不足しています。',
    action: '打刻漏れ、休憩、所定時間、休日区分を確認して勤怠入力を補完します。',
    target: '勤怠管理 / 労務データ取込',
  },
  operational_attendance: {
    label: '実打刻との差',
    priority: 'medium',
    diagnosis: '給与式は一致していますが、労務士確定勤怠とTSGの実打刻に差があります。',
    action: '打刻漏れ、休憩、所定時間、休日区分を確認します。給与式の差異には含めません。',
    target: '勤怠管理',
  },
  source_detail: {
    label: '労務士明細の抽出',
    priority: 'blocker',
    diagnosis: '支給合計だけが入り、基本給・手当・控除の明細が抽出されていません。',
    action: '支給控除一覧・賃金台帳のExcel/CSVを優先して取り込み、項目単位で比較可能にします。',
    target: '労務データ / ZIP解析',
  },
  base_amount: {
    label: '基本給・本給',
    priority: 'high',
    diagnosis: '基本給、時給、月給区分、所定時間のいずれかが労務士計算と一致していません。',
    action: '社員別の基本額と計算型を労務士結果へ合わせます。',
    target: '給与計算プロフィール',
  },
  overtime: {
    label: '残業・休日・深夜',
    priority: 'high',
    diagnosis: '残業除数、割増率、対象時間、端数処理のいずれかに差があります。',
    action: '普通残業・休日・深夜を分け、除数・割増率・15分丸めを社員別に検証します。',
    target: '給与計算プロフィール / 勤怠丸め',
  },
  taxable_additions: {
    label: '課税手当・その他支給',
    priority: 'medium',
    diagnosis: '手当の項目対応、固定額、課税区分に差があります。',
    action: '労務士明細の支給項目を社内給与項目へ対応付けます。',
    target: '給与項目マッピング',
  },
  non_taxable: {
    label: '非課税支給',
    priority: 'medium',
    diagnosis: '通勤費などの非課税支給額または課税区分に差があります。',
    action: '通勤費と非課税上限、月途中変更の適用月を確認します。',
    target: '通勤費 / 非課税支給設定',
  },
  deductions: {
    label: '控除',
    priority: 'high',
    diagnosis: '社会保険、雇用保険、税、その他控除のいずれかが一致していません。',
    action: '控除項目ごとに労務士額と比較し、料率・標準報酬・適用開始月を修正します。',
    target: '保険・税・控除設定',
  },
  rounding_unclassified: {
    label: '未分類項目・端数処理',
    priority: 'medium',
    diagnosis: '主要項目の差額だけでは総支給または手取の差を説明できません。',
    action: '未対応の支給控除項目と、円単位・時間単位の丸め順序を確認します。',
    target: '給与項目マッピング / 端数処理',
  },
}

function amount(value: unknown) {
  const next = typeof value === 'number' ? value : Number(value || 0)
  return Number.isFinite(next) ? next : 0
}

function numericDuration(value: unknown) {
  if (typeof value === 'string' && /^-?\d{1,3}:\d{2}$/.test(value.trim())) {
    const sign = value.trim().startsWith('-') ? -1 : 1
    const [hours, minutes] = value.trim().replace('-', '').split(':').map(Number)
    return sign * (hours * 60 + minutes)
  }
  return amount(value)
}

const BASE_ITEM_CODES = new Set(['base_salary', 'regular_salary', 'hourly_rate', 'base_salary_2'])
const OVERTIME_ITEM_CODES = new Set([
  'overtime_allowance',
  'regular_overtime',
  'weekday_saturday_overtime',
  'weekday_saturday_overtime_amount',
  'sunday_overtime',
  'sunday_overtime_amount',
  'over_60h_overtime',
  'over_60h_overtime_amount',
  'night_allowance',
  'holiday_work_allowance',
])

function itemMeta(item: LaborItemDetail) {
  const parts = []
  if (item.minutes) parts.push(`${Math.floor(Math.abs(item.minutes) / 60)}:${String(Math.abs(item.minutes) % 60).padStart(2, '0')}`)
  if (item.days) parts.push(`${item.days}日`)
  if (item.rate) parts.push(`単価 ${Math.round(item.rate).toLocaleString()}円`)
  return parts.join(' / ')
}

function topItems(items: LaborItemDetail[], itemType: string): PayrollBreakdownItem[] {
  return items
    .filter((item) => item.itemType === itemType && (item.amount || item.minutes || item.days))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, 8)
    .map((item) => ({
      code: item.code,
      label: item.name || item.code,
      amount: item.amount,
      meta: itemMeta(item),
    }))
}

function summarizeLaborBreakdown(result: ResultRow | null, items: LaborItemDetail[]): PayrollBreakdown | null {
  if (!result) return null
  const earningItems = items.filter((item) => item.itemType === 'earning')
  const deductionItems = items.filter((item) => item.itemType === 'deduction')
  const hasItemDetails = items.length > 0
  const baseAmount = earningItems
    .filter((item) => BASE_ITEM_CODES.has(item.code))
    .reduce((sum, item) => sum + item.amount, 0)
  const overtimeAmount = earningItems
    .filter((item) => OVERTIME_ITEM_CODES.has(item.code))
    .reduce((sum, item) => sum + item.amount, 0)
  const taxableAdditions = earningItems
    .filter((item) => item.taxable && !BASE_ITEM_CODES.has(item.code) && !OVERTIME_ITEM_CODES.has(item.code))
    .reduce((sum, item) => sum + item.amount, 0)
  const nonTaxableAmount = earningItems
    .filter((item) => !item.taxable)
    .reduce((sum, item) => sum + item.amount, 0)
  const reliableTotal = reliableDeductionTotal(result)
  const itemizedDeductionTotal = deductionItems.reduce((sum, item) => sum + item.amount, 0)
  const deductionTotal = deductionItems.length && Math.abs(itemizedDeductionTotal - reliableTotal) <= 1
    ? itemizedDeductionTotal
    : reliableTotal

  return {
    baseAmount,
    overtimeAmount,
    taxableAdditions,
    nonTaxableAmount: nonTaxableAmount || amount(result.non_taxable_payment_total),
    deductionTotal,
    hasItemDetails,
    earningItems: topItems(items, 'earning'),
    deductionItems: topItems(items, 'deduction'),
    attendanceItems: topItems(items, 'attendance'),
  }
}

function reliableDeductionTotal(result: ResultRow | null) {
  if (!result) return 0
  const stated = amount(result.deduction_total)
  const derived = amount(result.payment_total) - amount(result.net_payment)
  return Math.abs(stated - derived) <= 1 ? stated : derived
}

function summarizeCalculatedBreakdown(calculated: ReturnType<typeof calculatePayroll> | null): PayrollBreakdown | null {
  if (!calculated) return null
  return {
    baseAmount: calculated.baseAmount,
    overtimeAmount: calculated.overtimeAmount,
    taxableAdditions: calculated.taxableAdditions,
    nonTaxableAmount: calculated.nonTaxablePaymentTotal,
    deductionTotal: calculated.deductionTotal,
    hasItemDetails: true,
    earningItems: [],
    deductionItems: Object.entries(calculated.deductionSnapshot || {}).map(([code, value]) => ({
      code,
      label: code,
      amount: value,
      meta: '',
    })),
    attendanceItems: [],
  }
}

function yenText(value: number) {
  return `${Math.round(value).toLocaleString()}円`
}

function addDeltaHint(hints: string[], label: string, laborValue: number, calculatedValue: number) {
  const delta = calculatedValue - laborValue
  if (Math.abs(delta) >= 1) {
    hints.push(`${label}: 労務士 ${yenText(laborValue)} / 自社 ${yenText(calculatedValue)} / 差 ${yenText(delta)}`)
  }
}

function buildDifferenceHints(params: {
  labor: ResultRow | null
  laborBreakdown: PayrollBreakdown | null
  calculatedBreakdown: PayrollBreakdown | null
  laborMatch: LaborResultMatch | null
  laborCandidates: LaborResultMatch[]
  profile: PayrollProfile | null
  calculationUnavailableReason: string | null
}) {
  const hints: string[] = []
  if (!params.labor) {
    hints.push(params.laborCandidates.length ? '労務士結果の名前・社員NO候補があります。突合先の確認が必要です。' : '労務士結果が突合できていません。')
    return hints
  }
  if (!params.profile) {
    hints.push('自社計算の給与設定がありません。社員マスタ・計算プロファイルの設定が必要です。')
    return hints
  }
  if (params.calculationUnavailableReason || !params.calculatedBreakdown) {
    hints.push('自社計算に使う打刻または労務士取込勤怠が不足しています。')
    return hints
  }
  if (!params.laborBreakdown?.hasItemDetails) {
    hints.push('労務士側の明細項目が未取込です。支給合計だけではロジック差を分解できません。')
  }
  if (params.laborMatch && params.laborMatch.matchedBy !== 'direct') {
    hints.push(`労務士結果は ${matchLabel(params.laborMatch.matchedBy)} で突合しています。名前違い・旧姓・補足文字列の確認対象です。`)
  }

  const laborBreakdown = params.laborBreakdown
  const calculatedBreakdown = params.calculatedBreakdown
  if (laborBreakdown) {
    addDeltaHint(hints, '基本給・本給差', laborBreakdown.baseAmount, calculatedBreakdown.baseAmount)
    addDeltaHint(hints, '残業・休日・深夜手当差', laborBreakdown.overtimeAmount, calculatedBreakdown.overtimeAmount)
    addDeltaHint(hints, '手当・その他課税支給差', laborBreakdown.taxableAdditions, calculatedBreakdown.taxableAdditions)
    addDeltaHint(hints, '非課税支給差', laborBreakdown.nonTaxableAmount, calculatedBreakdown.nonTaxableAmount)
    addDeltaHint(hints, '控除差', laborBreakdown.deductionTotal, calculatedBreakdown.deductionTotal)
  }
  if (hints.length === 0) hints.push('主要内訳は一致しています。差異が残る場合は端数処理・未分類項目を確認してください。')
  return hints
}

function buildPayrollReview(rows: DiffReviewRow[]) {
  const changePointRows = new Map<ReviewChangePointId, Map<string, number>>()

  function record(changePointId: ReviewChangePointId, employeeName: string, delta = 0) {
    const employeeRows = changePointRows.get(changePointId) || new Map<string, number>()
    employeeRows.set(employeeName, (employeeRows.get(employeeName) || 0) + delta)
    changePointRows.set(changePointId, employeeRows)
  }

  for (const row of rows) {
    if (
      row.laborCandidates.length > 0
      || (row.laborMatch && !['direct', 'registered_alias'].includes(row.laborMatch.matchedBy))
    ) {
      record('employee_match', row.employeeName)
    }
    if (!row.hasLaborResult && row.laborCandidates.length === 0) {
      record('labor_result_missing', row.employeeName)
    }
    if (row.hasLaborResult && !row.hasProfile) {
      record('calculation_profile', row.employeeName)
    }
    if (row.calculationUnavailableReason) {
      record('attendance_input', row.employeeName)
    }
    if (row.hasOperationalAttendanceDifference) {
      record('operational_attendance', row.employeeName, row.operationalPaymentDelta || 0)
    }
    if (row.hasLaborResult && row.laborBreakdown && !row.laborBreakdown.hasItemDetails) {
      record('source_detail', row.employeeName)
    }

    if (!row.laborBreakdown || !row.calculatedBreakdown) continue

    const deltas = {
      base_amount: row.calculatedBreakdown.baseAmount - row.laborBreakdown.baseAmount,
      overtime: row.calculatedBreakdown.overtimeAmount - row.laborBreakdown.overtimeAmount,
      taxable_additions: row.calculatedBreakdown.taxableAdditions - row.laborBreakdown.taxableAdditions,
      non_taxable: row.calculatedBreakdown.nonTaxableAmount - row.laborBreakdown.nonTaxableAmount,
      deductions: row.calculatedBreakdown.deductionTotal - row.laborBreakdown.deductionTotal,
    }

    for (const [changePointId, delta] of Object.entries(deltas) as [ReviewChangePointId, number][]) {
      if (Math.abs(delta) >= 1) record(changePointId, row.employeeName, delta)
    }

    const explainedPaymentDelta = deltas.base_amount + deltas.overtime + deltas.taxable_additions + deltas.non_taxable
    const paymentResidual = (row.delta.paymentTotal || 0) - explainedPaymentDelta
    const expectedNetDelta = (row.delta.paymentTotal || 0) - deltas.deductions
    const netResidual = (row.delta.netPayment || 0) - expectedNetDelta
    const residual = Math.abs(paymentResidual) >= Math.abs(netResidual) ? paymentResidual : netResidual
    if (Math.abs(residual) >= 1) {
      record('rounding_unclassified', row.employeeName, residual)
    }
  }

  const priorityOrder = { blocker: 0, high: 1, medium: 2 }
  const changePoints = Array.from(changePointRows.entries())
    .map(([id, employeeRows]) => {
      const definition = REVIEW_CHANGE_POINT_DEFINITIONS[id]
      const deltas = Array.from(employeeRows.values())
      return {
        id,
        ...definition,
        affectedEmployees: employeeRows.size,
        employeeNames: Array.from(employeeRows.keys()).slice(0, 6),
        signedDeltaTotal: deltas.reduce((sum, delta) => sum + delta, 0),
        absoluteDeltaTotal: deltas.reduce((sum, delta) => sum + Math.abs(delta), 0),
      }
    })
    .sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority]
      if (priorityDiff) return priorityDiff
      return b.affectedEmployees - a.affectedEmployees || b.absoluteDeltaTotal - a.absoluteDeltaTotal
    })

  const comparable = rows.filter((row) => row.hasLaborResult && row.hasProfile && !row.calculationUnavailableReason)
  const exactMatches = comparable.filter((row) => (
    Math.abs(row.delta.paymentTotal || 0) < 1
    && Math.abs(row.delta.netPayment || 0) < 1
  )).length
  const attendanceDifferenceEmployees = rows.filter((row) => row.hasOperationalAttendanceDifference).length
  const blockers = changePoints.filter((changePoint) => changePoint.priority === 'blocker')
  const monetaryChanges = changePoints.filter((changePoint) => (
    changePoint.priority !== 'blocker'
    && changePoint.id !== 'operational_attendance'
  ))
  const status = comparable.length === 0
    ? 'not_ready'
    : blockers.length > 0
      ? 'partially_blocked'
      : monetaryChanges.length > 0
        ? 'needs_changes'
        : 'verified'
  const statusLabel = status === 'not_ready'
    ? '比較準備が必要'
    : status === 'partially_blocked'
      ? '一部未比較'
      : status === 'needs_changes'
        ? '変更候補あり'
        : attendanceDifferenceEmployees > 0
          ? '給与式一致・勤怠差あり'
          : '主要項目一致'
  const headline = status === 'not_ready'
    ? '労務士結果と社内計算を比較できる社員がまだいません。'
    : status === 'partially_blocked'
      ? '比較できた社員の差異に加え、入力・突合不足を先に解消する必要があります。'
      : status === 'needs_changes'
        ? '労務士ロジックへ合わせるための変更候補が見つかりました。'
        : attendanceDifferenceEmployees > 0
          ? '労務士と同じ勤怠条件では金額一致。実打刻との差だけ確認が必要です。'
          : '抽出できた主要項目は労務士結果と一致しています。'

  return {
    status,
    statusLabel,
    headline,
    readinessPercent: rows.length ? Math.round((comparable.length / rows.length) * 100) : 0,
    exactMatches,
    unresolvedEmployees: rows.filter((row) => !['一致', '勤怠差'].includes(row.issue)).length,
    attendanceDifferenceEmployees,
    blockerCategories: blockers.length,
    changeCandidateCategories: monetaryChanges.length,
    changePoints,
  }
}

function monthEnd(monthStart: string) {
  const [year, month] = monthStart.split('-').map(Number)
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

function kindLabel(kind: string) {
  if (kind === 'bonus') return '賞与'
  if (kind === 'adjustment') return '調整'
  return '給与'
}

function profileApplies(profile: ProfileRow, monthStart: string) {
  return profile.effective_from <= monthStart && (!profile.effective_to || profile.effective_to >= monthStart)
}

function normalizeCode(value: string | null | undefined) {
  return String(value || '').replace(/[^\dA-Za-z]/g, '').replace(/^0+(?=\d)/, '')
}

function normalizeName(value: string | null | undefined) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[ \t\r\n　]/g, '')
    .replace(/(さん|様|さま|君|くん|ちゃん)$/g, '')
}

function baseName(value: string | null | undefined) {
  return normalizeName(value)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[-_＿].*$/g, '')
}

function employeeName(employee: EmployeeRow | null | undefined) {
  return employee?.real_name || employee?.display_name || ''
}

function isKnownPayrollNamePair(targetName: string, sourceName: string) {
  const knownPairs = [
    ['佐藤葵(フロア)', '佐藤葵(女性)'],
    ['佐藤葵(製造)', '佐藤葵(男性)'],
    ['生井美穂', '内海美穂'],
    ['森結芽香', '鈴木結芽香'],
  ]
  return knownPairs.some(([left, right]) => (
    (targetName === left && sourceName === right)
    || (targetName === right && sourceName === left)
  ))
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function payrollNameAliases(employee: EmployeeRow): PayrollNameAlias[] {
  const hrProfile = objectValue(employee.raw_payload?.hr_profile)
  const aliases = hrProfile.payroll_name_aliases
  if (!Array.isArray(aliases)) return []
  return aliases.filter((alias): alias is PayrollNameAlias => !!alias && typeof alias === 'object')
}

function matchScore(target: EmployeeRow, source: EmployeeRow | null): Omit<LaborResultMatch, 'result'> | null {
  if (!source) return null

  const targetCode = normalizeCode(target.employee_code)
  const sourceCode = normalizeCode(source.employee_code)
  if (targetCode && sourceCode && targetCode === sourceCode) {
    return { sourceEmployee: source, matchedBy: 'employee_code', confidence: 100 }
  }

  const registeredAlias = payrollNameAliases(target).find((alias) => (
    alias.source_employee_id === source.id
    || (alias.name && normalizeName(alias.name) === normalizeName(employeeName(source)))
  ))
  if (registeredAlias) {
    return { sourceEmployee: source, matchedBy: 'registered_alias', confidence: 99 }
  }

  const targetName = normalizeName(employeeName(target))
  const sourceName = normalizeName(employeeName(source))
  if (targetName && sourceName && targetName === sourceName) {
    return { sourceEmployee: source, matchedBy: 'normalized_name', confidence: 92 }
  }
  if (isKnownPayrollNamePair(targetName, sourceName)) {
    return { sourceEmployee: source, matchedBy: 'registered_alias', confidence: 99 }
  }

  const targetBase = baseName(employeeName(target))
  const sourceBase = baseName(employeeName(source))
  if (targetBase && sourceBase && targetBase === sourceBase) {
    return { sourceEmployee: source, matchedBy: 'base_name', confidence: 88 }
  }

  if (
    targetBase.length >= 3 &&
    sourceBase.length >= 3 &&
    (targetBase.includes(sourceBase) || sourceBase.includes(targetBase))
  ) {
    return { sourceEmployee: source, matchedBy: 'contains_name', confidence: 72 }
  }

  const tailLength = Math.min(3, targetBase.length, sourceBase.length)
  if (tailLength >= 2 && targetBase.slice(-tailLength) === sourceBase.slice(-tailLength)) {
    return { sourceEmployee: source, matchedBy: 'possible_old_surname', confidence: 64 }
  }

  return null
}

function matchLabel(value: LaborResultMatch['matchedBy']) {
  if (value === 'direct') return '直接ID'
  if (value === 'employee_code') return '社員NO'
  if (value === 'registered_alias') return '社員マスタ別名'
  if (value === 'normalized_name') return '名前一致'
  if (value === 'base_name') return '括弧除去名'
  if (value === 'possible_old_surname') return '旧姓候補'
  return '名前包含'
}

function attendanceFromSourceSnapshot(profile: PayrollProfile): AttendanceSummary | null {
  const source = profile.source_snapshot || {}
  const workDays = amount(source.work_days)
  const workMinutes = numericDuration(source.work_minutes)
  const weekdaySaturdayOvertimeMinutes = numericDuration(
    source.weekday_saturday_overtime_minutes ?? source.regular_overtime_minutes,
  )
  const sundayOvertimeMinutes = numericDuration(source.sunday_overtime_minutes)

  if (!workDays && !workMinutes && !weekdaySaturdayOvertimeMinutes && !sundayOvertimeMinutes) {
    return null
  }

  return {
    workDays,
    workMinutes,
    weekdaySaturdayOvertimeMinutes,
    sundayOvertimeMinutes,
    daily: [],
  }
}

function attendanceFromLaborItems(items: LaborItemDetail[]): AttendanceSummary | null {
  const itemByCode = new Map(items.map((item) => [item.code, item]))
  const workDays = itemByCode.get('attendance_days')?.days || 0
  const workMinutes = itemByCode.get('work_minutes')?.minutes || 0
  const weekdaySaturdayOvertimeMinutes =
    itemByCode.get('weekday_saturday_overtime_minutes')?.minutes
    || itemByCode.get('regular_overtime_minutes')?.minutes
    || 0
  const sundayOvertimeMinutes = itemByCode.get('sunday_overtime_minutes')?.minutes || 0

  if (!workDays && !workMinutes && !weekdaySaturdayOvertimeMinutes && !sundayOvertimeMinutes) {
    return null
  }

  return {
    workDays,
    workMinutes,
    weekdaySaturdayOvertimeMinutes,
    sundayOvertimeMinutes,
    daily: [],
  }
}

function learnedProfileFromLaborResult(
  employee: EmployeeRow,
  result: ResultRow | null,
  items: LaborItemDetail[],
): PayrollProfile | null {
  if (!result) return null

  const laborBreakdown = summarizeLaborBreakdown(result, items)
  const attendance = attendanceFromLaborItems(items)
  const regularSalaryItem = items.find((item) => item.code === 'regular_salary')
  const statedHourlyRate = amount(regularSalaryItem?.rate)
  const derivedHourlyRate = laborBreakdown && attendance?.workMinutes
    ? (laborBreakdown.baseAmount * 60) / attendance.workMinutes
    : 0
  const hourlyRate = statedHourlyRate || derivedHourlyRate
  const employeeCode = normalizeCode(employee.employee_code)
  const baseAmount = laborBreakdown?.baseAmount || 0
  const overtimeAmount = laborBreakdown?.overtimeAmount || 0
  const calculationType: PayrollProfile['calculation_type'] = ['1', '2'].includes(employeeCode)
    ? 'officer_fixed'
    : statedHourlyRate > 0
      ? 'hourly'
      : baseAmount > 0 && overtimeAmount !== 0
        ? 'monthly_with_overtime'
        : baseAmount > 0
          ? 'monthly_fixed'
          : hourlyRate > 0
            ? 'hourly'
            : 'unknown'

  if (calculationType === 'unknown') return null

  const taxableAdditions = Object.fromEntries(items
    .filter((item) => item.itemType === 'earning' && item.taxable && item.amount !== 0)
    .filter((item) => !BASE_ITEM_CODES.has(item.code) && !OVERTIME_ITEM_CODES.has(item.code))
    .map((item) => [item.code, item.amount]))
  const deductions: Record<string, number> = Object.fromEntries(items
    .filter((item) => item.itemType === 'deduction' && item.amount !== 0)
    .map((item) => [item.code, item.amount]))

  if (Object.keys(deductions).length === 0) {
    deductions.confirmed_deduction_total = reliableDeductionTotal(result)
  }

  const weekdayMinutes = attendance?.weekdaySaturdayOvertimeMinutes || 0
  const sundayMinutes = attendance?.sundayOvertimeMinutes || 0
  const weekdayAmount = items
    .filter((item) => ['weekday_saturday_overtime', 'regular_overtime', 'overtime_allowance'].includes(item.code))
    .reduce((sum, item) => sum + item.amount, 0)
  const sundayAmount = items
    .filter((item) => ['sunday_overtime', 'holiday_work_allowance'].includes(item.code))
    .reduce((sum, item) => sum + item.amount, 0)

  return {
    calculation_type: calculationType,
    monthly_base_amount: calculationType === 'hourly' ? null : baseAmount,
    hourly_rate: calculationType === 'hourly' ? hourlyRate : null,
    weekday_saturday_overtime_multiplier: 1.25,
    sunday_overtime_multiplier: 1.35,
    taxable_additions: taxableAdditions,
    deduction_snapshot: deductions,
    source_snapshot: {
      source: 'labor_result_fallback',
      base_payment_amount: baseAmount,
      work_days: attendance?.workDays || 0,
      work_minutes: attendance?.workMinutes || 0,
      weekday_saturday_overtime_minutes: weekdayMinutes,
      sunday_overtime_minutes: sundayMinutes,
      weekday_saturday_overtime_hourly_rate: weekdayMinutes > 0 ? weekdayAmount / (weekdayMinutes / 60) : 0,
      sunday_overtime_hourly_rate: sundayMinutes > 0 ? sundayAmount / (sundayMinutes / 60) : 0,
      non_taxable_payment_total: amount(result.non_taxable_payment_total),
      payment_total: amount(result.payment_total),
      deduction_total: reliableDeductionTotal(result),
      net_payment: amount(result.net_payment),
      employment_insurance: amount(deductions.employment_insurance),
    },
  }
}

export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

  const permissions = getManagementPermissions(user)
  if (!permissions.canViewPayroll) {
    return NextResponse.json({ error: '給与計算の閲覧権限が必要です' }, { status: 403 })
  }

  const requestedPeriodId = request.nextUrl.searchParams.get('periodId')
  const requestedPayrollMonth = request.nextUrl.searchParams.get('payrollMonth')
  const requestedPayrollKind = request.nextUrl.searchParams.get('payrollKind')

  const { data: periods, error: periodsError } = await adminClient
    .from('gw_payroll_periods')
    .select('id, payroll_month, payroll_kind, attendance_month, pay_date')
    .order('payroll_month', { ascending: false })
    .order('payroll_kind', { ascending: true })

  if (periodsError) {
    return NextResponse.json({ error: periodsError.message }, { status: 500 })
  }

  const periodRows = (periods || []) as PeriodRow[]
  const comparisonPeriodRows = periodRows.filter((period) => period.payroll_kind !== 'bonus')
  const hasRequestedPeriod = Boolean(requestedPeriodId || requestedPayrollMonth)
  const selectedPeriod = periodRows.find((period) => period.id === requestedPeriodId)
    || periodRows.find((period) => (
      requestedPayrollMonth
      && period.payroll_month.slice(0, 7) === requestedPayrollMonth.slice(0, 7)
      && (!requestedPayrollKind || period.payroll_kind === requestedPayrollKind)
    ))
    || (!hasRequestedPeriod ? periodRows[0] : null)
    || null
  if (!selectedPeriod) {
    return NextResponse.json({
      periods: comparisonPeriodRows.map((period) => ({
        id: period.id,
        payrollMonth: period.payroll_month,
        payrollKind: period.payroll_kind,
        payrollKindLabel: kindLabel(period.payroll_kind),
        attendanceMonth: period.attendance_month,
        payDate: period.pay_date,
      })),
      selectedPeriod: null,
      requestedPeriodMissing: hasRequestedPeriod,
      summary: { employees: 0, compared: 0, missingProfile: 0, missingLaborResult: 0, paymentDeltaTotal: 0, netDeltaTotal: 0, mismatches: 0 },
      review: buildPayrollReview([]),
      rows: [],
    })
  }

  const attendanceMonthEnd = monthEnd(selectedPeriod.attendance_month)
  const profileMonth = selectedPeriod.payroll_month
  const [
    { data: employees, error: employeesError },
    { data: profiles, error: profilesError },
    { data: laborResults, error: resultsError },
    { data: punches, error: punchesError },
    { data: paidLeaveRows, error: paidLeaveError },
  ] = await Promise.all([
    adminClient
      .from('gw_payroll_employees')
      .select('id, user_id, employee_code, display_name, real_name, department, payroll_status, hire_date, resigned_date, raw_payload')
      .order('employee_code', { ascending: true, nullsFirst: false }),
    adminClient
      .from('gw_payroll_calculation_profiles')
      .select('id, employee_id, effective_from, effective_to, calculation_type, monthly_base_amount, hourly_rate, overtime_divisor, weekday_saturday_overtime_multiplier, sunday_overtime_multiplier, scheduled_minutes, taxable_additions, deduction_snapshot, source_snapshot'),
    adminClient
      .from('gw_payroll_employee_results')
      .select('id, payroll_period_id, employee_id, taxable_payment_total, non_taxable_payment_total, payment_total, social_insurance_total, deduction_total, taxable_income, net_payment')
      .eq('payroll_period_id', selectedPeriod.id),
    adminClient
      .from('gw_attendance_punches')
      .select('employee_id, punch_type, work_date, punched_at, break_override_minutes')
      .eq('is_voided', false)
      .gte('work_date', selectedPeriod.attendance_month)
      .lte('work_date', attendanceMonthEnd)
      .not('employee_id', 'is', null),
    adminClient
      .from('gw_paid_leave_requests')
      .select('employee_id, leave_date, leave_unit, requested_days, payable_minutes_snapshot, paid_wage_amount, raw_payload')
      .in('request_status', ['approved', 'consumed'])
      .gte('leave_date', selectedPeriod.attendance_month)
      .lte('leave_date', attendanceMonthEnd),
  ])

  const dbError = employeesError || profilesError || resultsError || punchesError || paidLeaveError
  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  const laborResultRows = ((laborResults || []) as ResultRow[])
  const laborResultIds = laborResultRows.map((result) => result.id)
  const { data: itemDefinitions, error: itemDefinitionsError } = await adminClient
    .from('gw_payroll_items')
    .select('id, code, name, item_type, taxable')
    .order('sort_order', { ascending: true })

  let resultItems: ResultItemRow[] = []
  let resultItemsError: { message: string } | null = null
  if (laborResultIds.length) {
    const resultItemsResponse = await adminClient
      .from('gw_payroll_result_items')
      .select('payroll_result_id, payroll_item_id, amount, minutes, days, rate')
      .in('payroll_result_id', laborResultIds)
    resultItems = (resultItemsResponse.data || []) as ResultItemRow[]
    resultItemsError = resultItemsResponse.error
  }

  const itemError = itemDefinitionsError || resultItemsError
  if (itemError) {
    return NextResponse.json({ error: itemError.message }, { status: 500 })
  }

  const itemDefinitionMap = new Map(((itemDefinitions || []) as PayrollItemRow[]).map((item) => [item.id, item]))
  const laborItemsByResult = new Map<string, LaborItemDetail[]>()
  for (const resultItem of resultItems) {
    const item = itemDefinitionMap.get(resultItem.payroll_item_id)
    const rows = laborItemsByResult.get(resultItem.payroll_result_id) || []
    rows.push({
      code: item?.code || resultItem.payroll_item_id,
      name: item?.name || item?.code || resultItem.payroll_item_id,
      itemType: item?.item_type || 'memo',
      taxable: Boolean(item?.taxable),
      amount: amount(resultItem.amount),
      minutes: resultItem.minutes === null || resultItem.minutes === undefined ? null : amount(resultItem.minutes),
      days: resultItem.days === null || resultItem.days === undefined ? null : amount(resultItem.days),
      rate: resultItem.rate === null || resultItem.rate === undefined ? null : amount(resultItem.rate),
    })
    laborItemsByResult.set(resultItem.payroll_result_id, rows)
  }

  const employeeMap = new Map(((employees || []) as EmployeeRow[]).map((employee) => [employee.id, employee]))
  const profilesByEmployee = new Map<string, ProfileRow>()
  for (const profile of (profiles || []) as ProfileRow[]) {
    if (!profileApplies(profile, profileMonth)) continue
    const current = profilesByEmployee.get(profile.employee_id)
    if (!current || current.effective_from < profile.effective_from) {
      profilesByEmployee.set(profile.employee_id, profile)
    }
  }

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
  const attendancePolicy = await loadAttendanceCalculationPolicy(attendanceMonthEnd)

  const laborByEmployee = new Map(((laborResults || []) as ResultRow[]).map((result) => [result.employee_id, result]))
  const laborRecords = laborResultRows.map((result) => ({
    result,
    sourceEmployee: employeeMap.get(result.employee_id) || null,
  }))

  function findLaborResult(employee: EmployeeRow): { match: LaborResultMatch | null; candidates: LaborResultMatch[] } {
    const direct = laborByEmployee.get(employee.id)
    if (direct) {
      return {
        match: {
          result: direct,
          sourceEmployee: employee,
          matchedBy: 'direct',
          confidence: 100,
        },
        candidates: [],
      }
    }

    const candidates = laborRecords
      .map((record) => {
        const score = matchScore(employee, record.sourceEmployee)
        return score ? { ...score, result: record.result } : null
      })
      .filter((row): row is LaborResultMatch => !!row)
      .sort((a, b) => b.confidence - a.confidence)

    const match = candidates.find((candidate) => candidate.confidence >= 88) || null

    return {
      match,
      candidates: match?.matchedBy === 'registered_alias' ? [] : candidates.slice(0, 3),
    }
  }

  // Compare each labor-office result once. Current linked employees remain visible
  // when their result is missing, while historical payroll-only profiles do not
  // inflate the selected month's headcount.
  const profileEmployeeIds = Array.from(profilesByEmployee.keys()).filter((employeeId) => {
    const employee = employeeMap.get(employeeId)
    return Boolean(
      employee
      && (employee.user_id || laborByEmployee.has(employeeId))
      && isEmployeePayrollEligibleForRange(employee, selectedPeriod.attendance_month, attendanceMonthEnd),
    )
  })
  const claimedLaborResultIds = new Set<string>()
  for (const employeeId of profileEmployeeIds) {
    const employee = employeeMap.get(employeeId)
    const match = employee ? findLaborResult(employee).match : null
    if (match) claimedLaborResultIds.add(match.result.id)
  }
  const unmatchedLaborEmployeeIds = laborRecords
    .filter((record) => !claimedLaborResultIds.has(record.result.id))
    .map((record) => record.result.employee_id)
  const employeeIds = new Set<string>([
    ...profileEmployeeIds,
    ...unmatchedLaborEmployeeIds,
  ])

  const rows = Array.from(employeeIds)
    .map((employeeId) => {
      const employee = employeeMap.get(employeeId)
      if (!employee || !isEmployeePayrollEligibleForRange(
        employee,
        selectedPeriod.attendance_month,
        attendanceMonthEnd,
      )) return null

      const laborMatchResult = findLaborResult(employee)
      const laborMatch = laborMatchResult.match
      const labor = laborMatch?.result || null
      const laborItemRows = labor ? laborItemsByResult.get(labor.id) || [] : []
      const storedProfile = profilesByEmployee.get(employeeId) || null
      const sourceProfile = laborMatch?.sourceEmployee?.id
        ? profilesByEmployee.get(laborMatch.sourceEmployee.id) || null
        : null
      const profile = sourceProfile || storedProfile || learnedProfileFromLaborResult(employee, labor, laborItemRows)
      const punchRows = punchesByEmployee.get(employeeId) || []
      const hasPunches = hasCompleteAttendancePair(punchRows)
      const punchAttendance = profile && hasPunches
        ? summarizeAttendance(punchRows, profile, attendancePolicy)
        : null
      const laborAttendance = profile ? attendanceFromLaborItems(laborItemRows) : null
      const sourceAttendance = profile && !laborAttendance ? attendanceFromSourceSnapshot(profile) : null
      const attendance = laborAttendance || sourceAttendance || punchAttendance
      const attendanceSource = laborAttendance
        ? 'labor_result'
        : sourceAttendance
          ? 'labor_snapshot'
          : punchAttendance
            ? 'punch'
            : 'none'
      const paidLeave = summarizePaidLeavePayments(
        paidLeaveRowsByEmployee.get(employeeId) || [],
        punchRows,
      )
      const paidLeaveConflictReason = paidLeave.conflicts.length
        ? `有給（全休）と実打刻が重複しています（${paidLeave.conflicts.map((row) => row.leaveDate).join('、')}）。有給取消または打刻修正後に再計算してください`
        : null
      const canCalculateWithoutPunches = profile?.calculation_type === 'monthly_fixed' || profile?.calculation_type === 'officer_fixed'
      const calculated = profile && !paidLeaveConflictReason && (attendance || canCalculateWithoutPunches)
        ? calculatePayroll(
          profile,
          attendance || {
            workDays: 0,
            workMinutes: 0,
            weekdaySaturdayOvertimeMinutes: 0,
            sundayOvertimeMinutes: 0,
            daily: [],
          },
          paidLeave.summary,
        )
        : null
      const punchCalculated = profile && punchAttendance && !paidLeaveConflictReason && attendanceSource !== 'punch'
        ? calculatePayroll(profile, punchAttendance, paidLeave.summary)
        : null
      const calculationUnavailableReason = profile && !calculated
        ? paidLeaveConflictReason || '打刻または労務士取込勤怠がないため時給・残業計算不可'
        : null

      const laborPaymentTotal = amount(labor?.payment_total)
      const laborNetPayment = amount(labor?.net_payment)
      const calculatedPaymentTotal = calculated?.paymentTotal ?? 0
      const calculatedNetPayment = calculated?.netPayment ?? 0
      const paymentDelta = calculated ? calculatedPaymentTotal - laborPaymentTotal : null
      const netDelta = calculated ? calculatedNetPayment - laborNetPayment : null
      const operationalPaymentDelta = punchCalculated ? punchCalculated.paymentTotal - laborPaymentTotal : null
      const operationalNetDelta = punchCalculated ? punchCalculated.netPayment - laborNetPayment : null
      const hasOperationalAttendanceDifference = Boolean(
        punchAttendance
        && laborAttendance
        && (
          punchAttendance.workDays !== laborAttendance.workDays
          || punchAttendance.workMinutes !== laborAttendance.workMinutes
          || punchAttendance.weekdaySaturdayOvertimeMinutes !== laborAttendance.weekdaySaturdayOvertimeMinutes
          || punchAttendance.sundayOvertimeMinutes !== laborAttendance.sundayOvertimeMinutes
          || Math.abs(operationalPaymentDelta || 0) >= 1
          || Math.abs(operationalNetDelta || 0) >= 1
        ),
      )
      const attendanceDifferenceHints = hasOperationalAttendanceDifference && punchAttendance && laborAttendance
        ? [
          `勤務入力: 労務士 ${laborAttendance.workDays}日 / ${laborAttendance.workMinutes}分、打刻 ${punchAttendance.workDays}日 / ${punchAttendance.workMinutes}分`,
          `時間外分類: 労務士 ${laborAttendance.weekdaySaturdayOvertimeMinutes + laborAttendance.sundayOvertimeMinutes}分、打刻 ${punchAttendance.weekdaySaturdayOvertimeMinutes + punchAttendance.sundayOvertimeMinutes}分`,
        ]
        : []
      const laborBreakdown = summarizeLaborBreakdown(labor, laborItemRows)
      const calculatedBreakdown = summarizeCalculatedBreakdown(calculated)
      const differenceHints = buildDifferenceHints({
        labor,
        laborBreakdown,
        calculatedBreakdown,
        laborMatch,
        laborCandidates: laborMatchResult.candidates,
        profile,
        calculationUnavailableReason,
      })

      return {
        employeeId,
        employeeCode: employee.employee_code,
        employeeName: employee.real_name || employee.display_name,
        department: employee.department,
        hasLaborResult: !!labor,
        hasProfile: !!profile,
        profileSource: sourceProfile || storedProfile ? 'stored' : profile ? 'labor_result' : 'missing',
        workDays: attendance?.workDays ?? null,
        workMinutes: attendance?.workMinutes ?? null,
        attendanceSource,
        calculationUnavailableReason,
        laborMatch: laborMatch ? {
          matchedBy: laborMatch.matchedBy,
          matchedByLabel: matchLabel(laborMatch.matchedBy),
          confidence: laborMatch.confidence,
          sourceEmployeeId: laborMatch.sourceEmployee?.id || null,
          sourceEmployeeCode: laborMatch.sourceEmployee?.employee_code || null,
          sourceEmployeeName: employeeName(laborMatch.sourceEmployee),
        } : null,
        laborCandidates: laborMatchResult.candidates.map((candidate) => ({
          matchedBy: candidate.matchedBy,
          matchedByLabel: matchLabel(candidate.matchedBy),
          confidence: candidate.confidence,
          sourceEmployeeId: candidate.sourceEmployee?.id || null,
          sourceEmployeeCode: candidate.sourceEmployee?.employee_code || null,
          sourceEmployeeName: employeeName(candidate.sourceEmployee),
          paymentTotal: amount(candidate.result.payment_total),
          netPayment: amount(candidate.result.net_payment),
        })),
        labor: labor ? {
          taxablePaymentTotal: amount(labor.taxable_payment_total),
          nonTaxablePaymentTotal: amount(labor.non_taxable_payment_total),
          paymentTotal: laborPaymentTotal,
          deductionTotal: reliableDeductionTotal(labor),
          netPayment: laborNetPayment,
        } : null,
        calculated: calculated ? {
          taxablePaymentTotal: calculated.taxablePaymentTotal,
          nonTaxablePaymentTotal: calculated.nonTaxablePaymentTotal,
          paymentTotal: calculatedPaymentTotal,
          deductionTotal: calculated.deductionTotal,
          netPayment: calculatedNetPayment,
          baseAmount: calculated.baseAmount,
          overtimeAmount: calculated.overtimeAmount,
          paidLeaveDays: calculated.paidLeaveDays,
          paidLeaveMinutes: calculated.paidLeaveMinutes,
          paidLeaveAmount: calculated.paidLeaveAmount,
          taxableAdditions: calculated.taxableAdditions,
        } : null,
        operational: punchCalculated ? {
          workDays: punchAttendance?.workDays ?? 0,
          workMinutes: punchAttendance?.workMinutes ?? 0,
          overtimeMinutes: (punchAttendance?.weekdaySaturdayOvertimeMinutes || 0) + (punchAttendance?.sundayOvertimeMinutes || 0),
          paymentTotal: punchCalculated.paymentTotal,
          deductionTotal: punchCalculated.deductionTotal,
          netPayment: punchCalculated.netPayment,
          paymentDelta: operationalPaymentDelta,
          netDelta: operationalNetDelta,
        } : null,
        hasOperationalAttendanceDifference,
        operationalPaymentDelta,
        attendanceDifferenceHints,
        laborBreakdown,
        calculatedBreakdown,
        differenceHints,
        delta: {
          paymentTotal: paymentDelta,
          netPayment: netDelta,
        },
        issue: !labor
          ? laborMatchResult.candidates.length
            ? '労務士候補あり'
            : '労務士結果なし'
          : !profile
            ? '計算設定なし'
            : calculationUnavailableReason
              ? '打刻なし'
              : laborBreakdown && !laborBreakdown.hasItemDetails
                ? '明細未取込'
              : laborMatch?.matchedBy !== 'direct' && laborMatch?.matchedBy !== 'registered_alias'
                ? '突合補正'
            : Math.abs(paymentDelta || 0) >= 1 || Math.abs(netDelta || 0) >= 1
              ? '要確認'
              : hasOperationalAttendanceDifference
                ? '勤怠差'
                : '一致',
      }
    })
    .filter((row): row is NonNullable<typeof row> => !!row)
    .sort((a, b) => {
      const issueOrder: Record<string, number> = {
        要確認: 0,
        勤怠差: 1,
        突合補正: 2,
        労務士候補あり: 3,
        打刻なし: 4,
        明細未取込: 5,
        計算設定なし: 6,
        労務士結果なし: 7,
        一致: 8,
      }
      const aIssue = issueOrder[a.issue] ?? 9
      const bIssue = issueOrder[b.issue] ?? 9
      const issueDiff = aIssue - bIssue
      if (issueDiff) return issueDiff
      return Number(a.employeeCode || 999999) - Number(b.employeeCode || 999999) || a.employeeName.localeCompare(b.employeeName, 'ja')
    })

  const comparableRows = rows.filter((row) => row.hasLaborResult && row.hasProfile && row.calculated)
  const mismatches = comparableRows.filter((row) => Math.abs(row.delta.paymentTotal || 0) >= 1 || Math.abs(row.delta.netPayment || 0) >= 1)
  const review = buildPayrollReview(rows)

  return NextResponse.json({
    periods: comparisonPeriodRows.map((period) => ({
      id: period.id,
      payrollMonth: period.payroll_month,
      payrollKind: period.payroll_kind,
      payrollKindLabel: kindLabel(period.payroll_kind),
      attendanceMonth: period.attendance_month,
      payDate: period.pay_date,
    })),
    selectedPeriod: {
      id: selectedPeriod.id,
      payrollMonth: selectedPeriod.payroll_month,
      payrollKind: selectedPeriod.payroll_kind,
      payrollKindLabel: kindLabel(selectedPeriod.payroll_kind),
      attendanceMonth: selectedPeriod.attendance_month,
      attendanceMonthEnd,
      payDate: selectedPeriod.pay_date,
    },
    summary: {
      employees: rows.length,
      compared: comparableRows.length,
      missingProfile: rows.filter((row) => row.hasLaborResult && !row.hasProfile).length,
      missingLaborResult: rows.filter((row) => !row.hasLaborResult && row.hasProfile).length,
      autoMatchedLabor: rows.filter((row) => row.laborMatch && row.laborMatch.matchedBy !== 'direct').length,
      matchCandidates: rows.filter((row) => !row.hasLaborResult && row.laborCandidates.length > 0).length,
      calculationUnavailable: rows.filter((row) => !!row.calculationUnavailableReason).length,
      paymentDeltaTotal: comparableRows.reduce((sum, row) => sum + (row.delta.paymentTotal || 0), 0),
      netDeltaTotal: comparableRows.reduce((sum, row) => sum + (row.delta.netPayment || 0), 0),
      mismatches: mismatches.length,
    },
    review,
    rows,
  })
}
