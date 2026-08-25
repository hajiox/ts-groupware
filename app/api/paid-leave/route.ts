import { NextRequest, NextResponse } from 'next/server'
import { attendanceDeviationLabel } from '@/lib/attendance-deviations'
import { isRegularEmployeeWorkStyle } from '@/lib/bereavement-leave'
import { canProxyStaffView } from '@/lib/management-permissions'
import { loadPaidLeaveDashboard, paidLeaveWageSnapshot } from '@/lib/paid-leave-data'
import { paidLeaveApproverIdsForEmployee } from '@/lib/paid-leave-approval'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

const RESOLUTION_TYPES = new Set([
  'punch_missing',
  'paid_leave_full',
  'paid_leave_half',
  'bereavement_leave',
  'absence',
  'work_schedule_changed',
])

function cleanText(value: unknown, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function scheduledMinutesFromAssignment(assignment: {
  work_minutes?: number | null
  start_time?: string | null
  end_time?: string | null
  break_minutes?: number | null
} | null) {
  if (!assignment) return 0
  if (Number(assignment.work_minutes || 0) > 0) return Number(assignment.work_minutes)
  if (!assignment.start_time || !assignment.end_time) return 0
  const [startHour, startMinute] = assignment.start_time.slice(0, 5).split(':').map(Number)
  const [endHour, endMinute] = assignment.end_time.slice(0, 5).split(':').map(Number)
  let minutes = endHour * 60 + endMinute - (startHour * 60 + startMinute)
  if (minutes < 0) minutes += 24 * 60
  return Math.max(0, minutes - Number(assignment.break_minutes || 0))
}

async function submitPaidLeaveRequest(
  user: NonNullable<Awaited<ReturnType<typeof getUserSession>>>,
  body: Record<string, unknown>,
) {
  const leaveDate = cleanText(body.leave_date, 10)
  const leaveUnit = body.leave_unit === 'half_day' ? 'half_day' : 'full_day'
  const employeeMemo = cleanText(body.memo, 500)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(leaveDate)) {
    return NextResponse.json({ error: '有給を申請する日を選択してください' }, { status: 400 })
  }

  const dashboard = await loadPaidLeaveDashboard(user.id, user.id)
  if (!dashboard.managed) {
    return NextResponse.json({ error: 'このアカウントは有給管理の対象外です' }, { status: 403 })
  }
  const requestedDays = leaveUnit === 'full_day' ? 1 : 0.5

  const { data: existingRequest, error: existingError } = await adminClient
    .from('gw_paid_leave_requests')
    .select('id, request_status')
    .eq('employee_id', dashboard.employee.id)
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
    .eq('employee_id', dashboard.employee.id)
    .eq('request_status', 'submitted')
  if (pendingError) throw pendingError
  const pendingDays = (pendingRequests || []).reduce((sum, row) => sum + Number(row.requested_days || 0), 0)
  const availableOnLeaveDate = dashboard.balance.lots
    .filter((lot) => lot.grantDate <= leaveDate && lot.expiresOn > leaveDate)
    .reduce((sum, lot) => sum + Number(lot.remainingDays || 0), 0)
  const requestableDays = Math.max(0, availableOnLeaveDate - pendingDays)
  if (requestableDays < requestedDays) {
    return NextResponse.json({
      error: `取得日時点の有給残日数が不足します（承認待ちを含む申請可能 ${requestableDays}日）`,
    }, { status: 400 })
  }

  const { data: periods, error: periodsError } = await adminClient
    .from('gw_shift_periods')
    .select('id')
    .in('status', ['confirmed', 'exported', 'archived'])
    .eq('is_test_mode', false)
    .lte('start_date', leaveDate)
    .gte('end_date', leaveDate)
  if (periodsError) throw periodsError
  const periodIds = (periods || []).map((period) => period.id)
  if (periodIds.length === 0) {
    return NextResponse.json({
      error: 'この日の確定シフトがありません。シフト確定前は希望回収画面から申請してください',
    }, { status: 400 })
  }

  const assignmentQuery = adminClient
    .from('gw_shift_assignments')
    .select('id, period_id, work_minutes, start_time, end_time, break_minutes')
    .in('period_id', periodIds)
    .eq('work_date', leaveDate)
    .order('updated_at', { ascending: false })
    .limit(1)
  const { data: assignmentRows, error: assignmentError } = await assignmentQuery
    .or(`employee_id.eq.${dashboard.employee.id},user_id.eq.${user.id}`)
  if (assignmentError) throw assignmentError
  const assignment = assignmentRows?.[0] || null
  const scheduledMinutes = scheduledMinutesFromAssignment(assignment)
  if (!assignment || scheduledMinutes <= 0) {
    return NextResponse.json({
      error: 'この日は確定シフト上の勤務日ではありません。勤務日を確認してください',
    }, { status: 400 })
  }

  const wage = await paidLeaveWageSnapshot(
    dashboard.employee.id,
    scheduledMinutes,
    requestedDays,
    leaveDate as `${number}-${number}-${number}`,
  )
  const { data: createdRequest, error: createError } = await adminClient
    .from('gw_paid_leave_requests')
    .insert({
      employee_id: dashboard.employee.id,
      user_id: user.id,
      leave_date: leaveDate,
      leave_unit: leaveUnit,
      request_source: 'employee',
      request_status: 'submitted',
      shift_period_id: assignment.period_id,
      shift_assignment_id: assignment.id,
      scheduled_minutes_snapshot: scheduledMinutes,
      wage_method: 'ordinary_wage',
      hourly_rate_snapshot: wage.hourlyRate || null,
      payable_minutes_snapshot: wage.payableMinutes,
      paid_wage_amount: wage.amount,
      requested_by: user.id,
      employee_memo: employeeMemo || null,
      raw_payload: {
        wage_basis: wage.basis,
        included_in_monthly_salary: wage.includedInMonthlySalary,
      },
    })
    .select('id')
    .single()
  if (createError) {
    if (createError.code === '23505') {
      return NextResponse.json({ error: 'この日はすでに有給申請が登録されています' }, { status: 409 })
    }
    throw createError
  }

  try {
    const approverIds = await paidLeaveApproverIdsForEmployee(dashboard.employee.id)
    const { data: approvers } = approverIds.length
      ? await adminClient
        .from('gw_users')
        .select('id')
        .in('id', approverIds)
        .eq('status', 'approved')
      : { data: [] }
    const { sendPushNotificationToUser } = await import('@/lib/web-push')
    await Promise.allSettled((approvers || []).map((approver) => sendPushNotificationToUser(approver.id, {
      title: '有給申請が届きました',
      body: `${dashboard.employee.name}さん / ${leaveDate} / ${leaveUnit === 'full_day' ? '全休' : '半休'}`,
      url: '/groups',
      tag: `tsg-paid-leave-request-${createdRequest.id}`,
    })))
  } catch (error) {
    console.error('[Paid leave request push error]', error)
  }

  return NextResponse.json({ success: true, requestId: createdRequest.id })
}

export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

  const requestedUserId = cleanText(request.nextUrl.searchParams.get('user_id'), 80)
  const targetUserId = requestedUserId || user.id
  const viewingAnotherUser = targetUserId !== user.id
  const canViewAs = await canProxyStaffView(user)
  if (viewingAnotherUser && !canViewAs) {
    return NextResponse.json({ error: '代理閲覧は佐藤正彦・佐藤ちさとだけが使用できます' }, { status: 403 })
  }

  try {
    const dashboard = await loadPaidLeaveDashboard(targetUserId, user.id)
    if (viewingAnotherUser) {
      await adminClient.from('gw_proxy_view_audit_logs').insert({
        viewer_user_id: user.id,
        subject_user_id: targetUserId,
        subject_employee_id: dashboard.employee.id,
        screen_key: 'paid_leave',
        request_id: request.headers.get('x-vercel-id') || null,
      })
    }
    return NextResponse.json({
      ...dashboard,
      viewer: {
        userId: user.id,
        canViewAs,
        viewingAs: viewingAnotherUser,
      },
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : '有給情報を取得できませんでした',
    }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const action = cleanText(body.action, 60)
  if (action === 'request_leave') {
    try {
      return await submitPaidLeaveRequest(user, body)
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : '有給申請を送信できませんでした',
      }, { status: 500 })
    }
  }
  if (action !== 'answer_missing') {
    return NextResponse.json({ error: '操作を確認してください' }, { status: 400 })
  }

  const workDate = cleanText(body.work_date, 10)
  const assignmentId = cleanText(body.assignment_id, 80)
  const resolutionType = cleanText(body.resolution_type, 40)
  const employeeMemo = cleanText(body.memo, 500)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate) || !assignmentId || !RESOLUTION_TYPES.has(resolutionType)) {
    return NextResponse.json({ error: '対象日と回答内容を確認してください' }, { status: 400 })
  }

  try {
    const dashboard = await loadPaidLeaveDashboard(user.id, user.id)
    if (!dashboard.managed) {
      return NextResponse.json({ error: 'このアカウントは有給管理の対象外です' }, { status: 403 })
    }
    if (
      resolutionType === 'bereavement_leave'
      && !isRegularEmployeeWorkStyle(dashboard.employee.workStyle)
    ) {
      return NextResponse.json({
        error: '忌引き休を選択できるのは5日正社員・6日正社員だけです',
      }, { status: 403 })
    }
    const unresolved = dashboard.unresolved.find((row) => row.assignmentId === assignmentId && row.workDate === workDate)
    if (!unresolved) {
      return NextResponse.json({ error: 'この勤務日は回答済み、または打刻が確認されています' }, { status: 409 })
    }
    const missingPunchIssue = unresolved.issueKind.startsWith('missing_')
    const allowedResolutionTypes = missingPunchIssue
      ? new Set(['punch_missing', 'paid_leave_full', 'paid_leave_half', 'bereavement_leave', 'absence', 'work_schedule_changed'])
      : new Set(['paid_leave_half', 'absence', 'work_schedule_changed'])
    if (!allowedResolutionTypes.has(resolutionType)) {
      return NextResponse.json({ error: 'この勤怠差異では選択できない回答です' }, { status: 400 })
    }
    if (!missingPunchIssue && !isRegularEmployeeWorkStyle(dashboard.employee.workStyle)) {
      return NextResponse.json({ error: '時間制スタッフの遅刻・早退は実働時間で自動集計されます' }, { status: 400 })
    }
    if (resolutionType === 'work_schedule_changed' && !employeeMemo) {
      return NextResponse.json({ error: '管理者へ連絡する内容を入力してください' }, { status: 400 })
    }

    let paidLeaveRequestId: string | null = null
    let createdPaidLeaveRequest = false
    if (resolutionType === 'paid_leave_full' || resolutionType === 'paid_leave_half') {
      const requestedDays = resolutionType === 'paid_leave_full' ? 1 : 0.5
      if (dashboard.balance.availableDays < requestedDays) {
        return NextResponse.json({ error: `有給残日数が不足しています（残${dashboard.balance.availableDays}日）` }, { status: 400 })
      }
      const scheduledMinutes = unresolved.scheduledMinutes || 0
      const wage = await paidLeaveWageSnapshot(
        dashboard.employee.id,
        scheduledMinutes,
        requestedDays,
        workDate as `${number}-${number}-${number}`,
      )
      const sourceKey = `attendance-resolution:${dashboard.employee.id}:${workDate}`
      const { data: existingLeave, error: existingLeaveError } = await adminClient
        .from('gw_paid_leave_requests')
        .select('id')
        .eq('employee_id', dashboard.employee.id)
        .eq('leave_date', workDate)
        .eq('request_source', 'missing_punch_resolution')
        .maybeSingle()
      if (existingLeaveError) throw existingLeaveError

      const { data: leaveRequest, error: leaveError } = existingLeave
        ? await adminClient
          .from('gw_paid_leave_requests')
          .update({
            request_status: 'submitted',
            leave_unit: resolutionType === 'paid_leave_full' ? 'full_day' : 'half_day',
            scheduled_minutes_snapshot: scheduledMinutes,
            hourly_rate_snapshot: wage.hourlyRate || null,
            payable_minutes_snapshot: wage.payableMinutes,
            paid_wage_amount: wage.amount,
            raw_payload: {
              wage_basis: wage.basis,
              included_in_monthly_salary: wage.includedInMonthlySalary,
            },
            employee_memo: employeeMemo || null,
            rejected_by: null,
            rejected_at: null,
            cancelled_by: null,
            cancelled_at: null,
            source_key: sourceKey,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingLeave.id)
          .select('id')
          .single()
        : await adminClient
        .from('gw_paid_leave_requests')
        .insert({
          employee_id: dashboard.employee.id,
          user_id: user.id,
          leave_date: workDate,
          leave_unit: resolutionType === 'paid_leave_full' ? 'full_day' : 'half_day',
          request_source: 'missing_punch_resolution',
          request_status: 'submitted',
          shift_period_id: unresolved.periodId,
          shift_assignment_id: unresolved.assignmentId,
          scheduled_minutes_snapshot: scheduledMinutes,
          wage_method: 'ordinary_wage',
          hourly_rate_snapshot: wage.hourlyRate || null,
          payable_minutes_snapshot: wage.payableMinutes,
          paid_wage_amount: wage.amount,
          raw_payload: {
            wage_basis: wage.basis,
            included_in_monthly_salary: wage.includedInMonthlySalary,
          },
          requested_by: user.id,
          employee_memo: employeeMemo || null,
          source_key: sourceKey,
        })
        .select('id')
        .single()
      if (leaveError) throw leaveError
      createdPaidLeaveRequest = !existingLeave
      paidLeaveRequestId = leaveRequest.id
    }

    const resolutionSourceKey = `confirmed-shift:${dashboard.employee.id}:${workDate}`
    const { data: existingResolution, error: existingResolutionError } = await adminClient
      .from('gw_workday_resolutions')
      .select('id')
      .eq('source_key', resolutionSourceKey)
      .maybeSingle()
    if (existingResolutionError) throw existingResolutionError

    const resolutionPayload = {
      employee_id: dashboard.employee.id,
      user_id: user.id,
      work_date: workDate,
      shift_period_id: unresolved.periodId,
      shift_assignment_id: unresolved.assignmentId,
      scheduled_minutes_snapshot: unresolved.scheduledMinutes,
      resolution_type: resolutionType,
      resolution_status: 'employee_answered',
      paid_leave_request_id: paidLeaveRequestId,
      employee_answered_by: user.id,
      employee_answered_at: new Date().toISOString(),
      employee_memo: employeeMemo || null,
      source_key: resolutionSourceKey,
      raw_payload: {
        attendance_issue: {
          issue_kind: unresolved.issueKind,
          scheduled_start_time: unresolved.startTime,
          scheduled_end_time: unresolved.endTime,
          actual_start_time: unresolved.actualStartTime,
          actual_end_time: unresolved.actualEndTime,
          late_minutes: unresolved.lateMinutes,
          early_leave_minutes: unresolved.earlyLeaveMinutes,
        },
      },
    }
    const { error: resolutionError } = existingResolution
      ? await adminClient
        .from('gw_workday_resolutions')
        .update(resolutionPayload)
        .eq('id', existingResolution.id)
      : await adminClient
        .from('gw_workday_resolutions')
        .insert(resolutionPayload)
    if (resolutionError) {
      if (paidLeaveRequestId && createdPaidLeaveRequest) {
        await adminClient.from('gw_paid_leave_requests').delete().eq('id', paidLeaveRequestId)
      }
      throw resolutionError
    }

    try {
      const approverIds = await paidLeaveApproverIdsForEmployee(dashboard.employee.id)
      const { sendPushNotificationToUser } = await import('@/lib/web-push')
      const issueLabel = attendanceDeviationLabel(unresolved)
      await Promise.allSettled(approverIds.map((approverId) => sendPushNotificationToUser(approverId, {
        title: '勤怠確認が届きました',
        body: `${dashboard.employee.name}さん / ${workDate} / ${issueLabel}`,
        url: '/groups',
        tag: `tsg-attendance-resolution-${dashboard.employee.id}-${workDate}`,
      })))
    } catch (error) {
      console.error('[Attendance resolution push error]', error)
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : '回答を保存できませんでした',
    }, { status: 500 })
  }
}
