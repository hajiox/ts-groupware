import { NextRequest, NextResponse } from 'next/server'
import { addYearsToISODate, type ISODate } from '@/lib/paid-leave'
import { canProxyStaffView, getManagementPermissions } from '@/lib/management-permissions'
import { isPaidLeaveManagedEmployeeName, jstDate, loadPaidLeaveDashboard, paidLeaveWageSnapshot } from '@/lib/paid-leave-data'
import {
  canApprovePaidLeaveEmployee,
  canApprovePaidLeaveRequest,
  canReceivePaidLeaveApprovals,
  canRegisterPaidLeaveForEmployee,
  paidLeaveApproverIdsForEmployee,
} from '@/lib/paid-leave-approval'
import { resolvePaidLeaveRequestSchedule } from '@/lib/paid-leave-request-schedule'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

function cleanText(value: unknown, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function cleanDate(value: unknown) {
  const text = cleanText(value, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
}

function cleanDays(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed * 2) ? parsed : null
}

async function requireLeaveAdmin() {
  const user = await getUserSession()
  if (!user) return { error: NextResponse.json({ error: '認証が必要です' }, { status: 401 }) }
  const permissions = getManagementPermissions(user)
  if (!permissions.canManageAttendance) {
    return { error: NextResponse.json({ error: '勤怠管理権限が必要です' }, { status: 403 }) }
  }
  const canApprovePaidLeave = canReceivePaidLeaveApprovals(user)
  return { user, permissions, canApprovePaidLeave }
}

async function activeEmployee(employeeId: string) {
  const { data, error } = await adminClient
    .from('gw_payroll_employees')
    .select('id, user_id, employee_code, display_name, real_name, hire_date, department, work_style, payroll_status')
    .eq('id', employeeId)
    .eq('payroll_status', 'active')
    .maybeSingle()
  if (error) throw error
  if (!data || !isPaidLeaveManagedEmployeeName(data.real_name || data.display_name)) return null
  return data
}

type ApprovalResult = {
  management_group_id?: string
  management_post_id?: string
  management_post_created?: boolean
}

async function allocateRequest(requestId: string, actorId: string) {
  const { data, error } = await adminClient.rpc('gw_approve_paid_leave_request_flexible', {
    p_request_id: requestId,
    p_actor_user_id: actorId,
  })
  if (error) throw error
  return (data || {}) as ApprovalResult
}

async function notifyManagementApprovalPost(result: ApprovalResult) {
  if (!result.management_post_created || !result.management_group_id || !result.management_post_id) return

  const [{ data: post }, { data: group }] = await Promise.all([
    adminClient
      .from('gw_posts')
      .select('user_id, content')
      .eq('id', result.management_post_id)
      .maybeSingle(),
    adminClient
      .from('gw_groups')
      .select('name')
      .eq('id', result.management_group_id)
      .maybeSingle(),
  ])
  if (!post?.user_id) return

  try {
    const { sendPushNotificationToGroup } = await import('@/lib/web-push')
    await sendPushNotificationToGroup(result.management_group_id, post.user_id, {
      title: `${group?.name || '管理職'} - TSGくん`,
      body: post.content?.slice(0, 100) || '有給申請が承認されました',
      url: `/board/${result.management_group_id}#post-${result.management_post_id}`,
      tag: `tsg-paid-leave-management-${result.management_post_id}`,
    }, result.management_post_id)
  } catch (error) {
    console.error('[Paid leave management board push error]', error)
  }
}

async function notifyRequestResult(requestId: string, approved: boolean) {
  const { data: row } = await adminClient
    .from('gw_paid_leave_requests')
    .select('user_id, leave_date, leave_unit')
    .eq('id', requestId)
    .maybeSingle()
  if (!row?.user_id) return

  try {
    const { sendPushNotificationToUser } = await import('@/lib/web-push')
    await sendPushNotificationToUser(row.user_id, {
      title: approved ? '有給申請が承認されました' : '有給申請が却下されました',
      body: `${row.leave_date} / ${row.leave_unit === 'full_day' ? '全休' : '半休'}`,
      url: '/leave',
      tag: `tsg-paid-leave-result-${requestId}`,
    })
  } catch (error) {
    console.error('[Paid leave result push error]', error)
  }
}

async function notifyPaidLeaveApprovers(options: {
  employeeId: string
  employeeName: string
  leaveDate: string
  leaveUnit: 'full_day' | 'half_day'
  requestId: string
}) {
  try {
    const approverIds = await paidLeaveApproverIdsForEmployee(options.employeeId)
    const { sendPushNotificationToUser } = await import('@/lib/web-push')
    await Promise.allSettled(approverIds.map((approverId) => sendPushNotificationToUser(approverId, {
      title: '有給申請が届きました',
      body: `${options.employeeName}さん / ${options.leaveDate} / ${options.leaveUnit === 'full_day' ? '全休' : '半休'}`,
      url: '/groups',
      tag: `tsg-paid-leave-request-${options.requestId}`,
    })))
  } catch (error) {
    console.error('[Paid leave approver push error]', error)
  }
}

async function notifyWorkdayResolutionResult(row: {
  id: string
  user_id: string | null
  work_date: string
  resolution_type: string
}, approved: boolean) {
  if (!row.user_id) return
  try {
    const { sendPushNotificationToUser } = await import('@/lib/web-push')
    await sendPushNotificationToUser(row.user_id, {
      title: approved ? '勤怠回答が承認されました' : '勤怠回答が差し戻されました',
      body: `${row.work_date} / ${row.resolution_type === 'work_schedule_changed' ? '勤務時間の変更' : '勤怠確認'}`,
      url: '/leave',
      tag: `tsg-workday-resolution-${row.id}`,
    })
  } catch (error) {
    console.error('[Workday resolution result push error]', error)
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireLeaveAdmin()
  if (auth.error) return auth.error

  const selectedUserId = cleanText(request.nextUrl.searchParams.get('user_id'), 80)
  try {
    const { data: employees, error: employeesError } = await adminClient
      .from('gw_payroll_employees')
      .select('id, user_id, employee_code, display_name, real_name, hire_date, department, work_style, payroll_status')
      .eq('payroll_status', 'active')
      .not('user_id', 'is', null)
      .order('department', { ascending: true })
      .order('hire_date', { ascending: true, nullsFirst: false })
      .order('employee_code', { ascending: true, nullsFirst: false })
    if (employeesError) throw employeesError

    const employeeIds = (employees || []).map((employee) => employee.id)
    const [
      { data: pendingRows, error: pendingError },
      { data: pendingLeaveRows, error: pendingLeaveError },
      { data: balanceRows, error: balanceError },
      { data: profileRows, error: profileError },
    ] = await Promise.all([
      adminClient
        .from('gw_workday_resolutions')
        .select('id, employee_id, work_date, resolution_type, resolution_status, employee_memo, raw_payload')
        .in('resolution_status', ['employee_answered', 'reopened'])
        .order('work_date', { ascending: false }),
      adminClient
        .from('gw_paid_leave_requests')
        .select('employee_id')
        .eq('request_status', 'submitted')
        .in('request_source', ['employee', 'admin']),
      employeeIds.length
        ? adminClient
          .from('gw_paid_leave_grant_balances')
          .select('employee_id, grant_date, expires_on, granted_days, remaining_days')
          .in('employee_id', employeeIds)
        : Promise.resolve({ data: [], error: null }),
      employeeIds.length
        ? adminClient
          .from('gw_paid_leave_profiles')
          .select('employee_id, next_grant_date, projected_grant_days')
          .in('employee_id', employeeIds)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (pendingError || pendingLeaveError || balanceError || profileError) {
      throw pendingError || pendingLeaveError || balanceError || profileError
    }

    const pendingByEmployee = new Map<string, number>()
    for (const row of pendingRows || []) {
      pendingByEmployee.set(row.employee_id, (pendingByEmployee.get(row.employee_id) || 0) + 1)
    }
    for (const row of pendingLeaveRows || []) {
      pendingByEmployee.set(row.employee_id, (pendingByEmployee.get(row.employee_id) || 0) + 1)
    }
    const today = jstDate()
    const balanceByEmployee = new Map<string, number>()
    const upcomingGrantByEmployee = new Map<string, { date: string; days: number }>()
    for (const row of balanceRows || []) {
      if (row.grant_date > today) {
        const existing = upcomingGrantByEmployee.get(row.employee_id)
        const days = Number(row.granted_days || 0)
        if (!existing || row.grant_date < existing.date) {
          upcomingGrantByEmployee.set(row.employee_id, { date: row.grant_date, days })
        } else if (row.grant_date === existing.date) {
          existing.days += days
        }
      } else if (row.expires_on > today) {
        balanceByEmployee.set(
          row.employee_id,
          (balanceByEmployee.get(row.employee_id) || 0) + Number(row.remaining_days || 0),
        )
      }
    }
    const profileByEmployee = new Map(
      (profileRows || []).map((profile) => [profile.employee_id, profile]),
    )
    const employeeRows = (employees || [])
      .filter((employee) => isPaidLeaveManagedEmployeeName(employee.real_name || employee.display_name))
      .map((employee) => {
        const upcomingGrant = upcomingGrantByEmployee.get(employee.id)
        const profile = profileByEmployee.get(employee.id)
        return {
          ...employee,
          name: employee.real_name || employee.display_name,
          pendingCount: pendingByEmployee.get(employee.id) || 0,
          availableDays: balanceByEmployee.get(employee.id) || 0,
          nextGrantDate: upcomingGrant?.date || profile?.next_grant_date || null,
          projectedGrantDays: upcomingGrant?.days
            ?? Number(profile?.projected_grant_days || 0),
        }
      })
    const selectedEmployee = employeeRows.find((employee) => employee.user_id === selectedUserId)
    const targetUserId = selectedEmployee?.user_id || employeeRows[0]?.user_id || ''
    const dashboard = targetUserId ? await loadPaidLeaveDashboard(targetUserId, auth.user!.id) : null
    const canRegisterSelectedEmployee = dashboard
      ? await canRegisterPaidLeaveForEmployee(auth.user!, dashboard.employee.id)
      : false

    const canViewAs = await canProxyStaffView(auth.user)
    const canConfirmSelectedResolution = dashboard
      ? await canApprovePaidLeaveEmployee(auth.user, dashboard.employee.id)
      : false
    const approvableRequestIds = dashboard
      ? (await Promise.all(dashboard.requests
        .filter((row) => row.request_status === 'submitted')
        .map(async (row) => await canApprovePaidLeaveRequest(auth.user!, row.id) ? row.id : null)))
        .filter((id): id is string => Boolean(id))
      : []
    return NextResponse.json({
      employees: employeeRows,
      pending: pendingRows || [],
      dashboard,
      canViewAs,
      canApprovePaidLeave: auth.canApprovePaidLeave,
      approvableRequestIds,
      canRegisterSelectedEmployee,
      canConfirmSelectedResolution,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : '有給管理情報を取得できませんでした',
    }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireLeaveAdmin()
  if (auth.error) return auth.error

  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const action = cleanText(body.action, 60)
  try {
    if (action === 'register_employee_leave') {
      const employeeId = cleanText(body.employee_id, 80)
      const leaveDate = cleanDate(body.leave_date)
      const leaveUnit = body.leave_unit === 'half_day' ? 'half_day' : 'full_day'
      const managerMemo = cleanText(body.memo, 500)
      if (!employeeId || !leaveDate) {
        return NextResponse.json({ error: 'スタッフと有給取得日を確認してください' }, { status: 400 })
      }
      if (!await canRegisterPaidLeaveForEmployee(auth.user!, employeeId)) {
        return NextResponse.json({ error: 'このスタッフの有給を登録する権限がありません' }, { status: 403 })
      }
      const employee = await activeEmployee(employeeId)
      if (!employee?.user_id) return NextResponse.json({ error: '在籍スタッフが見つかりません' }, { status: 404 })
      const dashboard = await loadPaidLeaveDashboard(employee.user_id, auth.user!.id)
      const requestedDays = leaveUnit === 'full_day' ? 1 : 0.5

      const { data: existingRequest, error: existingError } = await adminClient
        .from('gw_paid_leave_requests')
        .select('id')
        .eq('employee_id', employeeId)
        .eq('leave_date', leaveDate)
        .in('request_status', ['draft', 'submitted', 'approved', 'consumed'])
        .maybeSingle()
      if (existingError) throw existingError
      if (existingRequest) {
        return NextResponse.json({ error: 'この日はすでに有給申請が登録されています' }, { status: 409 })
      }
      const { data: pendingRequests, error: pendingError } = await adminClient
        .from('gw_paid_leave_requests')
        .select('requested_days')
        .eq('employee_id', employeeId)
        .eq('request_status', 'submitted')
      if (pendingError) throw pendingError
      const pendingDays = (pendingRequests || []).reduce((sum, row) => sum + Number(row.requested_days || 0), 0)
      const availableOnLeaveDate = dashboard.balance.lots
        .filter((lot) => lot.grantDate <= leaveDate && lot.expiresOn > leaveDate)
        .reduce((sum, lot) => sum + Number(lot.remainingDays || 0), 0)
      if (availableOnLeaveDate - pendingDays < requestedDays) {
        return NextResponse.json({ error: '取得日時点の有給残日数が不足します' }, { status: 400 })
      }

      const scheduleResult = await resolvePaidLeaveRequestSchedule({
        employeeId,
        userId: employee.user_id,
        leaveDate,
        leaveUnit,
      })
      if (!scheduleResult.ok) {
        return NextResponse.json({ error: scheduleResult.error }, { status: scheduleResult.status })
      }
      const schedule = scheduleResult.schedule
      const wage = await paidLeaveWageSnapshot(employeeId, schedule.scheduledMinutes, requestedDays, leaveDate as `${number}-${number}-${number}`)
      const { data: createdRequest, error: createError } = await adminClient
        .from('gw_paid_leave_requests')
        .insert({
          employee_id: employeeId,
          user_id: employee.user_id,
          leave_date: leaveDate,
          leave_unit: leaveUnit,
          request_source: 'admin',
          request_status: 'submitted',
          shift_period_id: schedule.periodId,
          shift_assignment_id: schedule.assignmentId,
          scheduled_minutes_snapshot: schedule.scheduledMinutes,
          wage_method: 'ordinary_wage',
          hourly_rate_snapshot: wage.hourlyRate || null,
          payable_minutes_snapshot: wage.payableMinutes,
          paid_wage_amount: wage.amount,
          requested_by: auth.user!.id,
          employee_memo: managerMemo || null,
          manager_memo: managerMemo || null,
          raw_payload: {
            wage_basis: wage.basis,
            included_in_monthly_salary: wage.includedInMonthlySalary,
            paid_leave_schedule: {
              source: schedule.source,
              start_time: schedule.startTime,
              end_time: schedule.endTime,
              break_minutes: schedule.breakMinutes,
              converts_non_workday: schedule.convertsNonWorkday,
              previous_shift_request_type: schedule.previousShiftRequestType,
            },
          },
        })
        .select('id')
        .single()
      if (createError) throw createError
      const canApproveCreatedRequest = await canApprovePaidLeaveEmployee(auth.user!, employeeId)
      if (canApproveCreatedRequest) {
        const approvalResult = await allocateRequest(createdRequest.id, auth.user!.id)
        await notifyManagementApprovalPost(approvalResult)
        await notifyRequestResult(createdRequest.id, true)
        return NextResponse.json({
          success: true,
          requestId: createdRequest.id,
          approved: true,
          convertsNonWorkday: schedule.convertsNonWorkday,
        })
      }

      await notifyPaidLeaveApprovers({
        employeeId,
        employeeName: dashboard.employee.name,
        leaveDate,
        leaveUnit,
        requestId: createdRequest.id,
      })
      return NextResponse.json({
        success: true,
        requestId: createdRequest.id,
        approved: false,
        approvalPending: true,
        convertsNonWorkday: schedule.convertsNonWorkday,
      })
    }

    if (action === 'approve_request') {
      const requestId = cleanText(body.request_id, 80)
      if (!requestId) return NextResponse.json({ error: '有給申請を選択してください' }, { status: 400 })
      if (!await canApprovePaidLeaveRequest(auth.user!, requestId)) {
        return NextResponse.json({ error: 'この有給申請を承認する権限がありません' }, { status: 403 })
      }
      const approvalResult = await allocateRequest(requestId, auth.user!.id)
      await notifyManagementApprovalPost(approvalResult)
      await notifyRequestResult(requestId, true)
      return NextResponse.json({
        success: true,
        managementPostId: approvalResult.management_post_id || null,
      })
    }

    if (action === 'reject_request') {
      const requestId = cleanText(body.request_id, 80)
      const managerMemo = cleanText(body.manager_memo, 500)
      if (!requestId) return NextResponse.json({ error: '有給申請を選択してください' }, { status: 400 })
      if (!await canApprovePaidLeaveRequest(auth.user!, requestId)) {
        return NextResponse.json({ error: 'この有給申請を却下する権限がありません' }, { status: 403 })
      }
      const { error } = await adminClient.rpc('gw_reject_paid_leave_request', {
        p_request_id: requestId,
        p_actor_user_id: auth.user!.id,
        p_manager_memo: managerMemo || null,
      })
      if (error) throw error
      await notifyRequestResult(requestId, false)
      return NextResponse.json({ success: true })
    }

    if (action === 'confirm_resolution') {
      const resolutionId = cleanText(body.resolution_id, 80)
      const managerMemo = cleanText(body.manager_memo, 500)
      if (!resolutionId) return NextResponse.json({ error: '未打刻回答を選択してください' }, { status: 400 })
      const { data: resolution, error: resolutionLookupError } = await adminClient
        .from('gw_workday_resolutions')
        .select('id, employee_id, user_id, work_date, resolution_type, paid_leave_request_id')
        .eq('id', resolutionId)
        .maybeSingle()
      if (resolutionLookupError) throw resolutionLookupError
      if (!resolution) return NextResponse.json({ error: '勤怠回答が見つかりません' }, { status: 404 })
      if (!await canApprovePaidLeaveEmployee(auth.user!, resolution.employee_id)) {
        return NextResponse.json({ error: 'この勤怠回答を承認する権限がありません' }, { status: 403 })
      }
      const { data, error } = await adminClient.rpc('gw_confirm_workday_resolution', {
        p_resolution_id: resolutionId,
        p_actor_user_id: auth.user!.id,
        p_manager_memo: managerMemo || null,
      })
      if (error) throw error
      if (resolution.paid_leave_request_id) {
        await notifyManagementApprovalPost((data || {}) as ApprovalResult)
        await notifyRequestResult(resolution.paid_leave_request_id, true)
      } else {
        await notifyWorkdayResolutionResult(resolution, true)
      }
      return NextResponse.json({
        success: true,
        managementPostId: (data as ApprovalResult | null)?.management_post_id || null,
      })
    }

    if (action === 'reopen_resolution') {
      const resolutionId = cleanText(body.resolution_id, 80)
      if (!resolutionId) return NextResponse.json({ error: '未打刻回答を選択してください' }, { status: 400 })
      const { data: resolution, error: resolutionLookupError } = await adminClient
        .from('gw_workday_resolutions')
        .select('id, employee_id, user_id, work_date, resolution_type')
        .eq('id', resolutionId)
        .maybeSingle()
      if (resolutionLookupError) throw resolutionLookupError
      if (!resolution) return NextResponse.json({ error: '勤怠回答が見つかりません' }, { status: 404 })
      if (!await canApprovePaidLeaveEmployee(auth.user!, resolution.employee_id)) {
        return NextResponse.json({ error: 'この勤怠回答を差し戻す権限がありません' }, { status: 403 })
      }
      const { error } = await adminClient.rpc('gw_reopen_workday_resolution', {
        p_resolution_id: resolutionId,
        p_actor_user_id: auth.user!.id,
      })
      if (error) throw error
      await notifyWorkdayResolutionResult(resolution, false)
      return NextResponse.json({ success: true })
    }

    if (action === 'add_grant') {
      const employeeId = cleanText(body.employee_id, 80)
      const grantDate = cleanDate(body.grant_date) || jstDate()
      const days = cleanDays(body.days)
      const notes = cleanText(body.notes, 500)
      if (!employeeId || days === null) {
        return NextResponse.json({ error: 'スタッフと0.5日単位の付与日数を確認してください' }, { status: 400 })
      }
      const employee = await activeEmployee(employeeId)
      if (!employee) return NextResponse.json({ error: '在籍スタッフが見つかりません' }, { status: 404 })
      const { error } = await adminClient
        .from('gw_paid_leave_grant_lots')
        .insert({
          employee_id: employeeId,
          user_id: employee.user_id,
          grant_date: grantDate,
          expires_on: addYearsToISODate(grantDate as ISODate, 2),
          granted_days: days,
          grant_source: 'manual_adjustment',
          grant_status: 'granted',
          initial_assumption: false,
          notes: notes || '管理者による有給残高調整',
          created_by: auth.user!.id,
        })
      if (error) throw error
      return NextResponse.json({ success: true })
    }

    if (action === 'deduct_opening_usage') {
      const employeeId = cleanText(body.employee_id, 80)
      const effectiveDate = cleanDate(body.effective_date) || jstDate()
      const days = cleanDays(body.days)
      const notes = cleanText(body.notes, 500)
      if (!employeeId || days === null) {
        return NextResponse.json({ error: 'スタッフと0.5日単位の使用済み日数を確認してください' }, { status: 400 })
      }
      const employee = await activeEmployee(employeeId)
      if (!employee) return NextResponse.json({ error: '在籍スタッフが見つかりません' }, { status: 404 })
      const { error } = await adminClient.rpc('gw_import_paid_leave_usage', {
        p_employee_id: employeeId,
        p_user_id: employee.user_id,
        p_used_days: days,
        p_effective_date: effectiveDate,
        p_note: notes || '初期残高の使用済み日数を反映',
        p_actor_user_id: auth.user!.id,
      })
      if (error) throw error
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: '操作を確認してください' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : '有給管理の更新に失敗しました',
    }, { status: 500 })
  }
}
