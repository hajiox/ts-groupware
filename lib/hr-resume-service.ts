import { deleteFileFromDrive, downloadFileFromDrive } from '@/lib/drive'
import { extractResumeFromPdf, type ResumeOcrResult } from '@/lib/hr-resume-ocr'
import { adminClient } from '@/lib/supabase/admin'

export const MAX_RESUME_BYTES = 4 * 1024 * 1024
export const HR_DOCUMENT_BUCKET = 'hr-documents'

type HRProfile = Record<string, unknown> & {
  deleted_at?: string
  phone?: string
  email?: string
  postal_code?: string
  address?: string
  education_history?: string
  work_history?: string
  qualifications?: string
  personal_statement?: string
  resume_notes?: string
  hiring_contact_email_content?: string
}

export type HREmployeeRow = {
  id: string
  user_id: string | null
  employee_code: string | null
  display_name: string
  real_name: string | null
  kana: string | null
  birth_date: string | null
  hire_date: string | null
  gender: string | null
  payroll_status?: string
  department?: string | null
  work_style?: string | null
  raw_payload: Record<string, unknown> | null
}

export type HRResumeDocumentRow = {
  id: string
  employee_id: string
  file_name: string
  mime_type: string
  file_size: number
  drive_file_id: string | null
  storage_provider: 'supabase' | 'google_drive'
  storage_path: string | null
  ocr_status: string
  ocr_error?: string | null
  extracted_data?: Record<string, unknown> | null
  source_system?: string | null
  source_document_id?: string | null
  source_key?: string | null
}

function hrProfile(rawPayload: Record<string, unknown> | null | undefined): HRProfile {
  const profile = rawPayload?.hr_profile
  return profile && typeof profile === 'object' && !Array.isArray(profile)
    ? profile as HRProfile
    : {}
}

function hasValue(value: unknown) {
  return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined
}

function normalizedName(value: string | null | undefined) {
  return (value || '').replace(/[\s　]+/g, '').trim()
}

function joinedLines(items: string[]) {
  return items.map((item) => item.trim()).filter(Boolean).join('\n')
}

export async function loadHREmployee(employeeId: string) {
  const { data, error } = await adminClient
    .from('gw_payroll_employees')
    .select('id, user_id, employee_code, display_name, real_name, kana, birth_date, hire_date, gender, payroll_status, department, work_style, raw_payload')
    .eq('id', employeeId)
    .maybeSingle()
  if (error) throw error
  return data as HREmployeeRow | null
}

async function applyOcrResult(employee: HREmployeeRow, documentId: string, result: ResumeOcrResult) {
  const profile = hrProfile(employee.raw_payload)
  const appliedFields: string[] = []
  const warnings: string[] = []
  const nextProfile: HRProfile = { ...profile }
  const profileValues: Array<[keyof HRProfile, string | null]> = [
    ['phone', result.phone],
    ['email', result.email],
    ['postal_code', result.postal_code],
    ['address', result.address],
    ['education_history', joinedLines(result.education_history) || null],
    ['work_history', joinedLines(result.work_history) || null],
    ['qualifications', joinedLines(result.qualifications) || null],
    ['personal_statement', result.personal_statement],
    ['resume_notes', result.other_notes],
  ]

  for (const [key, value] of profileValues) {
    if (value && !hasValue(profile[key])) {
      nextProfile[key] = value
      appliedFields.push(String(key))
    }
  }

  const updates: Record<string, unknown> = {
    raw_payload: {
      ...(employee.raw_payload || {}),
      hr_profile: nextProfile,
      resume_ocr: {
        latest_document_id: documentId,
        processed_at: new Date().toISOString(),
      },
    },
    updated_at: new Date().toISOString(),
  }
  if (result.name_kana && !hasValue(employee.kana)) {
    updates.kana = result.name_kana
    appliedFields.push('kana')
  }
  if (result.birth_date && !hasValue(employee.birth_date)) {
    updates.birth_date = result.birth_date
    appliedFields.push('birth_date')
  }
  if (result.gender && result.gender !== 'unknown' && !hasValue(employee.gender)) {
    updates.gender = result.gender
    appliedFields.push('gender')
  }

  const employeeName = normalizedName(employee.real_name || employee.display_name)
  const resumeName = normalizedName(result.full_name)
  if (employeeName && resumeName && employeeName !== resumeName) {
    warnings.push(`履歴書氏名「${result.full_name}」と人事氏名が一致しないため、氏名は自動変更していません`)
  }

  const { error } = await adminClient.from('gw_payroll_employees').update(updates).eq('id', employee.id)
  if (error) throw error
  return { appliedFields, warnings }
}

export async function processStoredHRResume(document: HRResumeDocumentRow, buffer: Buffer) {
  await adminClient
    .from('gw_hr_documents')
    .update({
      ocr_status: 'processing',
      ocr_error: null,
      ocr_provider: null,
      ocr_model: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', document.id)

  try {
    const employee = await loadHREmployee(document.employee_id)
    if (!employee) throw new Error('従業員が見つかりません')
    if (hrProfile(employee.raw_payload).deleted_at) throw new Error('削除済みスタッフの履歴書は解析できません')

    const extraction = await extractResumeFromPdf(buffer)
    const applied = await applyOcrResult(employee, document.id, extraction.result)
    const processedAt = new Date().toISOString()
    const extractedData = { ...extraction.result, ...applied }
    const { error } = await adminClient
      .from('gw_hr_documents')
      .update({
        ocr_status: 'completed',
        ocr_provider: extraction.provider,
        ocr_model: extraction.model,
        extracted_data: extractedData,
        ocr_error: null,
        processed_at: processedAt,
        updated_at: processedAt,
      })
      .eq('id', document.id)
    if (error) throw error
    return { status: 'completed' as const, extractedData, provider: extraction.provider, model: extraction.model }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'AI OCRに失敗しました'
    await adminClient
      .from('gw_hr_documents')
      .update({
        ocr_status: 'failed',
        ocr_error: message,
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', document.id)
    return { status: 'failed' as const, error: message }
  }
}

export async function getHRResumeDocument(documentId: string) {
  const { data, error } = await adminClient
    .from('gw_hr_documents')
    .select('id, employee_id, file_name, mime_type, file_size, drive_file_id, storage_provider, storage_path, ocr_status, ocr_error, extracted_data, source_system, source_document_id, source_key')
    .eq('id', documentId)
    .eq('document_type', 'resume')
    .maybeSingle()
  if (error) throw error
  return data as HRResumeDocumentRow | null
}

export async function downloadHRResume(document: Pick<HRResumeDocumentRow, 'drive_file_id' | 'storage_provider' | 'storage_path'>) {
  if (document.storage_provider === 'supabase' && document.storage_path) {
    const { data, error } = await adminClient.storage.from(HR_DOCUMENT_BUCKET).download(document.storage_path)
    if (error || !data) throw error || new Error('履歴書PDFを取得できませんでした')
    return Buffer.from(await data.arrayBuffer())
  }
  if (document.drive_file_id) return downloadFileFromDrive(document.drive_file_id)
  throw new Error('履歴書PDFの保存先が見つかりません')
}

export async function saveAndProcessHRResume(input: {
  employeeId: string
  buffer: Buffer
  fileName: string
  fileSize: number
  uploadedBy?: string | null
  sourceSystem?: string | null
  sourceDocumentId?: string | null
  sourceKey?: string | null
}) {
  const employee = await loadHREmployee(input.employeeId)
  if (!employee) throw new Error('従業員が見つかりません')
  if (hrProfile(employee.raw_payload).deleted_at) throw new Error('削除済みスタッフには履歴書を登録できません')

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const storagePath = `${employee.id}/${timestamp}_resume.pdf`
  let storageUploaded = false
  let previousDocumentId = ''
  try {
    const { error: uploadError } = await adminClient.storage
      .from(HR_DOCUMENT_BUCKET)
      .upload(storagePath, input.buffer, { contentType: 'application/pdf', upsert: false })
    if (uploadError) throw uploadError
    storageUploaded = true

    const { data: previous } = await adminClient
      .from('gw_hr_documents')
      .select('id')
      .eq('employee_id', employee.id)
      .eq('document_type', 'resume')
      .eq('is_current', true)
      .maybeSingle()
    previousDocumentId = previous?.id || ''
    if (previousDocumentId) {
      const { error } = await adminClient
        .from('gw_hr_documents')
        .update({ is_current: false, updated_at: new Date().toISOString() })
        .eq('id', previousDocumentId)
      if (error) throw error
    }

    const { data: document, error } = await adminClient
      .from('gw_hr_documents')
      .insert({
        employee_id: employee.id,
        document_type: 'resume',
        file_name: input.fileName || '履歴書.pdf',
        mime_type: 'application/pdf',
        file_size: input.fileSize,
        drive_file_id: null,
        storage_provider: 'supabase',
        storage_path: storagePath,
        is_current: true,
        ocr_status: 'pending',
        uploaded_by: input.uploadedBy || null,
        source_system: input.sourceSystem || null,
        source_document_id: input.sourceDocumentId || null,
        source_key: input.sourceKey || null,
      })
      .select('id, employee_id, file_name, mime_type, file_size, drive_file_id, storage_provider, storage_path, ocr_status, source_system, source_document_id, source_key')
      .single()
    if (error || !document) throw error || new Error('履歴書情報を保存できませんでした')

    const ocr = await processStoredHRResume(document as HRResumeDocumentRow, input.buffer)
    return { document: document as HRResumeDocumentRow, ocr }
  } catch (error) {
    if (previousDocumentId) {
      await adminClient
        .from('gw_hr_documents')
        .update({ is_current: true, updated_at: new Date().toISOString() })
        .eq('id', previousDocumentId)
    }
    if (storageUploaded) await adminClient.storage.from(HR_DOCUMENT_BUCKET).remove([storagePath]).catch(() => {})
    throw error
  }
}

export async function reprocessHRResume(documentId: string) {
  const document = await getHRResumeDocument(documentId)
  if (!document) throw new Error('履歴書が見つかりません')
  const buffer = await downloadHRResume(document)
  return { document, ocr: await processStoredHRResume(document, buffer) }
}

export async function deleteHRResume(documentId: string) {
  const document = await getHRResumeDocument(documentId)
  if (!document) throw new Error('履歴書が見つかりません')

  if (document.storage_provider === 'supabase' && document.storage_path) {
    const { error } = await adminClient.storage.from(HR_DOCUMENT_BUCKET).remove([document.storage_path])
    if (error) throw error
  } else if (document.drive_file_id) {
    await deleteFileFromDrive(document.drive_file_id)
  }

  const { error: deleteError } = await adminClient.from('gw_hr_documents').delete().eq('id', document.id)
  if (deleteError) throw deleteError

  const { data: previousDocument } = await adminClient
    .from('gw_hr_documents')
    .select('id')
    .eq('employee_id', document.employee_id)
    .eq('document_type', 'resume')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (previousDocument) {
    await adminClient
      .from('gw_hr_documents')
      .update({ is_current: true, updated_at: new Date().toISOString() })
      .eq('id', previousDocument.id)
  }
}
