import { NextResponse } from 'next/server'
import { getManagementPermissions } from '@/lib/management-permissions'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'
import { DEFAULT_USER_DEPARTMENT, USER_DEPARTMENTS, type UserDepartment } from '@/lib/departments'

type PeriodRow = {
  id: string
  payroll_month: string
  payroll_kind: string
  pay_date: string
  attendance_month: string | null
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

type EmployeeRow = {
  id: string
  employee_code: string | null
  display_name: string
  real_name: string | null
  department: string | null
  default_workplace_id: string | null
}

type WorkplaceRow = {
  id: string
  code: string
  name: string
  department: string | null
}

type AllocationRow = {
  payroll_period_id: string
  workplace_id: string | null
  allocation_key: string
  amount: number | string | null
}

function amount(value: number | string | null | undefined) {
  const next = Number(value || 0)
  return Number.isFinite(next) ? next : 0
}

function reliableDeductionTotal(result: ResultRow) {
  const stated = amount(result.deduction_total)
  const derived = amount(result.payment_total) - amount(result.net_payment)
  return Math.abs(stated - derived) <= 1 ? stated : derived
}

function periodKey(period: PeriodRow) {
  return `${period.payroll_month}:${period.payroll_kind}`
}

function kindLabel(kind: string) {
  if (kind === 'bonus') return '賞与'
  if (kind === 'adjustment') return '調整'
  return '給与'
}

function tsgDepartmentFromText(value: string | null | undefined): UserDepartment | null {
  if (!value) return null
  if (USER_DEPARTMENTS.includes(value as UserDepartment)) return value as UserDepartment
  if (value.includes('道の駅')) return '道の駅'
  if (value.includes('フロア') || value.includes('売上') || value.includes('ブランド館')) return 'フロア'
  if (value.includes('製造') || value.includes('本社')) return '製造'
  return null
}

function payrollOrganization(employee: EmployeeRow, workplace: WorkplaceRow | null) {
  return (
    tsgDepartmentFromText(employee.department) ||
    tsgDepartmentFromText(workplace?.department) ||
    tsgDepartmentFromText(workplace?.name) ||
    DEFAULT_USER_DEPARTMENT
  )
}

const departmentOrder: Record<UserDepartment, number> = {
  フロア: 0,
  製造: 1,
  道の駅: 2,
}

export async function GET() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const permissions = getManagementPermissions(user)
  if (!permissions.canViewPayroll) {
    return NextResponse.json({ error: '給与閲覧権限が必要です' }, { status: 403 })
  }

  const [
    { data: periods, error: periodsError },
    { data: results, error: resultsError },
    { data: employees, error: employeesError },
    { data: workplaces, error: workplacesError },
    { data: allocations, error: allocationsError },
  ] = await Promise.all([
    adminClient
      .from('gw_payroll_periods')
      .select('id, payroll_month, payroll_kind, pay_date, attendance_month')
      .order('payroll_month', { ascending: false })
      .order('payroll_kind', { ascending: true }),
    adminClient
      .from('gw_payroll_employee_results')
      .select('id, payroll_period_id, employee_id, taxable_payment_total, non_taxable_payment_total, payment_total, social_insurance_total, deduction_total, taxable_income, net_payment'),
    adminClient
      .from('gw_payroll_employees')
      .select('id, employee_code, display_name, real_name, department, default_workplace_id'),
    adminClient
      .from('gw_workplaces')
      .select('id, code, name, department'),
    adminClient
      .from('gw_payroll_cost_allocations')
      .select('payroll_period_id, workplace_id, allocation_key, amount'),
  ])

  const dbError = periodsError || resultsError || employeesError || workplacesError || allocationsError
  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  const periodMap = new Map((periods || []).map((row) => [row.id, row as PeriodRow]))
  const employeeMap = new Map((employees || []).map((row) => [row.id, row as EmployeeRow]))
  const workplaceMap = new Map((workplaces || []).map((row) => [row.id, row as WorkplaceRow]))
  const allocationRows = (allocations || []) as AllocationRow[]

  const details = ((results || []) as ResultRow[])
    .map((row) => {
      const period = periodMap.get(row.payroll_period_id)
      const employee = employeeMap.get(row.employee_id)
      const workplace = employee?.default_workplace_id ? workplaceMap.get(employee.default_workplace_id) || null : null
      if (!period || !employee) return null
      return {
        id: row.id,
        periodId: period.id,
        periodKey: periodKey(period),
        payrollMonth: period.payroll_month,
        payrollKind: period.payroll_kind,
        payrollKindLabel: kindLabel(period.payroll_kind),
        payDate: period.pay_date,
        employeeId: employee.id,
        employeeCode: employee.employee_code,
        employeeName: employee.real_name || employee.display_name,
        organization: payrollOrganization(employee, workplace),
        taxablePaymentTotal: amount(row.taxable_payment_total),
        nonTaxablePaymentTotal: amount(row.non_taxable_payment_total),
        paymentTotal: amount(row.payment_total),
        socialInsuranceTotal: amount(row.social_insurance_total),
        deductionTotal: reliableDeductionTotal(row),
        taxableIncome: amount(row.taxable_income),
        netPayment: amount(row.net_payment),
      }
    })
    .filter((row): row is NonNullable<typeof row> => !!row)

  const allocationByPeriod = new Map<string, number>()
  for (const allocation of allocationRows) {
    allocationByPeriod.set(
      allocation.payroll_period_id,
      (allocationByPeriod.get(allocation.payroll_period_id) || 0) + amount(allocation.amount),
    )
  }

  const monthlySummary = Array.from(periodMap.values())
    .map((period) => {
      const rows = details.filter((row) => row.periodId === period.id)
      return {
        periodId: period.id,
        periodKey: periodKey(period),
        payrollMonth: period.payroll_month,
        payrollKind: period.payroll_kind,
        payrollKindLabel: kindLabel(period.payroll_kind),
        payDate: period.pay_date,
        resultCount: rows.length,
        paymentTotal: rows.reduce((sum, row) => sum + row.paymentTotal, 0),
        deductionTotal: rows.reduce((sum, row) => sum + row.deductionTotal, 0),
        netPayment: rows.reduce((sum, row) => sum + row.netPayment, 0),
        allocationTotal: allocationByPeriod.get(period.id) || 0,
      }
    })
    .filter((row) => row.resultCount > 0)
    .sort((a, b) => (a.payrollMonth === b.payrollMonth ? a.payrollKind.localeCompare(b.payrollKind) : b.payrollMonth.localeCompare(a.payrollMonth)))

  const organizationMap = new Map<string, { organization: string; resultCount: number; paymentTotal: number; netPayment: number }>()
  const employeeSummaryMap = new Map<string, { employeeId: string; employeeCode: string | null; employeeName: string; organization: string; months: Set<string>; paymentTotal: number; netPayment: number }>()

  for (const row of details) {
    const organization = organizationMap.get(row.organization) || {
      organization: row.organization,
      resultCount: 0,
      paymentTotal: 0,
      netPayment: 0,
    }
    organization.resultCount += 1
    organization.paymentTotal += row.paymentTotal
    organization.netPayment += row.netPayment
    organizationMap.set(row.organization, organization)

    const employee = employeeSummaryMap.get(row.employeeId) || {
      employeeId: row.employeeId,
      employeeCode: row.employeeCode,
      employeeName: row.employeeName,
      organization: row.organization,
      months: new Set<string>(),
      paymentTotal: 0,
      netPayment: 0,
    }
    employee.months.add(row.periodKey)
    employee.paymentTotal += row.paymentTotal
    employee.netPayment += row.netPayment
    employeeSummaryMap.set(row.employeeId, employee)
  }

  const organizationSummary = Array.from(organizationMap.values()).sort((a, b) => {
    const departmentDiff = departmentOrder[a.organization as UserDepartment] - departmentOrder[b.organization as UserDepartment]
    return departmentDiff || b.paymentTotal - a.paymentTotal
  })
  const employeeSummary = Array.from(employeeSummaryMap.values())
    .map((row) => ({ ...row, months: row.months.size }))
    .sort((a, b) => b.paymentTotal - a.paymentTotal)

  return NextResponse.json({
    summary: {
      periods: monthlySummary.length,
      employees: employeeSummary.length,
      resultCount: details.length,
      paymentTotal: details.reduce((sum, row) => sum + row.paymentTotal, 0),
      netPayment: details.reduce((sum, row) => sum + row.netPayment, 0),
      latestPeriodKey: monthlySummary[0]?.periodKey || '',
    },
    monthlySummary,
    organizationSummary,
    employeeSummary,
    details,
  })
}
