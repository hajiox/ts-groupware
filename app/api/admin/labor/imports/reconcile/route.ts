import { NextResponse } from 'next/server'
import { getManagementPermissions } from '@/lib/management-permissions'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

type LaborBatchRow = {
  target_payroll_month: string | null
  target_attendance_month: string | null
  payroll_kind: string
  period_start: string | null
  period_end: string | null
  pay_date: string | null
}

type PayrollPeriodRow = {
  payroll_month: string
  payroll_kind: string
}

function monthEnd(monthStart: string) {
  const [year, month] = monthStart.split('-').map(Number)
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

export async function POST() {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

  const permissions = getManagementPermissions(user)
  if (!permissions.canViewPayroll) {
    return NextResponse.json({ error: '労務データ取込権限が必要です' }, { status: 403 })
  }

  const [batchesResponse, periodsResponse] = await Promise.all([
    adminClient
      .from('gw_labor_import_batches')
      .select('target_payroll_month, target_attendance_month, payroll_kind, period_start, period_end, pay_date')
      .neq('status', 'voided')
      .not('target_payroll_month', 'is', null)
      .not('target_attendance_month', 'is', null)
      .order('imported_at', { ascending: false }),
    adminClient
      .from('gw_payroll_periods')
      .select('payroll_month, payroll_kind'),
  ])

  const dbError = batchesResponse.error || periodsResponse.error
  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 })

  const existingKeys = new Set(((periodsResponse.data || []) as PayrollPeriodRow[]).map((period) => (
    `${period.payroll_month.slice(0, 10)}:${period.payroll_kind}`
  )))
  const pendingKeys = new Set<string>()
  const missingPeriods = ((batchesResponse.data || []) as LaborBatchRow[]).flatMap((batch) => {
    if (!batch.target_payroll_month || !batch.target_attendance_month) return []
    const payrollMonth = batch.target_payroll_month.slice(0, 10)
    const attendanceMonth = batch.target_attendance_month.slice(0, 10)
    const key = `${payrollMonth}:${batch.payroll_kind}`
    if (existingKeys.has(key) || pendingKeys.has(key)) return []
    pendingKeys.add(key)

    return [{
      payroll_month: payrollMonth,
      payroll_kind: batch.payroll_kind,
      attendance_month: attendanceMonth,
      period_start: batch.period_start || attendanceMonth,
      period_end: batch.period_end || monthEnd(attendanceMonth),
      pay_date: batch.pay_date || `${payrollMonth.slice(0, 7)}-10`,
      created_by: user.id,
    }]
  })

  if (missingPeriods.length === 0) {
    return NextResponse.json({ ok: true, created: 0 })
  }

  const { data: createdPeriods, error: insertError } = await adminClient
    .from('gw_payroll_periods')
    .upsert(missingPeriods, {
      onConflict: 'payroll_month,payroll_kind',
      ignoreDuplicates: true,
    })
    .select('id')

  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 })

  return NextResponse.json({ ok: true, created: createdPeriods?.length || 0 })
}
