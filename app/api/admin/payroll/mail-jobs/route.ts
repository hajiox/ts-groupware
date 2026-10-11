import { NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { getManagementPermissions } from '@/lib/management-permissions'
import { adminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store' }

/** The same saved import/comparison records shown by /admin/payroll-mail. */
export async function GET() {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401, headers })
  if (!getManagementPermissions(user).canViewPayroll) return NextResponse.json({ error: '給与の閲覧権限が必要です' }, { status: 403, headers })
  try {
    const { data, error } = await adminClient.from('gw_payroll_mail_jobs')
      .select('id,payroll_month,attendance_month,status,reason,created_at,report_status,comparison')
      .order('created_at', { ascending: false }).limit(24)
    if (error) throw new Error('MAIL_JOBS_UNAVAILABLE')
    const jobs = data || []
    const employeeIds = [...new Set(jobs.flatMap(job => {
      const rows = job.comparison && typeof job.comparison === 'object' && Array.isArray(job.comparison.rows) ? job.comparison.rows : []
      return rows.flatMap((row: unknown) => row && typeof row === 'object' && 'employeeId' in row && typeof row.employeeId === 'string' ? [row.employeeId] : [])
    }))]
    const employees = employeeIds.length ? await adminClient.from('gw_payroll_employees')
      .select('id,real_name,display_name').in('id', employeeIds) : { data: [], error: null }
    if (employees.error) throw new Error('MAIL_JOB_NAMES_UNAVAILABLE')
    return NextResponse.json({ jobs, employees: (employees.data || []).map(employee => ({ id: employee.id, name: employee.real_name || employee.display_name })) }, { headers })
  } catch {
    return NextResponse.json({ error: '給与メールの取込・検証結果を取得できませんでした' }, { status: 500, headers })
  }
}
