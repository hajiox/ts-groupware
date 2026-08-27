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
    const [requestsResult, resolutionsResult] = await Promise.all([
      adminClient
        .from('gw_paid_leave_requests')
        .select('id, employee_id, leave_date, leave_unit, requested_days, employee_memo, requested_at')
        .eq('request_status', 'submitted')
        .in('request_source', ['employee', 'admin'])
        .order('requested_at', { ascending: true }),
      adminClient
        .from('gw_workday_resolutions')
        .select('id, employee_id, work_date, resolution_type, employee_memo, employee_answered_at, paid_leave_request_id')
        .in('resolution_status', ['employee_answered', 'reopened'])
        .in('resolution_type', ['paid_leave_full', 'paid_leave_half'])
        .not('paid_leave_request_id', 'is', null)
        .order('employee_answered_at', { ascending: true }),
    ])
    if (requestsResult.error || resolutionsResult.error) {
      throw requestsResult.error || resolutionsResult.error
    }

    const requests = requestsResult.data || []
    const resolutions = resolutionsResult.data || []
    const resolutionRequestIds = resolutions
      .map((row) => row.paid_leave_request_id)
      .filter((id): id is string => Boolean(id))
    const { data: resolutionRequests, error: resolutionRequestsError } = resolutionRequestIds.length > 0
      ? await adminClient
        .from('gw_paid_leave_requests')
        .select('id, employee_id, leave_date, leave_unit, requested_days, request_status, employee_memo, requested_at')
        .in('id', resolutionRequestIds)
        .in('request_status', ['submitted', 'approved'])
      : { data: [], error: null }
    if (resolutionRequestsError) throw resolutionRequestsError

    const resolutionRequestById = new Map(
      (resolutionRequests || []).map((request) => [request.id, request]),
    )
    const linkedResolutions = resolutions.filter((resolution) => (
      Boolean(resolution.paid_leave_request_id)
      && resolutionRequestById.has(resolution.paid_leave_request_id as string)
    ))

    const employeeIds = [...new Set([
      ...requests.map((row) => row.employee_id),
      ...linkedResolutions.map((row) => row.employee_id),
    ])]
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
      requests: [
        ...requests.filter((request) => (
          employeeById.has(request.employee_id) && approvableEmployeeIds.has(request.employee_id)
        )).map((request) => {
          const employee = employeeById.get(request.employee_id)
          return {
            ...request,
            approval_kind: 'paid_leave_request' as const,
            request_id: request.id,
            resolution_id: null,
            employee_name: employee?.real_name || employee?.display_name || 'スタッフ',
            department: employee?.department || null,
          }
        }),
        ...linkedResolutions.filter((resolution) => (
          employeeById.has(resolution.employee_id) && approvableEmployeeIds.has(resolution.employee_id)
        )).map((resolution) => {
          const request = resolutionRequestById.get(resolution.paid_leave_request_id as string)!
          const employee = employeeById.get(resolution.employee_id)
          return {
            id: resolution.id,
            approval_kind: 'workday_resolution' as const,
            request_id: request.id,
            resolution_id: resolution.id,
            employee_id: resolution.employee_id,
            employee_name: employee?.real_name || employee?.display_name || 'スタッフ',
            department: employee?.department || null,
            leave_date: request.leave_date,
            leave_unit: request.leave_unit,
            requested_days: request.requested_days,
            employee_memo: resolution.employee_memo || request.employee_memo,
            requested_at: resolution.employee_answered_at || request.requested_at,
          }
        }),
      ].sort((left, right) => left.requested_at.localeCompare(right.requested_at)),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : '承認待ちの有給申請を取得できませんでした',
    }, { status: 500 })
  }
}
