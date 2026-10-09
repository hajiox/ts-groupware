import { NextRequest, NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { getManagementPermissions } from '@/lib/management-permissions'
import { loadPayrollRuleStability } from '@/lib/payroll-rule-stability-data'

export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  if (!getManagementPermissions(user).canViewPayroll) return NextResponse.json({ error: '給与の閲覧権限が必要です' }, { status: 403 })
  const month = request.nextUrl.searchParams.get('payrollMonth') || undefined
  if (month && !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(month)) return NextResponse.json({ error: '給与月を確認してください' }, { status: 400 })
  try { return NextResponse.json(await loadPayrollRuleStability({ month }), { headers: { 'Cache-Control': 'private, no-store' } }) }
  catch { return NextResponse.json({ error: '過去給与の検証データを取得できませんでした' }, { status: 503 }) }
}
