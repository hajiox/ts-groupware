import { NextResponse } from 'next/server'
import { getManagementPermissions } from '@/lib/management-permissions'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

type PayrollEmployeeRow = {
  id: string
  user_id: string | null
  employee_code: string | null
  display_name: string
  real_name: string | null
  kana: string | null
  birth_date: string | null
  hire_date: string | null
  resigned_date: string | null
  gender: string | null
  department: string | null
  default_workplace_id: string | null
  employment_type: string
  pay_type: string
  payroll_status: string
  created_at: string
  updated_at: string
}

const payrollStatuses = new Set(['active', 'inactive', 'retired'])

export async function GET() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const permissions = getManagementPermissions(user)
  if (!permissions.canViewPayroll) {
    return NextResponse.json({ error: '給与管理権限が必要です' }, { status: 403 })
  }

  const [
    { data: employees, error: employeesError },
    { data: users, error: usersError },
    { data: workplaces, error: workplacesError },
  ] = await Promise.all([
    adminClient
      .from('gw_payroll_employees')
      .select('id, user_id, employee_code, display_name, real_name, kana, birth_date, hire_date, resigned_date, gender, department, default_workplace_id, employment_type, pay_type, payroll_status, created_at, updated_at')
      .order('employee_code', { ascending: true, nullsFirst: false })
      .order('display_name', { ascending: true }),
    adminClient
      .from('gw_users')
      .select('id, display_name, real_name, picture_url, department, status'),
    adminClient
      .from('gw_workplaces')
      .select('id, code, name, department'),
  ])

  const dbError = employeesError || usersError || workplacesError
  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  const userMap = Object.fromEntries((users || []).map((row) => [row.id, row]))
  const workplaceMap = Object.fromEntries((workplaces || []).map((row) => [row.id, row]))
  const rows = ((employees || []) as PayrollEmployeeRow[]).map((employee) => ({
    ...employee,
    user: employee.user_id ? userMap[employee.user_id] || null : null,
    workplace: employee.default_workplace_id ? workplaceMap[employee.default_workplace_id] || null : null,
  }))

  return NextResponse.json({
    employees: rows,
    users: users || [],
    summary: {
      total: rows.length,
      withEmployeeCode: rows.filter((row) => !!row.employee_code).length,
      linkedUsers: rows.filter((row) => !!row.user_id).length,
      codedAndLinked: rows.filter((row) => !!row.employee_code && !!row.user_id).length,
      active: rows.filter((row) => row.payroll_status === 'active').length,
      retired: rows.filter((row) => row.payroll_status === 'retired').length,
      unlinked: rows.filter((row) => !row.user_id).length,
    },
  })
}

export async function PATCH(request: Request) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const permissions = getManagementPermissions(user)
  if (!permissions.canViewPayroll) {
    return NextResponse.json({ error: '給与管理権限が必要です' }, { status: 403 })
  }

  const body = await request.json().catch(() => null) as {
    id?: string
    user_id?: string | null
    payroll_status?: string
  } | null

  if (!body?.id) {
    return NextResponse.json({ error: '従業員IDが必要です' }, { status: 400 })
  }

  const updates: Record<string, string | null> = {
    updated_at: new Date().toISOString(),
  }

  if ('payroll_status' in body) {
    if (!body.payroll_status || !payrollStatuses.has(body.payroll_status)) {
      return NextResponse.json({ error: '在籍ステータスが不正です' }, { status: 400 })
    }
    if (body.payroll_status === 'retired') {
      return NextResponse.json({ error: '退職は人事管理の「退職処理」から実行してください' }, { status: 400 })
    }
    updates.payroll_status = body.payroll_status
  }

  if ('user_id' in body) {
    if (body.user_id) {
      const { data: targetUser, error: userError } = await adminClient
        .from('gw_users')
        .select('id')
        .eq('id', body.user_id)
        .maybeSingle()

      if (userError) {
        return NextResponse.json({ error: userError.message }, { status: 500 })
      }
      if (!targetUser) {
        return NextResponse.json({ error: '指定されたTSGユーザーが見つかりません' }, { status: 404 })
      }

      const { data: existingEmployee, error: existingError } = await adminClient
        .from('gw_payroll_employees')
        .select('id')
        .eq('user_id', body.user_id)
        .neq('id', body.id)
        .maybeSingle()

      if (existingError) {
        return NextResponse.json({ error: existingError.message }, { status: 500 })
      }
      if (existingEmployee) {
        return NextResponse.json({ error: 'このTSGユーザーは別の従業員に連携済みです' }, { status: 409 })
      }
    }

    updates.user_id = body.user_id || null
  }

  const { error } = await adminClient
    .from('gw_payroll_employees')
    .update(updates)
    .eq('id', body.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
