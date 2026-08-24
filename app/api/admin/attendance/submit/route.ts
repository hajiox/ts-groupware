import { NextRequest, NextResponse } from 'next/server'
import { USER_DEPARTMENTS, normalizeUserDepartment, type UserDepartment } from '@/lib/departments'
import { getManagementPermissions } from '@/lib/management-permissions'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'
import { uploadFileToDrive } from '@/lib/drive'
import { downloadHRResume, type HRResumeDocumentRow } from '@/lib/hr-resume-service'
import { loadAttendanceWorkforceForRange } from '@/lib/workforce-employment'
import { google } from 'googleapis'

type UserRow = {
  id: string
  display_name: string
  real_name?: string | null
  department?: string | null
  status?: string | null
}

const LABOR_OFFICE_NAME = '榎田哲士社会保険労務士事務所'
const LABOR_RECIPIENTS = [
  { name: '榎田竜也', email: 'tatuya.enokida@gmail.com' },
  { name: '榎田哲士', email: 'next-wave.10-19@kha.biglobe.ne.jp' },
]
const MAX_NEW_EMPLOYEE_FILES = 6
const MAX_NEW_EMPLOYEE_FILE_BYTES = 3_500_000
const MAX_DOC_SCANNER_FILES = 6
const MAX_DOC_SCANNER_FILE_BYTES = 12_000_000
const MAX_DOC_SCANNER_UPLOAD_BYTES = 3_500_000
const NEW_EMPLOYEE_FILE_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  csv: 'text/csv',
  txt: 'text/plain',
  zip: 'application/zip',
}

type MailAttachment = {
  fileName: string
  contentType: string
  content: Buffer
}

type DocScannerDocumentRow = HRResumeDocumentRow & {
  created_at: string
  is_current: boolean
}

type DocScannerEmployeeRow = {
  id: string
  employee_code: string | null
  display_name: string
  real_name: string | null
  hire_date: string | null
  department: string | null
  payroll_status: string | null
  raw_payload: Record<string, unknown> | null
}

async function requireAttendanceAdmin() {
  const user = await getUserSession()
  if (!user) return { error: '認証が必要です', status: 401 }

  const permissions = getManagementPermissions(user)
  if (!permissions.canManageAttendance) {
    return { error: '勤怠管理権限が必要です', status: 403 }
  }

  return { error: null, status: 0 }
}

function cleanMonth(value: unknown) {
  const today = new Date()
  const fallback = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
  return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) ? value : fallback
}

function monthStart(month: string) {
  return `${month}-01`
}

function monthEnd(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10)
}

function displayName(user: UserRow) {
  return user.real_name || user.display_name
}

function safeFileName(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
}

function isDeletedEmployee(employee: DocScannerEmployeeRow) {
  const profile = employee.raw_payload?.hr_profile
  return !!(
    profile &&
    typeof profile === 'object' &&
    !Array.isArray(profile) &&
    'deleted_at' in profile &&
    profile.deleted_at
  )
}

function documentIds(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.filter((id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))))
}

async function buildUploadedAttachments(options: {
  files: File[]
  maxFiles: number
  maxBytes: number
  label: string
}) {
  const { files, maxFiles, maxBytes, label } = options
  if (files.length > maxFiles) throw new Error(`${label}は最大${maxFiles}ファイルまで添付できます`)

  const totalBytes = files.reduce((total, file) => total + file.size, 0)
  if (totalBytes > maxBytes) {
    throw new Error(`${label}の合計サイズは${(maxBytes / 1_000_000).toFixed(1)}MB以内にしてください`)
  }

  const attachments: MailAttachment[] = []
  for (const [index, file] of files.entries()) {
    if (file.size <= 0) throw new Error(`${file.name || `${label}${index + 1}`} が空です`)
    const extension = file.name.split('.').pop()?.toLowerCase() || ''
    const allowedMimeType = NEW_EMPLOYEE_FILE_MIME_TYPES[extension]
    if (!allowedMimeType) throw new Error(`${file.name} は添付できない形式です`)
    const cleanName = safeFileName(file.name).slice(0, 160) || `${label}_${index + 1}.${extension}`
    attachments.push({
      fileName: cleanName,
      contentType: allowedMimeType,
      content: Buffer.from(await file.arrayBuffer()),
    })
  }
  return attachments
}

function encodeMimeHeader(value: string) {
  return /[^\x20-\x7e]/.test(value)
    ? `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
    : value
}

function chunkBase64(value: string) {
  return value.match(/.{1,76}/g)?.join('\r\n') || ''
}

function buildRawMail(options: {
  to: string[]
  subject: string
  bodyText: string
  attachments: MailAttachment[]
}) {
  const boundary = `tsg-attendance-${Date.now()}`
  const lines = [
    `To: ${options.to.join(', ')}`,
    `Subject: ${encodeMimeHeader(options.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    chunkBase64(Buffer.from(options.bodyText, 'utf8').toString('base64')),
  ]

  for (const attachment of options.attachments) {
    const encodedFileName = encodeMimeHeader(attachment.fileName)
    lines.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${encodedFileName}"`,
      `Content-Disposition: attachment; filename="${encodedFileName}"`,
      'Content-Transfer-Encoding: base64',
      '',
      chunkBase64(attachment.content.toString('base64')),
    )
  }

  lines.push(`--${boundary}--`, '')
  return Buffer.from(lines.join('\r\n'), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function getGmailRefreshToken() {
  return (
    process.env.GOOGLE_GMAIL_REFRESH_TOKEN ||
    process.env.GMAIL_REFRESH_TOKEN ||
    process.env.GOOGLE_MAIL_REFRESH_TOKEN ||
    ''
  ).trim()
}

function getGmailConfigError() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !getGmailRefreshToken()) {
    return 'メール送信設定が未完了です。労務士へは届いていません。送信設定を確認してください。'
  }
  return null
}

async function sendMailWithGmail(options: {
  to: string[]
  subject: string
  bodyText: string
  attachments: MailAttachment[]
}) {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const refreshToken = getGmailRefreshToken()

  const configError = getGmailConfigError()
  if (configError) throw new Error(configError)

  const auth = new google.auth.OAuth2(clientId, clientSecret)
  auth.setCredentials({ refresh_token: refreshToken })
  const gmail = google.gmail({ version: 'v1', auth })

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: buildRawMail(options),
    },
  })

  return response.data
}

async function parseSubmission(request: NextRequest) {
  const contentType = request.headers.get('content-type') || ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    const body = await request.json().catch(() => ({}))
    return {
      month: cleanMonth(body.month),
      attachments: [] as MailAttachment[],
      uploadedDocScannerAttachments: [] as MailAttachment[],
      docScannerDocumentIds: documentIds(body.doc_scanner_document_ids),
    }
  }

  const formData = await request.formData()
  const files = formData.getAll('new_employee_files').filter((entry): entry is File => entry instanceof File)
  const docScannerFiles = formData.getAll('doc_scanner_files').filter((entry): entry is File => entry instanceof File)
  const attachments = await buildUploadedAttachments({
    files,
    maxFiles: MAX_NEW_EMPLOYEE_FILES,
    maxBytes: MAX_NEW_EMPLOYEE_FILE_BYTES,
    label: '追加資料',
  })
  const uploadedDocScannerAttachments = await buildUploadedAttachments({
    files: docScannerFiles,
    maxFiles: MAX_DOC_SCANNER_FILES,
    maxBytes: MAX_DOC_SCANNER_UPLOAD_BYTES,
    label: 'DocScanner資料',
  })

  return {
    month: cleanMonth(formData.get('month')),
    attachments,
    uploadedDocScannerAttachments,
    docScannerDocumentIds: (() => {
      const value = formData.get('doc_scanner_document_ids')
      if (typeof value !== 'string' || !value) return []
      try {
        return documentIds(JSON.parse(value))
      } catch {
        throw new Error('DocScanner資料の選択情報が不正です')
      }
    })(),
  }
}

async function loadDocScannerRows() {
  const { data: documents, error: documentsError } = await adminClient
    .from('gw_hr_documents')
    .select('id, employee_id, file_name, mime_type, file_size, drive_file_id, storage_provider, storage_path, ocr_status, ocr_error, extracted_data, source_system, source_document_id, source_key, created_at, is_current')
    .eq('document_type', 'resume')
    .eq('source_system', 'doc-scanner')
    .eq('is_current', true)
    .order('created_at', { ascending: false })
    .limit(50)
  if (documentsError) throw documentsError

  const documentRows = (documents || []) as DocScannerDocumentRow[]
  const employeeIds = Array.from(new Set(documentRows.map((document) => document.employee_id)))
  if (employeeIds.length === 0) return { documents: documentRows, employees: [] as DocScannerEmployeeRow[] }

  const { data: employees, error: employeesError } = await adminClient
    .from('gw_payroll_employees')
    .select('id, employee_code, display_name, real_name, hire_date, department, payroll_status, raw_payload')
    .in('id', employeeIds)
  if (employeesError) throw employeesError
  return { documents: documentRows, employees: (employees || []) as DocScannerEmployeeRow[] }
}

async function buildDocScannerAttachments(selectedIds: string[]) {
  if (selectedIds.length === 0) return [] as MailAttachment[]
  if (selectedIds.length > MAX_DOC_SCANNER_FILES) {
    throw new Error(`DocScanner資料は最大${MAX_DOC_SCANNER_FILES}件まで添付できます`)
  }

  const { documents, employees } = await loadDocScannerRows()
  const documentMap = new Map(documents.map((document) => [document.id, document]))
  const employeeMap = new Map(employees.map((employee) => [employee.id, employee]))
  const selectedDocuments = selectedIds.map((id) => documentMap.get(id))
  if (selectedDocuments.some((document) => !document)) {
    throw new Error('選択したDocScanner資料が見つからないか、最新版ではありません')
  }

  const totalBytes = selectedDocuments.reduce((total, document) => total + Number(document?.file_size || 0), 0)
  if (totalBytes > MAX_DOC_SCANNER_FILE_BYTES) {
    throw new Error('DocScanner資料の合計サイズは12MB以内にしてください')
  }

  const attachments: MailAttachment[] = []
  for (const [index, document] of selectedDocuments.entries()) {
    if (!document) continue
    const employee = employeeMap.get(document.employee_id)
    if (!employee || isDeletedEmployee(employee) || employee.payroll_status === 'retired') {
      throw new Error(`${document.file_name} の在籍スタッフ情報を確認できません`)
    }
    const employeeName = safeFileName(employee.real_name || employee.display_name) || `新入社員${index + 1}`
    const originalName = safeFileName(document.file_name || '履歴書.pdf') || '履歴書.pdf'
    const content = await downloadHRResume(document)
    attachments.push({
      fileName: `新入社員情報_${employeeName}_${originalName}`.slice(0, 180),
      contentType: 'application/pdf',
      content,
    })
  }
  return attachments
}

async function buildDepartmentFile(request: NextRequest, month: string, department: UserDepartment) {
  const url = new URL('/api/admin/attendance/export', request.url)
  url.searchParams.set('month', month)
  url.searchParams.set('department', department)

  const response = await fetch(url, {
    headers: {
      cookie: request.headers.get('cookie') || '',
    },
    cache: 'no-store',
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(body || `${department} の勤怠ファイル作成に失敗しました`)
  }

  const xml = await response.text()
  const fileName = `勤怠提出_${safeFileName(department)}_${month}.xls`
  const content = Buffer.from(xml, 'utf8')
  const driveFile = await uploadFileToDrive(content, fileName, 'application/vnd.ms-excel')

  return {
    department,
    fileName,
    url: driveFile.webViewLink || driveFile.webContentLink || '',
    downloadUrl: driveFile.id ? `https://drive.google.com/uc?export=download&id=${driveFile.id}` : driveFile.webContentLink || driveFile.webViewLink || '',
    attachment: {
      fileName,
      contentType: 'application/vnd.ms-excel',
      content,
    },
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireAttendanceAdmin()
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const month = cleanMonth(request.nextUrl.searchParams.get('month'))
    const { documents, employees } = await loadDocScannerRows()
    const employeeMap = new Map(employees.map((employee) => [employee.id, employee]))
    const candidates = documents.flatMap((document) => {
      const employee = employeeMap.get(document.employee_id)
      if (!employee || isDeletedEmployee(employee) || employee.payroll_status === 'retired') return []
      return [{
        id: document.id,
        employeeId: employee.id,
        employeeCode: employee.employee_code,
        employeeName: employee.real_name || employee.display_name,
        department: employee.department,
        hireDate: employee.hire_date,
        fileName: document.file_name,
        fileSize: Number(document.file_size || 0),
        importedAt: document.created_at,
        ocrStatus: document.ocr_status,
        sourceDocumentId: document.source_document_id,
        suggested: !!employee.hire_date && employee.hire_date.startsWith(month),
      }]
    }).sort((a, b) => Number(b.suggested) - Number(a.suggested) || b.importedAt.localeCompare(a.importedAt))

    return NextResponse.json({ month, documents: candidates }, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'DocScanner資料を読み込めませんでした'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAttendanceAdmin()
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let submission
  try {
    submission = await parseSubmission(request)
  } catch (error) {
    const message = error instanceof Error ? error.message : '追加資料を読み込めませんでした'
    return NextResponse.json({ error: message }, { status: 400 })
  }
  const {
    month,
    attachments: newEmployeeAttachments,
    uploadedDocScannerAttachments,
    docScannerDocumentIds: selectedDocScannerDocumentIds,
  } = submission

  const [workforce, { data: checks, error: checksError }] = await Promise.all([
    loadAttendanceWorkforceForRange({ startDate: monthStart(month), endDate: monthEnd(month) }),
    adminClient
      .from('gw_attendance_monthly_checks')
      .select('user_id')
      .eq('check_month', monthStart(month)),
  ])

  if (workforce.error) return NextResponse.json({ error: workforce.error.message }, { status: 500 })
  if (checksError) return NextResponse.json({ error: checksError.message }, { status: 500 })

  const targetUsers = (workforce.users as UserRow[])
    .map((user) => ({ ...user, department: normalizeUserDepartment(user.department) }))
    .filter((user) => USER_DEPARTMENTS.includes(user.department as UserDepartment))
  const checkedUserIds = new Set((checks || []).map((row) => row.user_id).filter((id): id is string => typeof id === 'string'))
  const missingUsers = targetUsers.filter((user) => !checkedUserIds.has(user.id))

  if (missingUsers.length > 0) {
    return NextResponse.json({
      error: `未チェックのスタッフがいます: ${missingUsers.slice(0, 8).map(displayName).join('、')}${missingUsers.length > 8 ? ' 他' : ''}`,
      missing_count: missingUsers.length,
    }, { status: 400 })
  }

  const gmailConfigError = getGmailConfigError()
  if (gmailConfigError) {
    return NextResponse.json({ error: gmailConfigError }, { status: 500 })
  }

  const files = []
  for (const department of USER_DEPARTMENTS) {
    files.push(await buildDepartmentFile(request, month, department))
  }

  let docScannerAttachments: MailAttachment[]
  try {
    const storedDocScannerAttachments = await buildDocScannerAttachments(selectedDocScannerDocumentIds)
    docScannerAttachments = [...storedDocScannerAttachments, ...uploadedDocScannerAttachments]
    if (docScannerAttachments.length > MAX_DOC_SCANNER_FILES) {
      throw new Error(`DocScanner資料は最大${MAX_DOC_SCANNER_FILES}件まで添付できます`)
    }
    const totalBytes = docScannerAttachments.reduce((total, attachment) => total + attachment.content.length, 0)
    if (totalBytes > MAX_DOC_SCANNER_FILE_BYTES) {
      throw new Error('DocScanner資料の合計サイズは12MB以内にしてください')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'DocScanner資料を添付できませんでした'
    return NextResponse.json({ error: message }, { status: 400 })
  }

  const employeeInformationAttachments = [...docScannerAttachments, ...newEmployeeAttachments]

  const to = LABOR_RECIPIENTS.map((recipient) => recipient.email)
  const subject = `${month} 勤怠データ送付（フロア・製造・道の駅）`
  const bodyText = [
    `${LABOR_OFFICE_NAME}`,
    '',
    'いつもお世話になっております。',
    `${month}分の勤怠提出データを送付いたします。`,
    '',
    '添付ファイル:',
    ...files.map((file) => `- ${file.department}: ${file.fileName}`),
    ...(employeeInformationAttachments.length > 0
      ? [
          '',
          '新入社員情報:',
          ...employeeInformationAttachments.map((file) => `- ${file.fileName}`),
        ]
      : []),
    '',
    'よろしくお願いいたします。',
    '',
    '株式会社テクニカルスタッフ AI System（TSA）より送信',
  ].join('\n')
  const responseFiles = files.map((file) => ({
    department: file.department,
    fileName: file.fileName,
    url: file.url,
    downloadUrl: file.downloadUrl,
  }))

  let sentMessage
  try {
    sentMessage = await sendMailWithGmail({
      to,
      subject,
      bodyText,
      attachments: [
        ...files.map((file) => file.attachment),
        ...employeeInformationAttachments,
      ],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'メール送信に失敗しました'
    return NextResponse.json({
      error: message,
      files: responseFiles,
    }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    sent: true,
    officeName: LABOR_OFFICE_NAME,
    recipients: LABOR_RECIPIENTS,
    files: responseFiles,
    newEmployeeFiles: employeeInformationAttachments.map((file) => file.fileName),
    docScannerFiles: docScannerAttachments.map((file) => file.fileName),
    messageId: sentMessage.id,
  })
}
