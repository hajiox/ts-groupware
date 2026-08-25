import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUserDepartment } from '@/lib/departments'
import { getUserSession } from '@/lib/session'
import {
  isExecutiveUser,
  isFixedExecutiveUser,
  isManagementUser,
  isUserRole,
} from '@/lib/user-roles'

/**
 * 管理者用 API
 *
 * GET  /api/admin/users — 全ユーザー一覧
 * PUT  /api/admin/users — ユーザーの表示名・権限・承認状態変更
 * DELETE /api/admin/users — ユーザー削除
 */

async function requireAdmin() {
  const user = await getUserSession()
  if (!user) return { error: '認証が必要です', status: 401, user: null }
  if (!isManagementUser(user)) return { error: '役員または管理者権限が必要です', status: 403, user: null }
  return { error: null, status: 0, user }
}

function normalizedPersonName(value: string | null | undefined) {
  return (value || '').normalize('NFKC').replace(/[\s　]+/g, '').trim()
}

function hrProfile(rawPayload: Record<string, unknown> | null | undefined) {
  const value = rawPayload?.hr_profile
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

async function adoptProvisionalEmployee(targetUserId: string, targetName: string) {
  const { data: employeeRows, error } = await adminClient
    .from('gw_payroll_employees')
    .select('id, user_id, display_name, real_name, hire_date, payroll_status, raw_payload')
  if (error) throw error

  const normalizedTarget = normalizedPersonName(targetName)
  const candidates = (employeeRows || []).filter((employee) => {
    const profile = hrProfile(employee.raw_payload as Record<string, unknown> | null)
    return profile.provisional_hire === true &&
      normalizedPersonName(employee.real_name || employee.display_name) === normalizedTarget
  })
  if (candidates.length !== 1) return

  const employee = candidates[0]
  if (!employee.user_id || employee.user_id === targetUserId) return
  const { data: provisionalUser, error: provisionalError } = await adminClient
    .from('gw_users')
    .select('id, line_user_id')
    .eq('id', employee.user_id)
    .maybeSingle()
  if (provisionalError) throw provisionalError
  if (!provisionalUser?.line_user_id?.startsWith('provisional:doc-scanner:')) return

  const placeholderUserId = employee.user_id

  // LINE承認が先、本名設定が後になった場合は同期トリガーが一時的な
  // 社員行を作ることがある。打刻を正しい仮入社員行へ寄せてから退避する。
  const { data: linkedEmployee, error: linkedEmployeeError } = await adminClient
    .from('gw_payroll_employees')
    .select('id, raw_payload')
    .eq('user_id', targetUserId)
    .neq('id', employee.id)
    .maybeSingle()
  if (linkedEmployeeError) throw linkedEmployeeError

  if (linkedEmployee) {
    for (const table of ['gw_attendance_punches', 'gw_attendance_corrections', 'gw_attendance_daily_records']) {
      const { error: employeeMigrationError } = await adminClient
        .from(table)
        .update({ employee_id: employee.id })
        .eq('employee_id', linkedEmployee.id)
      if (employeeMigrationError) throw employeeMigrationError
    }

    const linkedPayload = (linkedEmployee.raw_payload as Record<string, unknown> | null) || {}
    const { error: retireDuplicateError } = await adminClient
      .from('gw_payroll_employees')
      .update({
        user_id: null,
        payroll_status: 'inactive',
        raw_payload: {
          ...linkedPayload,
          identity_merge: {
            merged_into_employee_id: employee.id,
            merged_at: new Date().toISOString(),
          },
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', linkedEmployee.id)
    if (retireDuplicateError) throw retireDuplicateError
  }

  const linkedTables = [
    'gw_shift_assignments',
    'gw_shift_requests',
    'gw_shift_request_targets',
    'gw_shift_request_submissions',
    'gw_shift_period_exclusions',
  ]
  for (const table of linkedTables) {
    const { error: migrationError } = await adminClient
      .from(table)
      .update({ user_id: targetUserId })
      .eq('employee_id', employee.id)
      .eq('user_id', placeholderUserId)
    if (migrationError) throw migrationError
  }

  const profile = hrProfile(employee.raw_payload as Record<string, unknown> | null)
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
  const isStarted = !employee.hire_date || employee.hire_date <= today
  const { error: employeeError } = await adminClient
    .from('gw_payroll_employees')
    .update({
      user_id: targetUserId,
      display_name: targetName,
      real_name: targetName,
      payroll_status: isStarted ? 'active' : employee.payroll_status,
      raw_payload: {
        ...((employee.raw_payload as Record<string, unknown> | null) || {}),
        hr_profile: {
          ...profile,
          provisional_hire: !isStarted,
          request_collection_excluded: !isStarted,
          provisional_shift_user_id: null,
          tsg_linked_at: new Date().toISOString(),
        },
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', employee.id)
  if (employeeError) throw employeeError

  const { data: styles, error: stylesError } = await adminClient
    .from('gw_shift_cell_styles')
    .select('id')
    .eq('cell_key', `user:${placeholderUserId}`)
  if (stylesError) throw stylesError
  if (styles?.length) {
    const { error: styleUpdateError } = await adminClient
      .from('gw_shift_cell_styles')
      .update({ cell_key: `user:${targetUserId}`, updated_at: new Date().toISOString() })
      .in('id', styles.map((style) => style.id))
    if (styleUpdateError) throw styleUpdateError
  }

  const { error: deleteError } = await adminClient.from('gw_users').delete().eq('id', placeholderUserId)
  if (deleteError) throw deleteError
}

export async function GET() {
  const { error, status } = await requireAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const { data: users, error: dbError } = await adminClient
    .from('gw_users')
    .select('id, display_name, real_name, picture_url, role, department, status, line_user_id, created_at, updated_at')
    .not('line_user_id', 'like', 'provisional:doc-scanner:%')
    .order('created_at', { ascending: true })

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  const userRows = users || []
  const userIds = userRows.map((user) => user.id)
  const employmentByUserId = new Map<string, {
    payroll_status: string
    resigned_date: string | null
  }>()

  if (userIds.length > 0) {
    const { data: employees, error: employeeError } = await adminClient
      .from('gw_payroll_employees')
      .select('user_id, payroll_status, resigned_date')
      .in('user_id', userIds)

    if (employeeError) {
      return NextResponse.json({ error: employeeError.message }, { status: 500 })
    }

    for (const employee of employees || []) {
      if (!employee.user_id) continue
      const existing = employmentByUserId.get(employee.user_id)
      // A retired record must win if legacy data contains more than one linked row.
      if (!existing || employee.payroll_status === 'retired') {
        employmentByUserId.set(employee.user_id, {
          payroll_status: employee.payroll_status,
          resigned_date: employee.resigned_date,
        })
      }
    }
  }

  return NextResponse.json({
    users: userRows.map((user) => ({
      ...user,
      payroll_status: employmentByUserId.get(user.id)?.payroll_status || null,
      resigned_date: employmentByUserId.get(user.id)?.resigned_date || null,
    })),
  })
}

export async function PUT(request: NextRequest) {
  const { error, status, user } = await requireAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const body = await request.json()
  const { user_id, role, status: userStatus, display_name, real_name, department } = body

  if (!user_id) {
    return NextResponse.json({ error: 'user_id が必要です' }, { status: 400 })
  }

  if (!role && !userStatus && display_name === undefined && real_name === undefined && department === undefined) {
    return NextResponse.json({ error: '更新項目がありません' }, { status: 400 })
  }

  if (role && !isUserRole(role)) {
    return NextResponse.json({ error: '権限は役員・管理者・ユーザーのいずれかです' }, { status: 400 })
  }

  if (userStatus && !['pending', 'approved', 'suspended'].includes(userStatus)) {
    return NextResponse.json({ error: 'status は pending, approved, suspended のいずれかです' }, { status: 400 })
  }

  if (department !== undefined && !isUserDepartment(department)) {
    return NextResponse.json({ error: 'department は フロア, 製造, 道の駅 のいずれかです' }, { status: 400 })
  }

  if (display_name !== undefined) {
    const normalizedName = String(display_name).trim()
    if (!normalizedName) {
      return NextResponse.json({ error: '表示名を入力してください' }, { status: 400 })
    }
    if (normalizedName.length > 80) {
      return NextResponse.json({ error: '表示名は80文字以内で入力してください' }, { status: 400 })
    }
  }

  if (real_name !== undefined) {
    const normalizedRealName = real_name === null ? null : String(real_name).trim()
    if (normalizedRealName && normalizedRealName.length > 80) {
      return NextResponse.json({ error: '本名は80文字以内で入力してください' }, { status: 400 })
    }
  }

  if (user_id === user!.id && userStatus && userStatus !== 'approved') {
    return NextResponse.json({ error: '自分自身を未承認または停止にはできません' }, { status: 400 })
  }

  const { data: targetUser, error: targetError } = await adminClient
    .from('gw_users')
    .select('id, role, status, display_name, real_name, department')
    .eq('id', user_id)
    .maybeSingle()

  if (targetError) {
    return NextResponse.json({ error: targetError.message }, { status: 500 })
  }
  if (!targetUser) {
    return NextResponse.json({ error: 'ユーザーが見つかりません' }, { status: 404 })
  }

  if (userStatus === 'approved' && targetUser.status !== 'approved') {
    const approvalName = String(real_name ?? targetUser.real_name ?? '').trim()
    const approvalDepartment = department ?? targetUser.department
    if (!approvalName || !isUserDepartment(approvalDepartment)) {
      return NextResponse.json(
        { error: '承認前に本名と所属を設定してください' },
        { status: 400 },
      )
    }
  }

  const targetIsFixedExecutive = isFixedExecutiveUser(targetUser)
  const targetIsExecutive = isExecutiveUser(targetUser)
  if (targetIsExecutive && !isExecutiveUser(user)) {
    return NextResponse.json({ error: '役員アカウントの変更には役員権限が必要です' }, { status: 403 })
  }
  if (role === 'executive' && !targetIsFixedExecutive) {
    return NextResponse.json({ error: '役員権限は佐藤正彦・佐藤ちさとのみ設定できます' }, { status: 400 })
  }
  if (role && targetIsExecutive && role !== 'executive') {
    return NextResponse.json({ error: '役員2名の権限は変更できません' }, { status: 400 })
  }
  if (userStatus && targetIsExecutive && userStatus !== 'approved') {
    return NextResponse.json({ error: '役員アカウントは停止できません' }, { status: 400 })
  }
  if (role === 'executive' && !isExecutiveUser(user)) {
    return NextResponse.json({ error: '役員権限の設定には役員権限が必要です' }, { status: 403 })
  }
  if (user_id === user!.id && role && !['executive', 'admin'].includes(role)) {
    return NextResponse.json({ error: '自分自身の管理権限は外せません' }, { status: 400 })
  }

  if ((userStatus || targetUser.status) === 'approved') {
    const finalName = String(real_name ?? targetUser.real_name ?? display_name ?? targetUser.display_name ?? '').trim()
    if (finalName) await adoptProvisionalEmployee(user_id, finalName)
  }

  const updates: Record<string, string | null> = {
    updated_at: new Date().toISOString(),
  }
  if (display_name !== undefined) updates.display_name = String(display_name).trim()
  if (real_name !== undefined) updates.real_name = real_name ? String(real_name).trim() : null
  if (role) updates.role = role
  if (department !== undefined) updates.department = department
  if (userStatus) updates.status = userStatus

  const { error: dbError } = await adminClient
    .from('gw_users')
    .update(updates)
    .eq('id', user_id)

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

export async function DELETE(request: NextRequest) {
  const { error, status, user } = await requireAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const body = await request.json()
  const { user_id } = body

  if (!user_id) {
    return NextResponse.json({ error: 'user_id が必要です' }, { status: 400 })
  }

  // 自分自身は削除不可
  if (user_id === user!.id) {
    return NextResponse.json({ error: '自分自身は削除できません' }, { status: 400 })
  }

  const { data: targetUser, error: targetError } = await adminClient
    .from('gw_users')
    .select('id, role, display_name, real_name')
    .eq('id', user_id)
    .maybeSingle()

  if (targetError) {
    return NextResponse.json({ error: targetError.message }, { status: 500 })
  }
  if (!targetUser) {
    return NextResponse.json({ error: 'ユーザーが見つかりません' }, { status: 404 })
  }
  if (isExecutiveUser(targetUser)) {
    return NextResponse.json({ error: '役員アカウントは削除できません' }, { status: 400 })
  }

  const { data: linkedEmployee, error: linkedEmployeeError } = await adminClient
    .from('gw_payroll_employees')
    .select('id, payroll_status')
    .eq('user_id', user_id)
    .maybeSingle()

  if (linkedEmployeeError) {
    return NextResponse.json({ error: linkedEmployeeError.message }, { status: 500 })
  }
  if (linkedEmployee) {
    return NextResponse.json({
      error: '人事・給与・勤怠に連携済みのユーザーは削除できません。人事管理の「退職処理」を使用してください。',
    }, { status: 409 })
  }

  // グループメンバーシップを削除
  await adminClient.from('gw_group_members').delete().eq('user_id', user_id)
  // リアクションを削除
  await adminClient.from('gw_reactions').delete().eq('user_id', user_id)
  // 既読ステータスを削除
  await adminClient.from('gw_read_status').delete().eq('user_id', user_id)
  // Push購読を削除
  await adminClient.from('gw_push_subscriptions').delete().eq('user_id', user_id)
  // ユーザーを削除
  const { error: dbError } = await adminClient.from('gw_users').delete().eq('id', user_id)

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
