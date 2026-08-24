import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { downloadFileFromDrive } from '@/lib/drive'
import { adminClient } from '@/lib/supabase/admin'

type PayrollCell = string | number | boolean | Date | null | undefined

type ParsedPayrollItem = {
  code: string
  name: string
  itemType: 'earning' | 'deduction' | 'attendance'
  taxable: boolean
  amount: number
  minutes: number | null
  days: number | null
  rate: number | null
  sortOrder: number
  rawValue: PayrollCell
}

type ParsedPayrollResult = {
  employeeCode: string | null
  employeeName: string
  taxablePaymentTotal: number
  nonTaxablePaymentTotal: number
  paymentTotal: number
  socialInsuranceTotal: number
  deductionTotal: number
  taxableIncome: number
  netPayment: number
  cashPayment: number
  transferPayment: number
  dependentsCount: number | null
  taxTableCategory: string | null
  items: ParsedPayrollItem[]
  sourceSheet: string
}

export type LaborPayrollZipAnalysis = {
  sourceWorkbook: string
  wageLedgerWorkbook: string
  results: ParsedPayrollResult[]
  totals: {
    employeeCount: number
    taxablePaymentTotal: number
    nonTaxablePaymentTotal: number
    paymentTotal: number
    socialInsuranceTotal: number
    deductionTotal: number
    netPayment: number
  }
  reportedTotals: {
    employeeCount: number
    paymentTotal: number
    deductionTotal: number
    netPayment: number
  }
}

type EmployeeRow = {
  id: string
  user_id: string | null
  employee_code: string | null
  display_name: string
  real_name: string | null
  payroll_status: string
  raw_payload: Record<string, unknown> | null
}

type BatchRow = {
  id: string
  payroll_kind: string
  target_attendance_month: string | null
  target_payroll_month: string | null
  pay_date: string | null
  status: string
  summary: Record<string, unknown> | null
}

type PayrollProfileSeed = {
  employee_id: string
  effective_from: string
  calculation_type: 'hourly' | 'monthly_fixed' | 'monthly_with_overtime' | 'officer_fixed' | 'unknown'
  monthly_base_amount: number | null
  hourly_rate: number | null
  overtime_divisor: number | null
  weekday_saturday_overtime_multiplier: number | null
  sunday_overtime_multiplier: number | null
  scheduled_minutes: number | null
  public_holidays_per_month: number | null
  paid_leave_mode: string | null
  taxable_additions: Record<string, unknown> | null
  deduction_snapshot: Record<string, unknown> | null
  source_snapshot: Record<string, unknown> | null
}

type ItemDefinition = {
  code: string
  name: string
  itemType: ParsedPayrollItem['itemType']
  taxable: boolean
  sortOrder: number
  valueKind: 'amount' | 'minutes' | 'days' | 'rate'
}

const ITEM_DEFINITIONS: Record<string, ItemDefinition> = {
  '出勤日数': { code: 'attendance_days', name: '出勤日数', itemType: 'attendance', taxable: false, sortOrder: 1, valueKind: 'days' },
  '休日出勤日数': { code: 'holiday_work_days', name: '休日出勤日数', itemType: 'attendance', taxable: false, sortOrder: 2, valueKind: 'days' },
  '代休日数': { code: 'substitute_holiday_days', name: '代休日数', itemType: 'attendance', taxable: false, sortOrder: 3, valueKind: 'days' },
  '有給日数': { code: 'paid_leave_days', name: '有給日数', itemType: 'attendance', taxable: false, sortOrder: 4, valueKind: 'days' },
  '特別休暇日数': { code: 'special_leave_days', name: '特別休暇日数', itemType: 'attendance', taxable: false, sortOrder: 5, valueKind: 'days' },
  '欠勤日数': { code: 'absence_days', name: '欠勤日数', itemType: 'attendance', taxable: false, sortOrder: 6, valueKind: 'days' },
  '就労時間': { code: 'work_minutes', name: '就労時間', itemType: 'attendance', taxable: false, sortOrder: 7, valueKind: 'minutes' },
  '普通残業': { code: 'regular_overtime_minutes', name: '普通残業時間', itemType: 'attendance', taxable: false, sortOrder: 8, valueKind: 'minutes' },
  '深夜勤務': { code: 'night_work_minutes', name: '深夜勤務時間', itemType: 'attendance', taxable: false, sortOrder: 9, valueKind: 'minutes' },
  '休日勤務時間': { code: 'holiday_work_minutes', name: '休日勤務時間', itemType: 'attendance', taxable: false, sortOrder: 10, valueKind: 'minutes' },
  '道の駅勤務時間': { code: 'michinoeki_work_minutes', name: '道の駅勤務時間', itemType: 'attendance', taxable: false, sortOrder: 11, valueKind: 'minutes' },
  'しこん勤務時間': { code: 'shikomi_work_minutes', name: 'しこん勤務時間', itemType: 'attendance', taxable: false, sortOrder: 12, valueKind: 'minutes' },
  'ﾌﾞﾗﾝﾄﾞ館勤務': { code: 'brandhall_work_minutes', name: 'ブランド館勤務時間', itemType: 'attendance', taxable: false, sortOrder: 13, valueKind: 'minutes' },
  '研修時間': { code: 'training_minutes', name: '研修時間', itemType: 'attendance', taxable: false, sortOrder: 14, valueKind: 'minutes' },
  '遡及時間': { code: 'retroactive_minutes', name: '遡及時間', itemType: 'attendance', taxable: false, sortOrder: 15, valueKind: 'minutes' },
  '早出時間': { code: 'early_work_minutes', name: '早出時間', itemType: 'attendance', taxable: false, sortOrder: 16, valueKind: 'minutes' },
  '遅早回数': { code: 'late_early_count', name: '遅刻早退回数', itemType: 'attendance', taxable: false, sortOrder: 17, valueKind: 'days' },
  '遅早時間': { code: 'late_early_minutes', name: '遅刻早退時間', itemType: 'attendance', taxable: false, sortOrder: 18, valueKind: 'minutes' },
  '法定休日勤務時間': { code: 'statutory_holiday_work_minutes', name: '法定休日勤務時間', itemType: 'attendance', taxable: false, sortOrder: 19, valueKind: 'minutes' },
  '土日祝勤務': { code: 'weekend_holiday_work_minutes', name: '土日祝勤務時間', itemType: 'attendance', taxable: false, sortOrder: 22, valueKind: 'minutes' },
  '月60時間超残業': { code: 'over_60h_overtime_minutes', name: '月60時間超残業時間', itemType: 'attendance', taxable: false, sortOrder: 23, valueKind: 'minutes' },
  '本給': { code: 'regular_salary', name: '本給単価', itemType: 'earning', taxable: true, sortOrder: 20, valueKind: 'rate' },
  '基本給': { code: 'base_salary', name: '基本給', itemType: 'earning', taxable: true, sortOrder: 10, valueKind: 'amount' },
  '土日祝勤手当': { code: 'weekend_holiday_allowance', name: '土日祝勤手当', itemType: 'earning', taxable: true, sortOrder: 30, valueKind: 'amount' },
  '特別手当': { code: 'special_allowance', name: '特別手当', itemType: 'earning', taxable: true, sortOrder: 40, valueKind: 'amount' },
  '技能手当': { code: 'skill_allowance', name: '技能手当', itemType: 'earning', taxable: true, sortOrder: 50, valueKind: 'amount' },
  '住宅手当': { code: 'housing_allowance', name: '住宅手当', itemType: 'earning', taxable: true, sortOrder: 60, valueKind: 'amount' },
  '育児手当': { code: 'childcare_allowance', name: '育児手当', itemType: 'earning', taxable: true, sortOrder: 70, valueKind: 'amount' },
  '課税通勤手当': { code: 'taxable_commute', name: '課税通勤手当', itemType: 'earning', taxable: true, sortOrder: 80, valueKind: 'amount' },
  '超過勤務手当': { code: 'overtime_allowance', name: '超過勤務手当', itemType: 'earning', taxable: true, sortOrder: 90, valueKind: 'amount' },
  '遡及手当': { code: 'retroactive_allowance', name: '遡及手当', itemType: 'earning', taxable: true, sortOrder: 110, valueKind: 'amount' },
  '深夜手当': { code: 'night_allowance', name: '深夜手当', itemType: 'earning', taxable: true, sortOrder: 120, valueKind: 'amount' },
  '休日出勤手当': { code: 'holiday_work_allowance', name: '休日出勤手当', itemType: 'earning', taxable: true, sortOrder: 130, valueKind: 'amount' },
  '基本給2': { code: 'base_salary_2', name: '基本給2', itemType: 'earning', taxable: true, sortOrder: 140, valueKind: 'amount' },
  'GW特別手当': { code: 'gw_special_allowance', name: 'GW特別手当', itemType: 'earning', taxable: true, sortOrder: 150, valueKind: 'amount' },
  '有給買取手当': { code: 'paid_leave_buyout', name: '有給買取手当', itemType: 'earning', taxable: true, sortOrder: 160, valueKind: 'amount' },
  '欠勤控除': { code: 'absence_deduction', name: '欠勤控除', itemType: 'earning', taxable: true, sortOrder: 170, valueKind: 'amount' },
  '遅早控除': { code: 'late_early_deduction', name: '遅早控除', itemType: 'earning', taxable: true, sortOrder: 180, valueKind: 'amount' },
  'お盆特別手当': { code: 'obon_special_allowance', name: 'お盆特別手当', itemType: 'earning', taxable: true, sortOrder: 190, valueKind: 'amount' },
  'コロナ休業手当': { code: 'covid_leave_allowance', name: 'コロナ休業手当', itemType: 'earning', taxable: true, sortOrder: 200, valueKind: 'amount' },
  '慰労金': { code: 'solatium', name: '慰労金', itemType: 'earning', taxable: true, sortOrder: 240, valueKind: 'amount' },
  '非課税通勤手当': { code: 'non_taxable_commute', name: '非課税通勤手当', itemType: 'earning', taxable: false, sortOrder: 250, valueKind: 'amount' },
  '解雇予告手当': { code: 'dismissal_notice_allowance', name: '解雇予告手当', itemType: 'earning', taxable: false, sortOrder: 260, valueKind: 'amount' },
  '健康保険': { code: 'health_insurance', name: '健康保険', itemType: 'deduction', taxable: false, sortOrder: 310, valueKind: 'amount' },
  '介護保険': { code: 'care_insurance', name: '介護保険', itemType: 'deduction', taxable: false, sortOrder: 320, valueKind: 'amount' },
  '子ども子育て支援金': { code: 'child_childcare_contribution', name: '子ども子育て支援金', itemType: 'deduction', taxable: false, sortOrder: 330, valueKind: 'amount' },
  '厚生年金': { code: 'welfare_pension', name: '厚生年金', itemType: 'deduction', taxable: false, sortOrder: 340, valueKind: 'amount' },
  '雇用保険': { code: 'employment_insurance', name: '雇用保険', itemType: 'deduction', taxable: false, sortOrder: 350, valueKind: 'amount' },
  '調整保険': { code: 'insurance_adjustment', name: '調整保険', itemType: 'deduction', taxable: false, sortOrder: 360, valueKind: 'amount' },
  '所得税': { code: 'income_tax', name: '所得税', itemType: 'deduction', taxable: false, sortOrder: 370, valueKind: 'amount' },
  '住民税': { code: 'resident_tax', name: '住民税', itemType: 'deduction', taxable: false, sortOrder: 380, valueKind: 'amount' },
  'その他控除': { code: 'other_deduction', name: 'その他控除', itemType: 'deduction', taxable: false, sortOrder: 385, valueKind: 'amount' },
  '社宅家賃': { code: 'company_housing_rent', name: '社宅家賃', itemType: 'deduction', taxable: false, sortOrder: 390, valueKind: 'amount' },
  '年調精算額': { code: 'year_end_adjustment', name: '年調精算額', itemType: 'deduction', taxable: false, sortOrder: 400, valueKind: 'amount' },
}

const TOTAL_LABELS = new Set([
  '課税支給合計', '非課税支給合計', '支給合計', '社保控除合計', '課税対象額',
  '定額減税', 'その他控除合計', '控除合計', '差引支給額', '現金支給額',
  '振込支給額', '税制扶養数', '税表区分',
])

const KNOWN_EMPLOYEE_NAME_ALIASES = new Map([
  ['内海美穂', '生井美穂'],
  ['佐藤葵(女性)', '佐藤葵(フロア)'],
  ['佐藤葵(男性)', '佐藤葵(製造)'],
])

const BASE_EARNING_CODES = new Set(['base_salary', 'regular_salary'])
const OVERTIME_EARNING_CODES = new Set([
  'weekday_saturday_overtime',
  'sunday_overtime',
  'overtime_allowance',
  'night_allowance',
  'holiday_work_allowance',
  'over_60h_overtime',
])

function normalizedName(value: unknown) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .replace(/[・･]/g, '')
}

function fileBaseName(value: string) {
  return value.replace(/\\/g, '/').split('/').pop() || value
}

function numberValue(value: PayrollCell) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return 0
  if (value.trim() === '非加入') return 0
  const matched = value.match(/-?[\d,]+(?:\.\d+)?/)
  const normalized = (matched?.[0] || '').replace(/,/g, '')
  if (!normalized) return 0
  const next = Number(normalized)
  return Number.isFinite(next) ? next : 0
}

function itemByCode(result: ParsedPayrollResult, code: string) {
  return result.items.find((item) => item.code === code) || null
}

function profileForImportedResult(
  result: ParsedPayrollResult,
  employee: EmployeeRow,
  payrollMonth: string,
  prior: PayrollProfileSeed | null,
) {
  const baseSalary = itemByCode(result, 'base_salary')?.amount || 0
  const hourlyRate = itemByCode(result, 'regular_salary')?.rate || 0
  const overtimeAmount = result.items
    .filter((item) => OVERTIME_EARNING_CODES.has(item.code))
    .reduce((sum, item) => sum + item.amount, 0)
  const inferredType = ['1', '2'].includes(String(employee.employee_code || ''))
    ? 'officer_fixed'
    : hourlyRate > 0
      ? 'hourly'
      : baseSalary > 0 && overtimeAmount !== 0
        ? 'monthly_with_overtime'
        : baseSalary > 0
          ? 'monthly_fixed'
          : 'unknown'
  const calculationType = prior?.calculation_type && prior.calculation_type !== 'unknown'
    ? prior.calculation_type
    : inferredType
  const taxableAdditions = Object.fromEntries(result.items
    .filter((item) => item.itemType === 'earning' && item.taxable && item.amount !== 0)
    .filter((item) => !BASE_EARNING_CODES.has(item.code) && !OVERTIME_EARNING_CODES.has(item.code))
    .map((item) => [item.code, item.amount]))
  const deductions = Object.fromEntries(result.items
    .filter((item) => item.itemType === 'deduction' && item.amount !== 0)
    .map((item) => [item.code, item.amount]))
  const workDays = itemByCode(result, 'attendance_days')?.days || 0
  const workMinutes = itemByCode(result, 'work_minutes')?.minutes || 0
  const weekdayOvertimeMinutes = itemByCode(result, 'weekday_saturday_overtime_minutes')?.minutes
    || itemByCode(result, 'regular_overtime_minutes')?.minutes
    || 0
  const sundayOvertimeMinutes = itemByCode(result, 'sunday_overtime_minutes')?.minutes || 0
  const weekdayOvertimeAmount = itemByCode(result, 'weekday_saturday_overtime')?.amount || 0
  const sundayOvertimeAmount = itemByCode(result, 'sunday_overtime')?.amount || 0
  const priorSource = objectValue(prior?.source_snapshot)
  const weekdayOvertimeHourlyRate = weekdayOvertimeMinutes > 0
    ? weekdayOvertimeAmount / (weekdayOvertimeMinutes / 60)
    : numberValue(priorSource.weekday_saturday_overtime_hourly_rate as PayrollCell)
  const sundayOvertimeHourlyRate = sundayOvertimeMinutes > 0
    ? sundayOvertimeAmount / (sundayOvertimeMinutes / 60)
    : numberValue(priorSource.sunday_overtime_hourly_rate as PayrollCell)

  return {
    employee_id: employee.id,
    effective_from: payrollMonth,
    calculation_type: calculationType,
    monthly_base_amount: baseSalary || prior?.monthly_base_amount || null,
    hourly_rate: hourlyRate || prior?.hourly_rate || null,
    overtime_divisor: prior?.overtime_divisor || null,
    weekday_saturday_overtime_multiplier: prior?.weekday_saturday_overtime_multiplier || 1.25,
    sunday_overtime_multiplier: prior?.sunday_overtime_multiplier || 1.35,
    scheduled_minutes: prior?.scheduled_minutes || null,
    public_holidays_per_month: prior?.public_holidays_per_month || null,
    paid_leave_mode: prior?.paid_leave_mode || null,
    taxable_additions: taxableAdditions,
    deduction_snapshot: deductions,
    source_snapshot: {
      source: 'labor_payroll_zip',
      source_employee_name: result.employeeName,
      employee_code: result.employeeCode,
      payroll_month: payrollMonth,
      base_payment_amount: baseSalary,
      work_days: workDays,
      work_minutes: workMinutes,
      weekday_saturday_overtime_minutes: weekdayOvertimeMinutes,
      sunday_overtime_minutes: sundayOvertimeMinutes,
      weekday_saturday_overtime_hourly_rate: weekdayOvertimeHourlyRate,
      sunday_overtime_hourly_rate: sundayOvertimeHourlyRate,
      taxable_payment_total: result.taxablePaymentTotal,
      non_taxable_payment_total: result.nonTaxablePaymentTotal,
      payment_total: result.paymentTotal,
      deduction_total: result.deductionTotal,
      net_payment: result.netPayment,
      employment_insurance: deductions.employment_insurance || 0,
      dependents_count: result.dependentsCount,
      tax_table_category: result.taxTableCategory,
      learned_at: new Date().toISOString(),
    },
  }
}

function minutesValue(value: PayrollCell) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? value : Math.round(value * 24 * 60)
  }
  const text = String(value || '').trim()
  const match = text.match(/^(-?)(\d{1,4}):(\d{2})$/)
  if (!match) return 0
  const sign = match[1] ? -1 : 1
  return sign * (Number(match[2]) * 60 + Number(match[3]))
}

function sheetRows(workbook: XLSX.WorkBook, sheetName: string) {
  const sheet = workbook.Sheets[sheetName]
  return XLSX.utils.sheet_to_json<PayrollCell[]>(sheet, {
    header: 1,
    defval: null,
    raw: true,
  })
}

function workbookFromBuffer(buffer: Buffer) {
  return XLSX.read(buffer, { type: 'buffer', cellDates: true })
}

async function findWorkbook(zip: JSZip, predicate: (name: string) => boolean) {
  const entry = Object.values(zip.files).find((file) => !file.dir && predicate(fileBaseName(file.name)))
  if (!entry) return null
  return { name: entry.name, buffer: Buffer.from(await entry.async('uint8array')) }
}

function employeeCodesFromWageLedger(workbook: XLSX.WorkBook) {
  const byName = new Map<string, string>()
  for (const sheetName of workbook.SheetNames) {
    const match = sheetName.match(/^\((\d+)\)(.+)$/)
    if (!match) continue
    byName.set(normalizedName(match[2]), String(Number(match[1])))
  }
  return byName
}

function itemDefinition(label: string, rowIndex: number): ItemDefinition | null {
  if (label === '平日土曜残業') {
    return rowIndex < 35
      ? { code: 'weekday_saturday_overtime_minutes', name: '平日土曜残業時間', itemType: 'attendance', taxable: false, sortOrder: 20, valueKind: 'minutes' }
      : { code: 'weekday_saturday_overtime', name: '平日土曜残業手当', itemType: 'earning', taxable: true, sortOrder: 210, valueKind: 'amount' }
  }
  if (label === '日曜残業') {
    return rowIndex < 35
      ? { code: 'sunday_overtime_minutes', name: '日曜残業時間', itemType: 'attendance', taxable: false, sortOrder: 21, valueKind: 'minutes' }
      : { code: 'sunday_overtime', name: '日曜残業手当', itemType: 'earning', taxable: true, sortOrder: 220, valueKind: 'amount' }
  }
  if (label === '月60時間超手当') {
    return { code: 'over_60h_overtime', name: '月60時間超手当', itemType: 'earning', taxable: true, sortOrder: 230, valueKind: 'amount' }
  }
  return ITEM_DEFINITIONS[label] || null
}

function parsePayrollItems(rows: PayrollCell[][], column: number) {
  const items: ParsedPayrollItem[] = []
  for (let rowIndex = 6; rowIndex < rows.length; rowIndex += 1) {
    const label = String(rows[rowIndex]?.[0] || '').trim()
    const rawValue = rows[rowIndex]?.[column]
    if (!label || rawValue === null || rawValue === undefined || rawValue === '' || TOTAL_LABELS.has(label)) continue
    const definition = itemDefinition(label, rowIndex + 1)
    if (!definition) continue
    const numeric = numberValue(rawValue)
    const minutes = definition.valueKind === 'minutes' ? minutesValue(rawValue) : null
    const days = definition.valueKind === 'days' ? numeric : null
    const rate = definition.valueKind === 'rate' ? numeric : null
    const amount = definition.valueKind === 'amount' ? numeric : 0
    if (!amount && !minutes && !days && !rate && rawValue !== '非加入') continue
    items.push({
      code: definition.code,
      name: definition.name,
      itemType: definition.itemType,
      taxable: definition.taxable,
      amount,
      minutes,
      days,
      rate,
      sortOrder: definition.sortOrder,
      rawValue,
    })
  }
  return items
}

function rowValue(rows: PayrollCell[][], label: string, column: number) {
  const row = rows.find((candidate) => String(candidate?.[0] || '').trim() === label)
  return row?.[column]
}

export async function parseLaborPayrollZip(buffer: Buffer): Promise<LaborPayrollZipAnalysis> {
  const zip = await JSZip.loadAsync(buffer, {
    decodeFileName: (bytes) => {
      const encoded = bytes instanceof Uint8Array
        ? bytes
        : Uint8Array.from(Array.from(bytes, (value) => (
          typeof value === 'number' ? value : String(value).charCodeAt(0)
        )))
      return new TextDecoder('shift_jis').decode(encoded)
    },
  })
  const payrollWorkbookFile = await findWorkbook(zip, (name) => /支給控除一覧表\.xlsx$/i.test(name))
  const wageLedgerFile = await findWorkbook(zip, (name) => /賃金台帳\.xlsx$/i.test(name) && !name.includes('全社計'))
  if (!payrollWorkbookFile) throw new Error('ZIP内に支給控除一覧表.xlsxが見つかりません')
  if (!wageLedgerFile) throw new Error('ZIP内に社員別の賃金台帳.xlsxが見つかりません')

  const payrollWorkbook = workbookFromBuffer(payrollWorkbookFile.buffer)
  const wageLedgerWorkbook = workbookFromBuffer(wageLedgerFile.buffer)
  const employeeCodeByName = employeeCodesFromWageLedger(wageLedgerWorkbook)
  const results: ParsedPayrollResult[] = []
  let reportedTotals = { employeeCount: 0, paymentTotal: 0, deductionTotal: 0, netPayment: 0 }

  for (const sheetName of payrollWorkbook.SheetNames) {
    const rows = sheetRows(payrollWorkbook, sheetName)
    for (let column = 1; column < Math.min(6, rows[5]?.length || 0); column += 1) {
      const employeeName = String(rows[5]?.[column] || '').trim()
      if (!employeeName || !normalizedName(employeeName) || /名$/.test(employeeName)) continue
      const paymentTotal = numberValue(rowValue(rows, '支給合計', column))
      const netPayment = numberValue(rowValue(rows, '差引支給額', column))
      if (!paymentTotal && !netPayment) continue
      results.push({
        employeeCode: employeeCodeByName.get(normalizedName(employeeName)) || null,
        employeeName,
        taxablePaymentTotal: numberValue(rowValue(rows, '課税支給合計', column)),
        nonTaxablePaymentTotal: numberValue(rowValue(rows, '非課税支給合計', column)),
        paymentTotal,
        socialInsuranceTotal: numberValue(rowValue(rows, '社保控除合計', column)),
        deductionTotal: numberValue(rowValue(rows, '控除合計', column)),
        taxableIncome: numberValue(rowValue(rows, '課税対象額', column)),
        netPayment,
        cashPayment: numberValue(rowValue(rows, '現金支給額', column)),
        transferPayment: numberValue(rowValue(rows, '振込支給額', column)),
        dependentsCount: rowValue(rows, '税制扶養数', column) === null ? null : numberValue(rowValue(rows, '税制扶養数', column)),
        taxTableCategory: String(rowValue(rows, '税表区分', column) || '').trim() || null,
        items: parsePayrollItems(rows, column),
        sourceSheet: sheetName,
      })
    }

    const totalColumn = 5
    const totalEmployees = numberValue(rows[5]?.[totalColumn])
    const totalPayment = numberValue(rowValue(rows, '支給合計', totalColumn))
    if (totalEmployees >= reportedTotals.employeeCount && totalPayment >= reportedTotals.paymentTotal) {
      reportedTotals = {
        employeeCount: totalEmployees,
        paymentTotal: totalPayment,
        deductionTotal: numberValue(rowValue(rows, '控除合計', totalColumn)),
        netPayment: numberValue(rowValue(rows, '差引支給額', totalColumn)),
      }
    }
  }

  const totals = results.reduce((summary, result) => ({
    employeeCount: summary.employeeCount + 1,
    taxablePaymentTotal: summary.taxablePaymentTotal + result.taxablePaymentTotal,
    nonTaxablePaymentTotal: summary.nonTaxablePaymentTotal + result.nonTaxablePaymentTotal,
    paymentTotal: summary.paymentTotal + result.paymentTotal,
    socialInsuranceTotal: summary.socialInsuranceTotal + result.socialInsuranceTotal,
    deductionTotal: summary.deductionTotal + result.deductionTotal,
    netPayment: summary.netPayment + result.netPayment,
  }), {
    employeeCount: 0,
    taxablePaymentTotal: 0,
    nonTaxablePaymentTotal: 0,
    paymentTotal: 0,
    socialInsuranceTotal: 0,
    deductionTotal: 0,
    netPayment: 0,
  })

  if (
    totals.employeeCount !== reportedTotals.employeeCount
    || totals.paymentTotal !== reportedTotals.paymentTotal
    || totals.deductionTotal !== reportedTotals.deductionTotal
    || totals.netPayment !== reportedTotals.netPayment
  ) {
    throw new Error(`支給控除一覧表の社員別合計が全社計と一致しません（社員 ${totals.employeeCount}/${reportedTotals.employeeCount}、支給 ${totals.paymentTotal}/${reportedTotals.paymentTotal}、控除 ${totals.deductionTotal}/${reportedTotals.deductionTotal}、差引 ${totals.netPayment}/${reportedTotals.netPayment}）`)
  }
  if (results.some((result) => !result.employeeCode)) {
    const names = results.filter((result) => !result.employeeCode).map((result) => result.employeeName)
    throw new Error(`賃金台帳から社員NOを特定できません: ${names.join('、')}`)
  }

  return {
    sourceWorkbook: payrollWorkbookFile.name,
    wageLedgerWorkbook: wageLedgerFile.name,
    results,
    totals,
    reportedTotals,
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function aliasTargetId(employee: EmployeeRow) {
  const aliasOf = objectValue(employee.raw_payload?.payroll_alias_of)
  return typeof aliasOf.employee_id === 'string' ? aliasOf.employee_id : null
}

function payrollAliases(employee: EmployeeRow) {
  const hrProfile = objectValue(employee.raw_payload?.hr_profile)
  return Array.isArray(hrProfile.payroll_name_aliases)
    ? hrProfile.payroll_name_aliases.map(objectValue)
    : []
}

function matchEmployees(results: ParsedPayrollResult[], employees: EmployeeRow[]) {
  const byId = new Map(employees.map((employee) => [employee.id, employee]))
  const activeEmployees = employees.filter((employee) => employee.payroll_status === 'active' || employee.user_id)
  const matches = results.map((result) => {
    const byCode = employees.find((employee) => employee.employee_code === result.employeeCode)
    const canonicalAliasName = KNOWN_EMPLOYEE_NAME_ALIASES.get(normalizedName(result.employeeName))
    const byKnownName = canonicalAliasName
      ? activeEmployees.find((employee) => (
        normalizedName(employee.real_name || employee.display_name) === canonicalAliasName
        || normalizedName(employee.display_name) === canonicalAliasName
      ))
      : null
    const byRegisteredAlias = activeEmployees.find((employee) => payrollAliases(employee).some((alias) => (
      String(alias.employee_code || '') === result.employeeCode
      || normalizedName(alias.name) === normalizedName(result.employeeName)
    )))
    const byName = activeEmployees.find((employee) => (
      normalizedName(employee.real_name || employee.display_name) === normalizedName(result.employeeName)
      || normalizedName(employee.display_name) === normalizedName(result.employeeName)
    ))
    const source = byRegisteredAlias || byKnownName || byCode || byName || null
    const targetId = source ? aliasTargetId(source) || source.id : null
    return { result, employee: targetId ? byId.get(targetId) || source : null }
  })
  const missing = matches.filter((match) => !match.employee)
  if (missing.length) {
    throw new Error(`人事マスタに紐付かない社員があります: ${missing.map((match) => `${match.result.employeeCode} ${match.result.employeeName}`).join('、')}`)
  }
  const duplicateIds = matches
    .map((match) => match.employee?.id || '')
    .filter((id, index, values) => id && values.indexOf(id) !== index)
  if (duplicateIds.length) throw new Error('複数の労務士明細が同じ社員へ重複紐付けされています')
  return matches as Array<{ result: ParsedPayrollResult; employee: EmployeeRow }>
}

export async function analyzeLaborImportBatch(batchId: string, zipBuffer?: Buffer) {
  const { data: batchData, error: batchError } = await adminClient
    .from('gw_labor_import_batches')
    .select('id, payroll_kind, target_attendance_month, target_payroll_month, pay_date, status, summary')
    .eq('id', batchId)
    .single()
  if (batchError || !batchData) throw new Error(batchError?.message || '労務取込バッチが見つかりません')
  const batch = batchData as BatchRow
  const summary = batch.summary || {}
  const driveFileId = typeof summary.zipDriveFileId === 'string' ? summary.zipDriveFileId : ''
  const sourceBuffer = zipBuffer || (driveFileId ? await downloadFileFromDrive(driveFileId) : null)
  if (!sourceBuffer) throw new Error('取込元ZIPが保存されていません。ZIPを再登録してください')

  const analysis = await parseLaborPayrollZip(sourceBuffer)
  const { data: period, error: periodError } = await adminClient
    .from('gw_payroll_periods')
    .select('id')
    .eq('payroll_month', batch.target_payroll_month)
    .eq('payroll_kind', batch.payroll_kind)
    .single()
  if (periodError || !period) throw new Error(periodError?.message || '対象給与期間が見つかりません')

  const { data: employeesData, error: employeesError } = await adminClient
    .from('gw_payroll_employees')
    .select('id, user_id, employee_code, display_name, real_name, payroll_status, raw_payload')
  if (employeesError) throw new Error(employeesError.message)
  const matches = matchEmployees(analysis.results, (employeesData || []) as EmployeeRow[])

  const payrollMonth = batch.target_payroll_month
  if (!payrollMonth) throw new Error('支給月が設定されていません')
  const { data: profileData, error: profileError } = await adminClient
    .from('gw_payroll_calculation_profiles')
    .select('employee_id, effective_from, calculation_type, monthly_base_amount, hourly_rate, overtime_divisor, weekday_saturday_overtime_multiplier, sunday_overtime_multiplier, scheduled_minutes, public_holidays_per_month, paid_leave_mode, taxable_additions, deduction_snapshot, source_snapshot')
    .lte('effective_from', payrollMonth)
    .order('effective_from', { ascending: false })
  if (profileError) throw new Error(profileError.message)
  const priorProfileByEmployee = new Map<string, PayrollProfileSeed>()
  for (const profile of (profileData || []) as PayrollProfileSeed[]) {
    if (!priorProfileByEmployee.has(profile.employee_id)) priorProfileByEmployee.set(profile.employee_id, profile)
  }

  const { data: sourceDocuments, error: documentsError } = await adminClient
    .from('gw_labor_source_documents')
    .select('id, file_name')
    .eq('import_batch_id', batch.id)
  if (documentsError) throw new Error(documentsError.message)
  const sourceDocumentId = (sourceDocuments || []).find((document) => /支給控除一覧表\.xlsx$/i.test(document.file_name))?.id || null

  const itemDefinitions = Array.from(new Map(
    analysis.results.flatMap((result) => result.items).map((item) => [item.code, item]),
  ).values()).map((item) => ({
    code: item.code,
    name: item.name,
    item_type: item.itemType,
    taxable: item.taxable,
    is_system: true,
    sort_order: item.sortOrder,
    raw_payload: { source: 'labor_payroll_zip' },
  }))
  const { data: itemRows, error: itemError } = await adminClient
    .from('gw_payroll_items')
    .upsert(itemDefinitions, { onConflict: 'code' })
    .select('id, code')
  if (itemError) throw new Error(itemError.message)
  const itemIdByCode = new Map((itemRows || []).map((item) => [item.code, item.id]))

  const runSummary = {
    source: 'labor_payroll_zip',
    verifiedAgainstWorkbookTotal: true,
    resultCount: analysis.totals.employeeCount,
    paymentTotal: analysis.totals.paymentTotal,
    deductionTotal: analysis.totals.deductionTotal,
    netPayment: analysis.totals.netPayment,
    sourceWorkbook: analysis.sourceWorkbook,
  }
  const { data: run, error: runError } = await adminClient
    .from('gw_payroll_runs')
    .upsert({
      payroll_period_id: period.id,
      source_import_batch_id: batch.id,
      run_number: 1,
      status: 'calculated',
      calculation_mode: 'imported',
      summary: runSummary,
    }, { onConflict: 'payroll_period_id,run_number' })
    .select('id')
    .single()
  if (runError || !run) throw new Error(runError?.message || '給与取込実行を保存できません')

  const resultPayload = matches.map(({ result, employee }) => ({
    payroll_run_id: run.id,
    payroll_period_id: period.id,
    employee_id: employee.id,
    taxable_payment_total: result.taxablePaymentTotal,
    non_taxable_payment_total: result.nonTaxablePaymentTotal,
    payment_total: result.paymentTotal,
    social_insurance_total: result.socialInsuranceTotal,
    deduction_total: result.deductionTotal,
    taxable_income: result.taxableIncome,
    net_payment: result.netPayment,
    cash_payment: result.cashPayment,
    transfer_payment: result.transferPayment,
    dependents_count: result.dependentsCount,
    tax_table_category: result.taxTableCategory,
    source_document_id: sourceDocumentId,
    raw_payload: {
      source: 'labor_payroll_zip',
      employeeCode: result.employeeCode,
      sourceEmployeeName: result.employeeName,
      sourceSheet: result.sourceSheet,
      verifiedAgainstWorkbookTotal: true,
    },
  }))
  const { data: savedResults, error: resultError } = await adminClient
    .from('gw_payroll_employee_results')
    .upsert(resultPayload, { onConflict: 'payroll_run_id,employee_id' })
    .select('id, employee_id')
  if (resultError) throw new Error(resultError.message)

  const savedResultIds = (savedResults || []).map((result) => result.id)
  if (savedResultIds.length) {
    const { error: deleteItemsError } = await adminClient
      .from('gw_payroll_result_items')
      .delete()
      .in('payroll_result_id', savedResultIds)
    if (deleteItemsError) throw new Error(deleteItemsError.message)
  }
  const resultIdByEmployee = new Map((savedResults || []).map((result) => [result.employee_id, result.id]))
  const detailPayload = matches.flatMap(({ result, employee }) => result.items.flatMap((item) => {
    const payrollItemId = itemIdByCode.get(item.code)
    const payrollResultId = resultIdByEmployee.get(employee.id)
    if (!payrollItemId || !payrollResultId) return []
    return [{
      payroll_result_id: payrollResultId,
      payroll_item_id: payrollItemId,
      amount: item.amount,
      minutes: item.minutes,
      days: item.days,
      rate: item.rate,
      source_document_id: sourceDocumentId,
      raw_payload: { source: 'labor_payroll_zip', rawValue: item.rawValue },
    }]
  }))
  if (detailPayload.length) {
    const { error: detailError } = await adminClient
      .from('gw_payroll_result_items')
      .insert(detailPayload)
    if (detailError) throw new Error(detailError.message)
  }

  const profilePayload = matches.map(({ result, employee }) => profileForImportedResult(
    result,
    employee,
    payrollMonth,
    priorProfileByEmployee.get(employee.id) || null,
  ))
  const { error: profileUpsertError } = await adminClient
    .from('gw_payroll_calculation_profiles')
    .upsert(profilePayload, { onConflict: 'employee_id,effective_from' })
  if (profileUpsertError) throw new Error(profileUpsertError.message)

  const currentResultIds = new Set(savedResultIds)
  const { data: existingResults, error: existingError } = await adminClient
    .from('gw_payroll_employee_results')
    .select('id')
    .eq('payroll_run_id', run.id)
  if (existingError) throw new Error(existingError.message)
  const staleIds = (existingResults || []).map((result) => result.id).filter((id) => !currentResultIds.has(id))
  if (staleIds.length) {
    const { error: staleError } = await adminClient.from('gw_payroll_employee_results').delete().in('id', staleIds)
    if (staleError) throw new Error(staleError.message)
  }

  const completedAt = new Date().toISOString()
  const { error: sourceUpdateError } = await adminClient
    .from('gw_labor_source_documents')
    .update({
      extraction_status: 'partial',
      extraction_notes: '原文保存済み。給与比較に必要な支給控除一覧表・賃金台帳を解析済み。',
      updated_at: completedAt,
    })
    .eq('import_batch_id', batch.id)
  if (sourceUpdateError) throw new Error(sourceUpdateError.message)
  const parsedDocumentIds = (sourceDocuments || [])
    .filter((document) => /支給控除一覧表\.xlsx$/i.test(document.file_name) || /賃金台帳\.xlsx$/i.test(document.file_name))
    .map((document) => document.id)
  if (parsedDocumentIds.length) {
    const { error: parsedDocumentsError } = await adminClient
      .from('gw_labor_source_documents')
      .update({
        extraction_status: 'extracted',
        extraction_notes: 'Excelを社員NO基準で解析し、社員別給与結果・明細を取込済み。',
        updated_at: completedAt,
      })
      .in('id', parsedDocumentIds)
    if (parsedDocumentsError) throw new Error(parsedDocumentsError.message)
  }

  const nextSummary = {
    ...summary,
    analysisStage: 'completed',
    requiresExtraction: false,
    completedAt,
    payrollPeriodId: period.id,
    sourceWorkbook: analysis.sourceWorkbook,
    wageLedgerWorkbook: analysis.wageLedgerWorkbook,
    verifiedAgainstWorkbookTotal: true,
    resultCount: analysis.totals.employeeCount,
    paymentTotal: analysis.totals.paymentTotal,
    deductionTotal: analysis.totals.deductionTotal,
    netPayment: analysis.totals.netPayment,
  }
  const { error: batchUpdateError } = await adminClient
    .from('gw_labor_import_batches')
    .update({ status: 'imported', summary: nextSummary })
    .eq('id', batch.id)
  if (batchUpdateError) throw new Error(batchUpdateError.message)

  return {
    ok: true,
    batchId: batch.id,
    payrollPeriodId: period.id,
    employeeCount: analysis.totals.employeeCount,
    paymentTotal: analysis.totals.paymentTotal,
    deductionTotal: analysis.totals.deductionTotal,
    netPayment: analysis.totals.netPayment,
    detailCount: detailPayload.length,
    verifiedAgainstWorkbookTotal: true,
  }
}
