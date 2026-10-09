import { createHash } from 'node:crypto'
import { adminClient } from '@/lib/supabase/admin'
import { loadAllRows } from '@/lib/supabase-pagination'
import { calculatePayrollFromLabor, type PayrollLaborInput } from '@/lib/payroll-calculation'
import type { MailComparisonProfile } from '@/lib/payroll-mail-comparison'
import { auditPayrollRuleStability, selectStabilityProfile, type PayrollStabilityRecord } from '@/lib/payroll-rule-stability'
import { detectPayrollEngineDrift, type PayrollEngineCheck } from '@/lib/payroll-engine-drift'

type Period = { id: string; payroll_month: string }
type Result = { id: string; employee_id: string; payroll_period_id: string; payment_total: number | string | null; net_payment: number | string | null; deduction_total: number | string | null; non_taxable_payment_total: number | string | null }
type ItemDefinition = { id: string; code: string; item_type: string; taxable: boolean | null }
type Item = { id: string; payroll_result_id: string; payroll_item_id: string; amount: number | string | null; minutes: number | string | null; days: number | string | null; rate: number | string | null }
type SavedAudit = { created_at: string; stability: { version: string; engineChecks?: PayrollEngineCheck[] } | null }

function fingerprint(value: unknown) {
  // PostgREST and JSONB exports may emit identical object keys in different
  // orders. Hash the values, rather than that transport-level key ordering.
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
    : input !== null && typeof input === 'object' ? Object.fromEntries(Object.entries(input)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, next]) => [key, canonical(next)])) : input
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
function nullableNumber(value: unknown) { return value == null ? null : Number(value) }
function requiredNumber(value: unknown) { return value == null ? Number.NaN : Number(value) }
async function byChunks<Row>(ids: string[], load: (chunk: string[]) => Promise<Row[]>) {
  const rows: Row[] = []
  for (let index = 0; index < ids.length; index += 100) rows.push(...await load(ids.slice(index, index + 100)))
  return rows
}

// All callers authenticate before this loader. Payroll reads remain server-only;
// the monthly import saves its audit in the existing private job transaction.
export async function loadPayrollRuleStability(options: {
  month?: string
  pending?: Array<{ employeeId: string; labor: PayrollLaborInput }>
} = {}) {
  if (options.month && !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(options.month)) throw new Error('Invalid payroll month')
  if (options.pending?.length && !options.month) throw new Error('Pending results require a payroll month')
  const periodQuery = adminClient.from('gw_payroll_periods').select('id,payroll_month').eq('payroll_kind', 'monthly').order('payroll_month', { ascending: false }).limit(24)
  const { data: periodData, error: periodError } = options.month ? await periodQuery.lte('payroll_month', options.month) : await periodQuery
  if (periodError) throw periodError
  let periods = (periodData || []) as Period[]
  const pendingMonth = options.month
  if (pendingMonth && options.pending?.length && !periods.some(period => period.payroll_month === pendingMonth)) {
    periods = [{ id: '', payroll_month: pendingMonth }, ...periods].slice(0, 24)
  }
  const periodIds = periods.map(period => period.id).filter(Boolean)
  const results = periodIds.length ? await loadAllRows<Result>((from, to) => adminClient.from('gw_payroll_employee_results')
    .select('id,employee_id,payroll_period_id,payment_total,net_payment,deduction_total,non_taxable_payment_total').in('payroll_period_id', periodIds).order('id').range(from, to)) : []
  const employeeIds = [...new Set([...results.map(result => result.employee_id), ...(options.pending || []).map(row => row.employeeId)])].sort()
  const latestMonth = periods[0]?.payroll_month || pendingMonth || ''
  const [profiles, items, definitions, saved] = await Promise.all([
    byChunks<MailComparisonProfile>(employeeIds, ids => loadAllRows<MailComparisonProfile>((from, to) => adminClient.from('gw_payroll_calculation_profiles')
      .select('id,employee_id,effective_from,effective_to,calculation_type,monthly_base_amount,hourly_rate,overtime_divisor,weekday_saturday_overtime_multiplier,sunday_overtime_multiplier,scheduled_minutes,taxable_additions,deduction_snapshot,source_snapshot')
      .in('employee_id', ids).lte('effective_from', latestMonth).order('id').range(from, to))),
    byChunks<Item>(results.map(result => result.id), ids => loadAllRows<Item>((from, to) => adminClient.from('gw_payroll_result_items')
      .select('id,payroll_result_id,payroll_item_id,amount,minutes,days,rate').in('payroll_result_id', ids).order('id').range(from, to))),
    loadAllRows<ItemDefinition>((from, to) => adminClient.from('gw_payroll_items').select('id,code,item_type,taxable').order('id').range(from, to)),
    adminClient.from('gw_payroll_mail_jobs').select('created_at,stability:comparison->stability').eq('status', 'imported').order('created_at', { ascending: false }).limit(24),
  ])
  if (saved.error) throw saved.error
  const monthByPeriod = new Map(periods.map(period => [period.id, period.payroll_month]))
  const definitionById = new Map(definitions.map(definition => [definition.id, definition]))
  const itemsByResult = new Map<string, Item[]>()
  for (const item of items) itemsByResult.set(item.payroll_result_id, [...(itemsByResult.get(item.payroll_result_id) || []), item])
  const records = new Map<string, PayrollStabilityRecord>()
  for (const result of results) {
    const month = monthByPeriod.get(result.payroll_period_id)
    if (!month) continue
    const labor: PayrollLaborInput = {
      paymentTotal: requiredNumber(result.payment_total), netPayment: requiredNumber(result.net_payment),
      deductionTotal: requiredNumber(result.deduction_total), nonTaxablePaymentTotal: requiredNumber(result.non_taxable_payment_total),
      items: (itemsByResult.get(result.id) || []).map(item => {
        const definition = definitionById.get(item.payroll_item_id)
        if (!definition) throw new Error('Payroll item definition missing')
        return { code: definition.code, itemType: definition.item_type, taxable: definition.taxable,
          amount: requiredNumber(item.amount), minutes: nullableNumber(item.minutes), days: nullableNumber(item.days), rate: nullableNumber(item.rate) }
      }).sort((a, b) => a.code.localeCompare(b.code)),
    }
    const recordKey = `${month}:${result.employee_id}`
    if (records.has(recordKey)) throw new Error('Duplicate employee/month payroll results')
    records.set(recordKey, { month, employeeId: result.employee_id, labor, profile: selectStabilityProfile(profiles, result.employee_id, month) })
  }
  const pendingIds = new Set<string>()
  for (const row of options.pending || []) {
    if (pendingIds.has(row.employeeId)) throw new Error('Duplicate pending employee')
    pendingIds.add(row.employeeId)
    records.set(`${pendingMonth}:${row.employeeId}`, { month: pendingMonth!, employeeId: row.employeeId,
      labor: { paymentTotal: row.labor.paymentTotal, netPayment: row.labor.netPayment, deductionTotal: row.labor.deductionTotal,
        nonTaxablePaymentTotal: row.labor.nonTaxablePaymentTotal, items: row.labor.items.map(item => ({code:item.code,itemType:item.itemType,
          taxable:item.taxable,amount:item.amount,minutes:item.minutes,days:item.days,rate:item.rate})).sort((a, b) => a.code.localeCompare(b.code)) },
      profile: selectStabilityProfile(profiles, row.employeeId, pendingMonth!),
    })
  }
  const ordered = [...records.values()].sort((a, b) => a.month.localeCompare(b.month) || a.employeeId.localeCompare(b.employeeId))
  const audit = auditPayrollRuleStability(ordered)
  const engineChecks: PayrollEngineCheck[] = ordered.map(record => {
    const reconstruction = calculatePayrollFromLabor(record.profile, record.labor)
    return { month: record.month, employeeId: record.employeeId, inputFingerprint: fingerprint(record),
      resultFingerprint: fingerprint(reconstruction), status: !reconstruction.calculated ? 'unverified' : reconstruction.componentDifference
        || reconstruction.calculated.paymentTotal !== record.labor.paymentTotal
        || reconstruction.calculated.netPayment !== record.labor.netPayment
        || reconstruction.calculated.deductionTotal !== record.labor.deductionTotal ? 'mismatch' : 'matched', reason: reconstruction.reason }
  })
  const snapshots = ((saved.data || []) as SavedAudit[]).filter(row => row.stability?.engineChecks?.length)
    .map(row => ({ createdAt: row.created_at, version: row.stability!.version, engineChecks: row.stability!.engineChecks! }))
  const engineIssues = detectPayrollEngineDrift(engineChecks, snapshots)
  const savedInputKeys = new Set(snapshots.flatMap(snapshot => snapshot.engineChecks.map(check => `${check.month}:${check.employeeId}:${check.inputFingerprint}`)))
  const auditMonths = new Map(audit.months.map(month => [month.month, month]))
  return {
    ...audit, status: 'completed' as const, fingerprintVersion: 'canonical-json-v1', calculatedAt: new Date().toISOString(),
    sourceFingerprint: fingerprint(ordered), historyFrom: periods.at(-1)?.payroll_month || null, historyTo: periods[0]?.payroll_month || null,
    periodCount: periods.length, snapshotCount: snapshots.length,
    baselineComparedChecks: engineChecks.filter(check => savedInputKeys.has(`${check.month}:${check.employeeId}:${check.inputFingerprint}`)).length,
    months: periods.map(period => auditMonths.get(period.payroll_month) || { month: period.payroll_month, checkedComponents: 0,
      matchedComponents: 0, mismatchedComponents: 0, ambiguousComponents: 0, unverifiedComponents: 0 }).sort((a, b) => b.month.localeCompare(a.month)),
    issues: [...audit.issues, ...engineIssues], engineChecks,
    totals: { ...audit.totals, engineChanges: engineIssues.filter(issue => issue.kind === 'engine_change').length,
      engineReversals: engineIssues.filter(issue => issue.kind === 'engine_reversal').length },
  }
}
