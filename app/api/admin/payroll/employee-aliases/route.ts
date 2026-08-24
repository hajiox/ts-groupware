import { NextResponse } from 'next/server'
import { getManagementPermissions } from '@/lib/management-permissions'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

type PayrollAlias = {
  source_employee_id: string
  name: string
  employee_code: string | null
  linked_at: string
  linked_by: string
}

type EmployeeRow = {
  id: string
  user_id: string | null
  employee_code: string | null
  display_name: string
  real_name: string | null
  payroll_status: string
  raw_payload: Record<string, unknown> | null
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function employeeName(employee: EmployeeRow) {
  return employee.real_name || employee.display_name
}

function aliasesFromPayload(rawPayload: Record<string, unknown> | null): PayrollAlias[] {
  const hrProfile = objectValue(rawPayload?.hr_profile)
  const value = hrProfile.payroll_name_aliases
  if (!Array.isArray(value)) return []
  return value.filter((row): row is PayrollAlias => (
    !!row
    && typeof row === 'object'
    && typeof (row as PayrollAlias).source_employee_id === 'string'
    && typeof (row as PayrollAlias).name === 'string'
  ))
}

export async function POST(request: Request) {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

  const permissions = getManagementPermissions(user)
  if (!permissions.canViewPayroll) {
    return NextResponse.json({ error: '給与計算の管理権限が必要です' }, { status: 403 })
  }

  const body = await request.json().catch(() => null) as {
    targetEmployeeId?: string
    sourceEmployeeId?: string
  } | null
  if (!body?.targetEmployeeId || !body.sourceEmployeeId) {
    return NextResponse.json({ error: '統合する社員を指定してください' }, { status: 400 })
  }
  if (body.targetEmployeeId === body.sourceEmployeeId) {
    return NextResponse.json({ error: '同じ社員は統合できません' }, { status: 400 })
  }

  const { data: employees, error: employeesError } = await adminClient
    .from('gw_payroll_employees')
    .select('id, user_id, employee_code, display_name, real_name, payroll_status, raw_payload')
    .in('id', [body.targetEmployeeId, body.sourceEmployeeId])

  if (employeesError) return NextResponse.json({ error: employeesError.message }, { status: 500 })
  const rows = (employees || []) as EmployeeRow[]
  const target = rows.find((employee) => employee.id === body.targetEmployeeId)
  const source = rows.find((employee) => employee.id === body.sourceEmployeeId)
  if (!target || !source) {
    return NextResponse.json({ error: '社員情報が見つかりません' }, { status: 404 })
  }
  if (!target.user_id) {
    return NextResponse.json({ error: '統合先はTSG連携済み社員を選んでください' }, { status: 409 })
  }
  if (source.user_id && source.user_id !== target.user_id) {
    return NextResponse.json({ error: '別のTSGユーザーに連携済みの社員は統合できません' }, { status: 409 })
  }

  const now = new Date().toISOString()
  const aliases = aliasesFromPayload(target.raw_payload)
  const nextAlias: PayrollAlias = {
    source_employee_id: source.id,
    name: employeeName(source),
    employee_code: source.employee_code,
    linked_at: now,
    linked_by: user.id,
  }
  const nextAliases = [
    ...aliases.filter((alias) => alias.source_employee_id !== source.id),
    nextAlias,
  ]
  const targetProfile = objectValue(target.raw_payload?.hr_profile)
  const sourcePayload = source.raw_payload || {}

  const [targetUpdate, sourceUpdate] = await Promise.all([
    adminClient
      .from('gw_payroll_employees')
      .update({
        raw_payload: {
          ...(target.raw_payload || {}),
          hr_profile: {
            ...targetProfile,
            payroll_name_aliases: nextAliases,
          },
        },
        updated_at: now,
      })
      .eq('id', target.id),
    adminClient
      .from('gw_payroll_employees')
      .update({
        payroll_status: 'inactive',
        raw_payload: {
          ...sourcePayload,
          payroll_alias_of: {
            employee_id: target.id,
            employee_name: employeeName(target),
            linked_at: now,
            linked_by: user.id,
          },
        },
        updated_at: now,
      })
      .eq('id', source.id),
  ])

  const updateError = targetUpdate.error || sourceUpdate.error
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    targetEmployee: { id: target.id, name: employeeName(target) },
    alias: nextAlias,
  })
}
