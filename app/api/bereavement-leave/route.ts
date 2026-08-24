import { NextRequest, NextResponse } from 'next/server'
import {
  BEREAVEMENT_POLICY_ROWS,
  BEREAVEMENT_RELATIONSHIPS,
  getBereavementRelationship,
  isRegularEmployeeWorkStyle,
} from '@/lib/bereavement-leave'
import {
  loadBereavementEmployee,
  loadEligibleBereavementEmployees,
  selectBereavementWorkdays,
} from '@/lib/bereavement-leave-data'
import { getManagementPermissions } from '@/lib/management-permissions'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

const REVIEW_ACTIONS = new Set(['approve', 'reject'])

function cleanText(value: unknown, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function formatDateRange(startDate: string, endDate: string) {
  return startDate === endDate ? startDate : `${startDate}〜${endDate}`
}

async function attachAppliedDates<T extends { id: string }>(requests: T[]) {
  if (requests.length === 0) return requests.map((request) => ({ ...request, applied_dates: [] }))

  const { data, error } = await adminClient
    .from('gw_bereavement_leave_request_days')
    .select('request_id, work_date, shift_label_snapshot, scheduled_minutes_snapshot')
    .in('request_id', requests.map((request) => request.id))
    .order('work_date', { ascending: true })
  if (error) throw error

  const daysByRequest = new Map<string, typeof data>()
  for (const day of data || []) {
    const bucket = daysByRequest.get(day.request_id) || []
    bucket.push(day)
    daysByRequest.set(day.request_id, bucket)
  }
  return requests.map((request) => ({
    ...request,
    applied_dates: daysByRequest.get(request.id) || [],
  }))
}

async function notifyManagers(requestId: string, employeeName: string, dateRange: string) {
  try {
    const { data: managers } = await adminClient
      .from('gw_users')
      .select('id')
      .in('role', ['executive', 'admin'])
      .eq('status', 'approved')
    const { sendPushNotificationToUser } = await import('@/lib/web-push')
    await Promise.allSettled((managers || []).map((manager) => sendPushNotificationToUser(manager.id, {
      title: '忌引き休暇申請が届きました',
      body: `${employeeName}さん / ${dateRange}`,
      url: '/admin',
      tag: `tsg-bereavement-request-${requestId}`,
    })))
  } catch (error) {
    console.error('[Bereavement request push error]', error)
  }
}

async function notifyEmployee(
  userId: string,
  requestId: string,
  title: string,
  body: string,
) {
  try {
    const { sendPushNotificationToUser } = await import('@/lib/web-push')
    await sendPushNotificationToUser(userId, {
      title,
      body,
      url: '/admin',
      tag: `tsg-bereavement-result-${requestId}`,
    })
  } catch (error) {
    console.error('[Bereavement result push error]', error)
  }
}

export async function GET() {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

  try {
    const permissions = getManagementPermissions(user)
    const canManage = permissions.canManageAttendance
    const employee = await loadBereavementEmployee(user.id)
    const eligible = Boolean(employee && isRegularEmployeeWorkStyle(employee.work_style))

    const ownRequestQuery = adminClient
      .from('gw_bereavement_leave_requests')
      .select('*')
      .eq('user_id', user.id)
      .order('leave_start_date', { ascending: false })
      .limit(100)
    const { data: ownRequests, error: ownRequestsError } = await ownRequestQuery
    if (ownRequestsError) throw ownRequestsError

    let employees: Awaited<ReturnType<typeof loadEligibleBereavementEmployees>> = []
    const ownRequestsWithDates = await attachAppliedDates(ownRequests || [])
    let requests: Array<Record<string, unknown> & { id: string }> = []
    if (canManage) {
      employees = await loadEligibleBereavementEmployees()
      const { data: managerRequests, error: managerRequestsError } = await adminClient
        .from('gw_bereavement_leave_requests')
        .select('*')
        .order('requested_at', { ascending: false })
        .limit(300)
      if (managerRequestsError) throw managerRequestsError

      const employeeIds = [...new Set((managerRequests || []).map((row) => row.employee_id))]
      const { data: requestEmployees, error: requestEmployeesError } = employeeIds.length
        ? await adminClient
          .from('gw_payroll_employees')
          .select('id, employee_code, display_name, real_name, department, work_style, payroll_status')
          .in('id', employeeIds)
        : { data: [], error: null }
      if (requestEmployeesError) throw requestEmployeesError
      const employeeById = new Map((requestEmployees || []).map((item) => [item.id, item]))
      const managerRequestsWithDates = await attachAppliedDates(managerRequests || [])
      requests = managerRequestsWithDates.map((requestRow) => ({
        ...requestRow,
        employee: employeeById.get(requestRow.employee_id) || null,
      }))
    }

    return NextResponse.json({
      canManage,
      eligibility: {
        eligible,
        reason: eligible
          ? null
          : employee
            ? '忌引き休暇は5日正社員・6日正社員が対象です'
            : '人事情報と連携された在籍中の社員データがありません',
        employee,
      },
      relationships: BEREAVEMENT_RELATIONSHIPS,
      policy: BEREAVEMENT_POLICY_ROWS,
      ownRequests: ownRequestsWithDates,
      employees,
      requests,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : '忌引き休暇情報を取得できませんでした',
    }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const action = cleanText(body.action, 40)

  try {
    if (action === 'preview' || action === 'submit') {
      const employee = await loadBereavementEmployee(user.id)
      if (!employee || !isRegularEmployeeWorkStyle(employee.work_style)) {
        return NextResponse.json({
          error: '忌引き休暇を申請できるのは5日正社員・6日正社員だけです',
        }, { status: 403 })
      }

      const relationship = getBereavementRelationship(body.relationship_code)
      const startDate = cleanText(body.leave_start_date, 10)
      const employeeMemo = cleanText(body.employee_memo, 500)
      const requestedDays = Number(body.requested_days)
      if (!relationship) {
        return NextResponse.json({ error: '亡くなられた方との続柄を選択してください' }, { status: 400 })
      }
      if (!Number.isInteger(requestedDays) || requestedDays < 1) {
        return NextResponse.json({ error: '取得開始日と取得日数を確認してください' }, { status: 400 })
      }
      if (requestedDays > relationship.entitledDays) {
        return NextResponse.json({
          error: `${relationship.label}の忌引き休暇は最大${relationship.entitledDays}日です`,
        }, { status: 400 })
      }

      const selection = await selectBereavementWorkdays({
        userId: user.id,
        startDate,
        requestedDays,
      })
      if (action === 'preview') {
        return NextResponse.json({ success: true, selection })
      }

      const { data: overlapping, error: overlappingError } = await adminClient
        .from('gw_bereavement_leave_requests')
        .select('id')
        .eq('employee_id', employee.id)
        .in('request_status', ['submitted', 'approved'])
        .lte('leave_start_date', selection.leaveEndDate)
        .gte('leave_end_date', startDate)
        .limit(1)
      if (overlappingError) throw overlappingError
      if (overlapping?.length) {
        return NextResponse.json({ error: '同じ期間に承認待ちまたは承認済みの忌引き休暇があります' }, { status: 409 })
      }

      const { data: created, error: createError } = await adminClient
        .from('gw_bereavement_leave_requests')
        .insert({
          employee_id: employee.id,
          user_id: user.id,
          relationship_code: relationship.code,
          relationship_label: relationship.label,
          relationship_degree: relationship.degree,
          entitled_days: relationship.entitledDays,
          leave_start_date: startDate,
          leave_end_date: selection.leaveEndDate,
          requested_days: requestedDays,
          counting_method: 'confirmed_workdays',
          request_status: 'submitted',
          employee_memo: employeeMemo || null,
          requested_by: user.id,
        })
        .select('id')
        .single()
      if (createError) {
        if (createError.code === '23505') {
          return NextResponse.json({ error: '同じ期間の忌引き休暇がすでに申請されています' }, { status: 409 })
        }
        throw createError
      }

      const { error: dayError } = await adminClient
        .from('gw_bereavement_leave_request_days')
        .insert(selection.workdays.map((day) => ({
          request_id: created.id,
          work_date: day.workDate,
          shift_period_id: day.periodId,
          shift_assignment_id: day.assignmentId,
          shift_label_snapshot: day.shiftLabel,
          scheduled_minutes_snapshot: day.scheduledMinutes,
        })))
      if (dayError) {
        await adminClient.from('gw_bereavement_leave_requests').delete().eq('id', created.id)
        throw dayError
      }

      await notifyManagers(
        created.id,
        employee.real_name || employee.display_name,
        `${formatDateRange(startDate, selection.leaveEndDate)} / 勤務日${requestedDays}日`,
      )
      return NextResponse.json({
        success: true,
        requestId: created.id,
        appliedDates: selection.appliedDates,
        skippedDates: selection.skippedDates,
      })
    }

    const requestId = cleanText(body.request_id, 80)
    if (!requestId) {
      return NextResponse.json({ error: '対象の申請を確認してください' }, { status: 400 })
    }

    const { data: targetRequest, error: targetError } = await adminClient
      .from('gw_bereavement_leave_requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle()
    if (targetError) throw targetError
    if (!targetRequest) {
      return NextResponse.json({ error: '忌引き休暇申請が見つかりません' }, { status: 404 })
    }

    const permissions = getManagementPermissions(user)
    const canManage = permissions.canManageAttendance
    const managerMemo = cleanText(body.manager_memo, 500)
    const now = new Date().toISOString()

    if (REVIEW_ACTIONS.has(action)) {
      if (!canManage) {
        return NextResponse.json({ error: '忌引き休暇を承認する権限がありません' }, { status: 403 })
      }
      if (targetRequest.request_status !== 'submitted') {
        return NextResponse.json({ error: 'この申請はすでに処理されています' }, { status: 409 })
      }

      const approved = action === 'approve'
      const { data: updatedRows, error: updateError } = await adminClient
        .from('gw_bereavement_leave_requests')
        .update(approved ? {
          request_status: 'approved',
          manager_memo: managerMemo || null,
          approved_by: user.id,
          approved_at: now,
          rejected_by: null,
          rejected_at: null,
          updated_at: now,
        } : {
          request_status: 'rejected',
          manager_memo: managerMemo || null,
          rejected_by: user.id,
          rejected_at: now,
          approved_by: null,
          approved_at: null,
          updated_at: now,
        })
        .eq('id', requestId)
        .eq('request_status', 'submitted')
        .select('id')
      if (updateError) throw updateError
      if (!updatedRows?.length) {
        return NextResponse.json({ error: '申請状態が変更されています。画面を更新してください' }, { status: 409 })
      }

      await notifyEmployee(
        targetRequest.user_id,
        requestId,
        approved ? '忌引き休暇が承認されました' : '忌引き休暇が却下されました',
        `${formatDateRange(targetRequest.leave_start_date, targetRequest.leave_end_date)} / ${targetRequest.requested_days}日`,
      )
      return NextResponse.json({ success: true, status: approved ? 'approved' : 'rejected' })
    }

    if (action === 'cancel') {
      const isOwnRequest = targetRequest.user_id === user.id
      if (!isOwnRequest && !canManage) {
        return NextResponse.json({ error: 'この申請を取り消す権限がありません' }, { status: 403 })
      }
      const cancellableStatuses = canManage ? ['submitted', 'approved'] : ['submitted']
      if (!cancellableStatuses.includes(targetRequest.request_status)) {
        return NextResponse.json({
          error: isOwnRequest
            ? '承認後の取消しは管理者へ連絡してください'
            : 'この申請は取り消せません',
        }, { status: 409 })
      }

      const { data: cancelledRows, error: cancelError } = await adminClient
        .from('gw_bereavement_leave_requests')
        .update({
          request_status: 'cancelled',
          manager_memo: managerMemo || targetRequest.manager_memo || null,
          cancelled_by: user.id,
          cancelled_at: now,
          updated_at: now,
        })
        .eq('id', requestId)
        .in('request_status', cancellableStatuses)
        .select('id')
      if (cancelError) throw cancelError
      if (!cancelledRows?.length) {
        return NextResponse.json({ error: '申請状態が変更されています。画面を更新してください' }, { status: 409 })
      }

      if (canManage && !isOwnRequest) {
        await notifyEmployee(
          targetRequest.user_id,
          requestId,
          '忌引き休暇が取り消されました',
          formatDateRange(targetRequest.leave_start_date, targetRequest.leave_end_date),
        )
      }
      return NextResponse.json({ success: true, status: 'cancelled' })
    }

    return NextResponse.json({ error: '操作を確認してください' }, { status: 400 })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : '忌引き休暇を更新できませんでした',
    }, { status: 500 })
  }
}
