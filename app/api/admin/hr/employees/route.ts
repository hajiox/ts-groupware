import { NextResponse } from 'next/server'
import { getManagementPermissions } from '@/lib/management-permissions'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

type HRProfile = {
  phone?: string
  email?: string
  postal_code?: string
  address?: string
  emergency_contact_name?: string
  emergency_contact_phone?: string
  education_history?: string
  work_history?: string
  qualifications?: string
  personal_statement?: string
  resume_notes?: string
  hiring_contact_email_content?: string
  memo?: string
  basic_work_start?: string | null
  basic_work_end?: string | null
  basic_break_minutes?: number | null
  deleted_at?: string
  deleted_by?: string
  delete_reason?: string
}

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
  work_style: string | null
  employment_type: string
  pay_type: string
  payroll_status: string
  raw_payload: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

type PayrollResultRow = {
  employee_id: string
}

type ResumeDocumentRow = {
  id: string
  employee_id: string
  file_name: string
  file_size: number
  ocr_status: string
  ocr_model: string | null
  ocr_error: string | null
  extracted_data: Record<string, unknown> | null
  processed_at: string | null
  created_at: string
}

const payrollStatuses = new Set(['active', 'inactive', 'retired'])
const workStyles = new Set([
  'regular_5d_8h',
  'regular_6d_6_5h',
  'part_time_under_29_5h',
  'full_time_part',
  'officer',
])
const genders = new Set(['male', 'female', 'other', 'unknown'])

function normalizeDateInput(value: unknown) {
  if (!value) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  return value
}

function normalizeTimeInput(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return undefined
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function hrProfile(rawPayload: Record<string, unknown> | null | undefined): HRProfile {
  const value = rawPayload?.hr_profile
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as HRProfile
}

function mergeHRProfile(rawPayload: Record<string, unknown> | null | undefined, profile: HRProfile) {
  return {
    ...(rawPayload || {}),
    hr_profile: {
      ...hrProfile(rawPayload),
      ...profile,
    },
  }
}

async function requireHRPermission() {
  const user = await getUserSession()
  if (!user) return { error: NextResponse.json({ error: '認証が必要です' }, { status: 401 }) }

  const permissions = getManagementPermissions(user)
  if (!permissions.canViewPayroll) {
    return { error: NextResponse.json({ error: '人事管理権限が必要です' }, { status: 403 }) }
  }

  return { user }
}

export async function GET() {
  const auth = await requireHRPermission()
  if (auth.error) return auth.error

  const [
    { data: employees, error: employeesError },
    { data: users, error: usersError },
    { data: workplaces, error: workplacesError },
    { data: payrollResults, error: payrollResultsError },
    { data: resumeDocuments, error: resumeDocumentsError },
  ] = await Promise.all([
    adminClient
      .from('gw_payroll_employees')
      .select('id, user_id, employee_code, display_name, real_name, kana, birth_date, hire_date, resigned_date, gender, department, default_workplace_id, work_style, employment_type, pay_type, payroll_status, raw_payload, created_at, updated_at')
      .order('employee_code', { ascending: true, nullsFirst: false })
      .order('display_name', { ascending: true }),
    adminClient
      .from('gw_users')
      .select('id, display_name, real_name, picture_url, department, status'),
    adminClient
      .from('gw_workplaces')
      .select('id, code, name, department'),
    adminClient
      .from('gw_payroll_employee_results')
      .select('employee_id'),
    adminClient
      .from('gw_hr_documents')
      .select('id, employee_id, file_name, file_size, ocr_status, ocr_model, ocr_error, extracted_data, processed_at, created_at')
      .eq('document_type', 'resume')
      .eq('is_current', true)
      .order('created_at', { ascending: false }),
  ])

  const dbError = employeesError || usersError || workplacesError || payrollResultsError || resumeDocumentsError
  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  const userMap = Object.fromEntries((users || []).map((row) => [row.id, row]))
  const workplaceMap = Object.fromEntries((workplaces || []).map((row) => [row.id, row]))
  const resultCountMap = new Map<string, number>()
  const resumeDocumentMap = new Map<string, ResumeDocumentRow>()
  for (const result of (payrollResults || []) as PayrollResultRow[]) {
    resultCountMap.set(result.employee_id, (resultCountMap.get(result.employee_id) || 0) + 1)
  }
  for (const document of (resumeDocuments || []) as ResumeDocumentRow[]) {
    if (!resumeDocumentMap.has(document.employee_id)) resumeDocumentMap.set(document.employee_id, document)
  }

  const rows = ((employees || []) as PayrollEmployeeRow[]).map((employee) => {
    const profile = hrProfile(employee.raw_payload)
    return {
      ...employee,
      basic_work_start: profile.basic_work_start || null,
      basic_work_end: profile.basic_work_end || null,
      basic_break_minutes: typeof profile.basic_break_minutes === 'number' ? profile.basic_break_minutes : null,
      hr_profile: profile,
      is_hr_deleted: !!profile.deleted_at,
      payroll_result_count: resultCountMap.get(employee.id) || 0,
      resume_document: resumeDocumentMap.get(employee.id) || null,
      user: employee.user_id ? userMap[employee.user_id] || null : null,
      workplace: employee.default_workplace_id ? workplaceMap[employee.default_workplace_id] || null : null,
    }
  })

  return NextResponse.json({
    employees: rows,
    users: users || [],
    summary: {
      total: rows.length,
      active: rows.filter((row) => row.payroll_status === 'active' && !row.is_hr_deleted).length,
      retired: rows.filter((row) => row.payroll_status === 'retired' && !row.is_hr_deleted).length,
      unlinked: rows.filter((row) => !row.user_id && !row.is_hr_deleted).length,
      deleted: rows.filter((row) => row.is_hr_deleted).length,
      withPayroll: rows.filter((row) => row.payroll_result_count > 0).length,
    },
  })
}

export async function PATCH(request: Request) {
  const auth = await requireHRPermission()
  if (auth.error) return auth.error

  const body = await request.json().catch(() => null) as {
    id?: string
    action?: 'retire'
    user_id?: string | null
    employee_code?: string | null
    hire_date?: string | null
    kana?: string | null
    birth_date?: string | null
    gender?: string | null
    payroll_status?: string
    resigned_date?: string | null
    work_style?: string | null
    basic_work_start?: string | null
    basic_work_end?: string | null
    basic_break_minutes?: number | string | null
    hr_profile?: HRProfile
  } | null

  if (!body?.id) {
    return NextResponse.json({ error: '従業員IDが必要です' }, { status: 400 })
  }

  const { data: employee, error: employeeError } = await adminClient
    .from('gw_payroll_employees')
    .select('id, user_id, payroll_status, resigned_date, raw_payload')
    .eq('id', body.id)
    .maybeSingle()

  if (employeeError) return NextResponse.json({ error: employeeError.message }, { status: 500 })
  if (!employee) return NextResponse.json({ error: '従業員が見つかりません' }, { status: 404 })

  if (body.action === 'retire') {
    const resignedDate = normalizeDateInput(body.resigned_date)
    if (!resignedDate) {
      return NextResponse.json({ error: '退職日を入力してください' }, { status: 400 })
    }

    const { data, error } = await adminClient.rpc('gw_retire_payroll_employee', {
      p_employee_id: employee.id,
      p_resigned_date: resignedDate,
      p_actor_id: auth.user?.id || null,
    })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, retirement: Array.isArray(data) ? data[0] || null : data })
  }

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }

  if ('employee_code' in body) {
    const employeeCode = typeof body.employee_code === 'string' ? body.employee_code.trim() : ''
    if (employeeCode) {
      const { data: existingEmployee, error: existingError } = await adminClient
        .from('gw_payroll_employees')
        .select('id')
        .eq('employee_code', employeeCode)
        .neq('id', body.id)
        .maybeSingle()

      if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 })
      if (existingEmployee) return NextResponse.json({ error: 'この社員NOは別のスタッフに設定済みです' }, { status: 409 })
    }
    updates.employee_code = employeeCode || null
  }

  if ('hire_date' in body) {
    const hireDate = normalizeDateInput(body.hire_date)
    if (hireDate === undefined) return NextResponse.json({ error: '入社日が不正です' }, { status: 400 })
    updates.hire_date = hireDate
  }

  if ('kana' in body) {
    const kana = typeof body.kana === 'string' ? body.kana.trim().slice(0, 100) : ''
    updates.kana = kana || null
  }

  if ('birth_date' in body) {
    const birthDate = normalizeDateInput(body.birth_date)
    if (birthDate === undefined) return NextResponse.json({ error: '生年月日が不正です' }, { status: 400 })
    updates.birth_date = birthDate
  }

  if ('gender' in body) {
    if (body.gender && !genders.has(body.gender)) {
      return NextResponse.json({ error: '性別が不正です' }, { status: 400 })
    }
    updates.gender = body.gender || null
  }

  if ('payroll_status' in body) {
    if (!body.payroll_status || !payrollStatuses.has(body.payroll_status)) {
      return NextResponse.json({ error: '在籍ステータスが不正です' }, { status: 400 })
    }
    if (body.payroll_status === 'retired') {
      return NextResponse.json({ error: '退職は退職日を指定する「退職処理」から実行してください' }, { status: 400 })
    }
    if (employee.payroll_status === 'retired') {
      return NextResponse.json({ error: '退職済みスタッフの在籍復帰は個別確認が必要です' }, { status: 400 })
    }
    updates.payroll_status = body.payroll_status
  }

  if ('resigned_date' in body) {
    const resignedDate = normalizeDateInput(body.resigned_date)
    if (resignedDate === undefined) return NextResponse.json({ error: '退職日が不正です' }, { status: 400 })
    updates.resigned_date = resignedDate
  }

  if ('work_style' in body) {
    if (body.work_style && !workStyles.has(body.work_style)) {
      return NextResponse.json({ error: '就業形態が不正です' }, { status: 400 })
    }
    updates.work_style = body.work_style || null
  }

  const hasBasicWorkChange = 'basic_work_start' in body || 'basic_work_end' in body || 'basic_break_minutes' in body
  if (hasBasicWorkChange) {
    const currentProfile = hrProfile(employee.raw_payload as Record<string, unknown> | null)
    const startTime = normalizeTimeInput('basic_work_start' in body ? body.basic_work_start : currentProfile.basic_work_start)
    const endTime = normalizeTimeInput('basic_work_end' in body ? body.basic_work_end : currentProfile.basic_work_end)
    if (startTime === undefined || endTime === undefined || Boolean(startTime) !== Boolean(endTime)) {
      return NextResponse.json({ error: '基本勤務の開始・終了時刻は両方入力してください' }, { status: 400 })
    }

    const rawBreakMinutes = 'basic_break_minutes' in body ? body.basic_break_minutes : currentProfile.basic_break_minutes
    const breakMinutes = rawBreakMinutes === null || rawBreakMinutes === undefined || rawBreakMinutes === ''
      ? null
      : Number(rawBreakMinutes)
    if (breakMinutes !== null && (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 480)) {
      return NextResponse.json({ error: '基本休憩は0〜480分で入力してください' }, { status: 400 })
    }

    updates.raw_payload = mergeHRProfile(employee.raw_payload as Record<string, unknown> | null, {
      basic_work_start: startTime,
      basic_work_end: endTime,
      basic_break_minutes: startTime ? breakMinutes ?? 0 : null,
    })
  }

  if ('user_id' in body) {
    if (body.user_id) {
      const { data: targetUser, error: userError } = await adminClient
        .from('gw_users')
        .select('id')
        .eq('id', body.user_id)
        .maybeSingle()

      if (userError) return NextResponse.json({ error: userError.message }, { status: 500 })
      if (!targetUser) return NextResponse.json({ error: '指定されたTSGユーザーが見つかりません' }, { status: 404 })

      const { data: existingEmployee, error: existingError } = await adminClient
        .from('gw_payroll_employees')
        .select('id')
        .eq('user_id', body.user_id)
        .neq('id', body.id)
        .maybeSingle()

      if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 })
      if (existingEmployee) return NextResponse.json({ error: 'このTSGユーザーは別の従業員に連携済みです' }, { status: 409 })
    }
    updates.user_id = body.user_id || null
  }

  if (body.hr_profile) {
    updates.raw_payload = mergeHRProfile(
      updates.raw_payload as Record<string, unknown> | null || employee.raw_payload as Record<string, unknown> | null,
      body.hr_profile,
    )
  }

  const { error } = await adminClient
    .from('gw_payroll_employees')
    .update(updates)
    .eq('id', body.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  const auth = await requireHRPermission()
  if (auth.error) return auth.error

  const body = await request.json().catch(() => null) as { id?: string; reason?: string } | null
  if (!body?.id) {
    return NextResponse.json({ error: '従業員IDが必要です' }, { status: 400 })
  }

  const { data: employee, error: employeeError } = await adminClient
    .from('gw_payroll_employees')
    .select('id, raw_payload, payroll_status, resigned_date')
    .eq('id', body.id)
    .maybeSingle()

  if (employeeError) return NextResponse.json({ error: employeeError.message }, { status: 500 })
  if (!employee) return NextResponse.json({ error: '従業員が見つかりません' }, { status: 404 })
  if (employee.payroll_status !== 'retired') {
    return NextResponse.json({ error: '退職者のみ削除できます。先に退職へ変更してください。' }, { status: 400 })
  }

  const now = new Date().toISOString()
  const rawPayload = mergeHRProfile(employee.raw_payload as Record<string, unknown> | null, {
    phone: '',
    email: '',
    postal_code: '',
    address: '',
    emergency_contact_name: '',
    emergency_contact_phone: '',
    education_history: '',
    work_history: '',
    qualifications: '',
    personal_statement: '',
    resume_notes: '',
    hiring_contact_email_content: '',
    deleted_at: now,
    deleted_by: auth.user?.id,
    delete_reason: body.reason || '退職者削除',
  })

  const { error } = await adminClient
    .from('gw_payroll_employees')
    .update({
      user_id: null,
      payroll_status: 'retired',
      resigned_date: employee.resigned_date || new Date().toISOString().slice(0, 10),
      raw_payload: rawPayload,
      updated_at: now,
    })
    .eq('id', body.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
