import { NextResponse } from 'next/server'
import { canApprovePaidLeaveEmployee, canReceivePaidLeaveApprovals } from '@/lib/paid-leave-approval'
import { isPaidLeaveManagedEmployeeName } from '@/lib/paid-leave-data'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

export async function GET() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }
  if (!canReceivePaidLeaveApprovals(user)) {
    return NextResponse.json({ error: '有給承認権限が必要です' }, { status: 403 })
  }

  try {
    const { data: requests, error: requestsError } = await adminClient
      .from('gw_paid_leave_requests')
      .select('id, employee_id, leave_date, leave_unit, requested_days, employee_memo, requested_at')
      .eq('request_status', 'submitted')
      .eq('request_source', 'employee')
      .order('requested_at', { ascending: true })
    if (requestsError) throw requestsError

    const employeeIds = [...new Set((requests || []).map((row) => row.employee_id))]
    const { data: employees, error: employeesError } = employeeIds.length > 0
      ? await adminClient
        .from('gw_payroll_employees')
        .select('id, display_name, real_name, department')
        .in('id', employeeIds)
      : { data: [], error: null }
    if (employeesError) throw employeesError

    const managedEmployees = (employees || []).filter((employee) => (
      isPaidLeaveManagedEmployeeName(employee.real_name || employee.display_name)
    ))
    const employeeById = new Map(managedEmployees.map((employee) => [employee.id, employee]))
    const approvableEmployeeIds = new Set<string>()
    await Promise.all(managedEmployees.map(async (employee) => {
      if (await canApprovePaidLeaveEmployee(user, employee.id)) approvableEmployeeIds.add(employee.id)
    }))
    return NextResponse.json({
      requests: (requests || []).filter((request) => (
        employeeById.has(request.employee_id) && approvableEmployeeIds.has(request.employee_id)
      )).map((request) => {
        const employee = employeeById.get(request.employee_id)
        return {
          ...request,
          employee_name: employee?.real_name || employee?.display_name || 'スタッフ',
          department: employee?.department || null,
        }
      }),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : '承認待ちの有給申請を取得できませんでした',
    }, { status: 500 })
  }
}
