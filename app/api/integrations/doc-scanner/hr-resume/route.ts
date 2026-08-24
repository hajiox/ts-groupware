import { NextRequest, NextResponse } from 'next/server'
import {
  MAX_RESUME_BYTES,
  loadHREmployee,
  saveAndProcessHRResume,
  type HREmployeeRow,
} from '@/lib/hr-resume-service'
import { adminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 60

const DEPARTMENTS = new Set(['フロア', '製造', '道の駅'])
const WORK_STYLES = new Set(['regular_5d_8h', 'regular_6d_6_5h', 'part_time_under_29_5h', 'full_time_part', 'officer'])
const GENDERS = new Set(['male', 'female', 'other', 'unknown'])

function getBearerToken(request: NextRequest) {
  const value = request.headers.get('authorization') || ''
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : ''
}

function assertIntegrationSecret(request: NextRequest) {
  const expected = process.env.TSG_INTEGRATION_SECRET?.trim()
  if (!expected) return NextResponse.json({ error: 'TSG_INTEGRATION_SECRET is not configured' }, { status: 500 })
  const actual = request.headers.get('x-tsg-integration-secret')?.trim() || getBearerToken(request)
  return actual === expected ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

function formString(form: FormData, key: string, maxLength = 300) {
  const value = form.get(key)
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function formBoolean(form: FormData, key: string) {
  return ['1', 'true', 'yes', 'on'].includes(formString(form, key, 10).toLowerCase())
}

function validDate(value: string) {
  return !value || /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function employeeProfile(employee: HREmployeeRow) {
  const value = employee.raw_payload?.hr_profile
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function normalizedPersonName(value: string | null | undefined) {
  return (value || '')
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .replace(/[（(](?:フロア|製造|道の駅)[）)]$/u, '')
    .trim()
}

function isHRDeleted(employee: HREmployeeRow) {
  const profile = employee.raw_payload?.hr_profile
  return !!(profile && typeof profile === 'object' && !Array.isArray(profile) && 'deleted_at' in profile && profile.deleted_at)
}

async function findEmployeeCandidates(employeeName: string) {
  const { data, error } = await adminClient
    .from('gw_payroll_employees')
    .select('id, user_id, employee_code, display_name, real_name, kana, birth_date, hire_date, gender, payroll_status, department, work_style, raw_payload')
  if (error) throw error

  const target = normalizedPersonName(employeeName)
  return ((data || []) as HREmployeeRow[]).filter((employee) => {
    if (isHRDeleted(employee)) return false
    return [employee.real_name, employee.display_name].some((name) => normalizedPersonName(name) === target)
  })
}

type EmploymentInput = {
  employeeId: string
  employeeName: string
  department: string
  hireDate: string
  workStyle: string
  gender: string
  provisionalShift: boolean
  documentId: string
}

async function createProvisionalUser(input: EmploymentInput) {
  const { data, error } = await adminClient
    .from('gw_users')
    .insert({
      line_user_id: `provisional:doc-scanner:${input.documentId}:${crypto.randomUUID()}`,
      display_name: input.employeeName,
      real_name: input.employeeName,
      role: 'member',
      department: input.department,
      status: 'suspended',
    })
    .select('id')
    .single()
  if (error || !data) throw error || new Error('仮入社用シフトIDを作成できませんでした')
  return String(data.id)
}

async function applyEmploymentInput(employee: HREmployeeRow, input: EmploymentInput) {
  if (!input.provisionalShift) return { employee, provisionalUserId: '' }

  let provisionalUserId = ''
  let userId = employee.user_id
  if (!userId) {
    provisionalUserId = await createProvisionalUser(input)
    userId = provisionalUserId
  }

  const now = new Date().toISOString()
  const profile = employeeProfile(employee)
  const rawPayload = {
    ...(employee.raw_payload || {}),
    hr_profile: {
      ...profile,
      provisional_hire: true,
      provisional_hire_date: input.hireDate || null,
      shift_visible_before_hire: true,
      request_collection_excluded: true,
      provisional_shift_user_id: userId,
      provisional_updated_at: now,
    },
  }

  // The active transition lets the employee-number trigger reserve a non-reusable number.
  const { error: numberError } = await adminClient
    .from('gw_payroll_employees')
    .update({
      user_id: userId,
      payroll_status: 'active',
      department: input.department || employee.department || null,
      hire_date: input.hireDate || employee.hire_date || null,
      work_style: input.workStyle || employee.work_style || null,
      gender: input.gender || employee.gender || null,
      raw_payload: rawPayload,
      updated_at: now,
    })
    .eq('id', employee.id)
  if (numberError) throw numberError

  const { data: updated, error } = await adminClient
    .from('gw_payroll_employees')
    .update({ payroll_status: 'inactive', updated_at: now })
    .eq('id', employee.id)
    .select('id, user_id, employee_code, display_name, real_name, kana, birth_date, hire_date, gender, payroll_status, department, work_style, raw_payload')
    .single()
  if (error || !updated) throw error || new Error('仮入社情報を更新できませんでした')
  return { employee: updated as HREmployeeRow, provisionalUserId }
}

async function resolveEmployee(input: EmploymentInput) {
  if (input.employeeId) {
    const employee = await loadHREmployee(input.employeeId)
    if (!employee || isHRDeleted(employee)) return { error: '指定された人事情報が見つかりません', status: 404 as const }
    const applied = await applyEmploymentInput(employee, input)
    return { ...applied, created: false }
  }

  const candidates = await findEmployeeCandidates(input.employeeName)
  if (candidates.length === 1) {
    const applied = await applyEmploymentInput(candidates[0], input)
    return { ...applied, created: false }
  }
  if (candidates.length > 1) {
    return {
      error: '同名候補が複数あります。employee_idを指定して再送してください',
      status: 409 as const,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        employee_code: candidate.employee_code,
        name: candidate.real_name || candidate.display_name,
        department: candidate.department || null,
        payroll_status: candidate.payroll_status || null,
      })),
    }
  }

  const provisionalUserId = input.provisionalShift ? await createProvisionalUser(input) : ''
  const { data: created, error } = await adminClient
    .from('gw_payroll_employees')
    .insert({
      user_id: provisionalUserId || null,
      display_name: input.employeeName,
      real_name: input.employeeName,
      department: input.department || null,
      hire_date: input.hireDate || null,
      work_style: input.workStyle || null,
      gender: input.gender || null,
      payroll_status: 'active',
      source_key: `doc-scanner:resume-person:${crypto.randomUUID()}`,
      raw_payload: {
        source: 'doc-scanner-resume',
        created_at: new Date().toISOString(),
        ...(input.provisionalShift ? {
          hr_profile: {
            provisional_hire: true,
            provisional_hire_date: input.hireDate || null,
            shift_visible_before_hire: true,
            request_collection_excluded: true,
            provisional_shift_user_id: provisionalUserId,
            provisional_updated_at: new Date().toISOString(),
          },
        } : {}),
      },
    })
    .select('id, user_id, employee_code, display_name, real_name, kana, birth_date, hire_date, gender, payroll_status, department, work_style, raw_payload')
    .single()
  if (error || !created) {
    if (provisionalUserId) await adminClient.from('gw_users').delete().eq('id', provisionalUserId)
    throw error || new Error('人事情報を新規作成できませんでした')
  }
  if (input.provisionalShift) {
    const { data: inactive, error: inactiveError } = await adminClient
      .from('gw_payroll_employees')
      .update({ payroll_status: 'inactive', updated_at: new Date().toISOString() })
      .eq('id', created.id)
      .select('id, user_id, employee_code, display_name, real_name, kana, birth_date, hire_date, gender, payroll_status, department, work_style, raw_payload')
      .single()
    if (inactiveError || !inactive) throw inactiveError || new Error('仮入社状態へ更新できませんでした')
    return { employee: inactive as HREmployeeRow, created: true, provisionalUserId }
  }
  return { employee: created as HREmployeeRow, created: true, provisionalUserId: '' }
}

export async function POST(request: NextRequest) {
  const authError = assertIntegrationSecret(request)
  if (authError) return authError

  let createdEmployeeId = ''
  let createdProvisionalUserId = ''
  try {
    const form = await request.formData()
    const file = form.get('file')
    const documentId = formString(form, 'document_id', 200)
    const requestedSourceKey = formString(form, 'source_key', 200)
    const employeeId = formString(form, 'employee_id', 100)
    const employeeName = formString(form, 'employee_name', 100)
    const department = formString(form, 'department', 20)
    const hireDate = formString(form, 'hire_date', 10)
    const workStyle = formString(form, 'work_style', 40)
    const gender = formString(form, 'gender', 20)
    const provisionalShift = formBoolean(form, 'provisional_shift')
    const fileName = formString(form, 'file_name', 300)

    if (!documentId) return NextResponse.json({ error: 'document_id is required' }, { status: 400 })
    if (!employeeId && !employeeName) {
      return NextResponse.json({ error: 'employee_id or employee_name is required' }, { status: 400 })
    }
    if (department && !DEPARTMENTS.has(department)) {
      return NextResponse.json({ error: 'department must be フロア, 製造, or 道の駅' }, { status: 400 })
    }
    if (!validDate(hireDate)) return NextResponse.json({ error: 'hire_date must be YYYY-MM-DD' }, { status: 400 })
    if (workStyle && !WORK_STYLES.has(workStyle)) return NextResponse.json({ error: 'work_style is invalid' }, { status: 400 })
    if (gender && !GENDERS.has(gender)) return NextResponse.json({ error: 'gender is invalid' }, { status: 400 })
    if (provisionalShift && (!department || !hireDate || !workStyle)) {
      return NextResponse.json({ error: 'provisional shift import requires department, hire_date, and work_style' }, { status: 400 })
    }
    if (!(file instanceof File)) return NextResponse.json({ error: 'PDF file is required' }, { status: 400 })
    if (file.size <= 0 || file.size > MAX_RESUME_BYTES) {
      return NextResponse.json({ error: 'PDF file must be 4MB or smaller' }, { status: 400 })
    }

    const sourceKey = requestedSourceKey
      ? `doc-scanner:${requestedSourceKey}`
      : `doc-scanner:hr-resume:${documentId}`
    const { data: existing, error: existingError } = await adminClient
      .from('gw_hr_documents')
      .select('id, employee_id, ocr_status, ocr_error, extracted_data')
      .eq('source_key', sourceKey)
      .maybeSingle()
    if (existingError) throw existingError
    if (existing) {
      return NextResponse.json({
        ok: true,
        duplicate: true,
        employee_id: existing.employee_id,
        document_id: existing.id,
        ocr: {
          status: existing.ocr_status,
          error: existing.ocr_error,
          extractedData: existing.extracted_data,
        },
      })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    if (buffer.subarray(0, 5).toString() !== '%PDF-') {
      return NextResponse.json({ error: 'file must be a PDF' }, { status: 400 })
    }

    const resolution = await resolveEmployee({
      employeeId,
      employeeName,
      department,
      hireDate,
      workStyle,
      gender,
      provisionalShift,
      documentId,
    })
    if ('error' in resolution) {
      return NextResponse.json(
        { error: resolution.error, candidates: 'candidates' in resolution ? resolution.candidates : [] },
        { status: resolution.status },
      )
    }
    if (resolution.created) createdEmployeeId = resolution.employee.id
    createdProvisionalUserId = resolution.provisionalUserId

    const result = await saveAndProcessHRResume({
      employeeId: resolution.employee.id,
      buffer,
      fileName: fileName || file.name || '履歴書.pdf',
      fileSize: file.size,
      uploadedBy: null,
      sourceSystem: 'doc-scanner',
      sourceDocumentId: documentId,
      sourceKey,
    })

    return NextResponse.json({
      ok: true,
      duplicate: false,
      employee_created: resolution.created,
      employee_id: resolution.employee.id,
      employee_code: resolution.employee.employee_code,
      payroll_status: resolution.employee.payroll_status,
      provisional_shift: provisionalShift,
      document_id: result.document.id,
      ocr: result.ocr,
    }, { status: 201 })
  } catch (error) {
    if (createdEmployeeId) {
      await adminClient.from('gw_payroll_employees').delete().eq('id', createdEmployeeId)
    }
    if (createdProvisionalUserId) {
      await adminClient.from('gw_users').delete().eq('id', createdProvisionalUserId)
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : '履歴書をTSG人事管理へ取り込めませんでした' }, { status: 500 })
  }
}
