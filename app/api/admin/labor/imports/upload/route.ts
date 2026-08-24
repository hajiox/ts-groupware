import { createHash } from 'crypto'
import { NextResponse } from 'next/server'
import { uploadFileToDrive } from '@/lib/drive'
import { analyzeLaborImportBatch } from '@/lib/labor-payroll-zip'
import { getManagementPermissions } from '@/lib/management-permissions'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 60

type ZipEntry = {
  entryPath: string
  fileName: string
  fileExtension: string
  fileSize: number
  compressedSize: number
  crc32: string
  documentType: string
}

function monthStart(value: FormDataEntryValue | null): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  if (/^\d{4}-\d{2}$/.test(text)) return `${text}-01`
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.slice(0, 8) + '01'
  return null
}

function previousMonth(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, monthNumber - 2, 1))
  return date.toISOString().slice(0, 10)
}

function monthEnd(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10)
}

function payrollKind(value: FormDataEntryValue | null) {
  const text = typeof value === 'string' ? value : ''
  if (text === 'bonus') return 'bonus'
  if (text === 'adjustment') return 'adjustment'
  return 'monthly'
}

function fileExtension(name: string) {
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index).toLowerCase() : ''
}

function classifyDocument(name: string) {
  const normalized = name.replace(/\s/g, '')
  if (normalized.endsWith('.zip')) return 'zip_package'
  if (normalized.includes('従業員一覧')) return 'employee_master'
  if (normalized.includes('勤怠チェックリスト')) return 'attendance_checklist'
  if (normalized.includes('勤怠一覧') || normalized.includes('従業員毎勤怠集計')) return 'attendance_summary'
  if (normalized.includes('支給控除一覧') || normalized.includes('賃金台帳')) return 'payroll_statement'
  if (normalized.includes('給与集計') || normalized.includes('給与計算チェックリスト')) return 'payroll_checklist'
  if (normalized.includes('事業所負担保険料')) return 'employer_insurance_cost'
  if (normalized.includes('通勤費') || normalized.includes('時給一覧')) return 'payroll_reference'
  if (normalized.includes('休憩時間')) return 'break_rule_reference'
  return 'unknown'
}

function readName(buffer: Buffer, start: number, length: number, utf8: boolean) {
  const slice = buffer.subarray(start, start + length)
  if (utf8) return slice.toString('utf8')
  try {
    return new TextDecoder('shift_jis').decode(slice)
  } catch {
    return slice.toString('utf8')
  }
}

function parseZipEntries(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('ZIPファイルとして認識できません')
  }

  const maxCommentLength = Math.min(buffer.length, 0xffff + 22)
  let eocdOffset = -1
  for (let offset = buffer.length - 22; offset >= buffer.length - maxCommentLength; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset < 0) {
    throw new Error('ZIPの中央ディレクトリが見つかりません')
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10)
  let offset = buffer.readUInt32LE(eocdOffset + 16)
  const entries: ZipEntry[] = []

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break

    const flags = buffer.readUInt16LE(offset + 8)
    const crc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const fileSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const rawName = readName(buffer, offset + 46, nameLength, Boolean(flags & 0x0800))
    const entryPath = rawName.replace(/\\/g, '/').replace(/^\/+/, '')
    offset += 46 + nameLength + extraLength + commentLength

    if (!entryPath || entryPath.endsWith('/')) continue
    const fileName = entryPath.split('/').pop() || entryPath
    const extension = fileExtension(fileName)
    if (!['.pdf', '.xls', '.xlsx', '.csv', '.txt'].includes(extension)) continue

    entries.push({
      entryPath,
      fileName,
      fileExtension: extension,
      fileSize,
      compressedSize,
      crc32: crc.toString(16).padStart(8, '0'),
      documentType: classifyDocument(fileName),
    })
  }

  return entries
}

function sha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function entryHash(zipHash: string, entry: ZipEntry) {
  return createHash('sha256')
    .update(`${zipHash}\n${entry.entryPath}\n${entry.crc32}\n${entry.fileSize}`)
    .digest('hex')
}

export async function POST(request: Request) {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

  const permissions = getManagementPermissions(user)
  if (!permissions.canViewPayroll) {
    return NextResponse.json({ error: '労務データ取込権限が必要です' }, { status: 403 })
  }

  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'ZIPファイルを選択してください' }, { status: 400 })
  }
  if (!file.name.toLowerCase().endsWith('.zip')) {
    return NextResponse.json({ error: 'ZIPファイルのみ取り込めます' }, { status: 400 })
  }

  const payrollMonth = monthStart(form.get('payrollMonth'))
  if (!payrollMonth) {
    return NextResponse.json({ error: '給与月を指定してください' }, { status: 400 })
  }
  const attendanceMonth = monthStart(form.get('attendanceMonth')) || previousMonth(payrollMonth)
  const kind = payrollKind(form.get('payrollKind'))
  const buffer = Buffer.from(await file.arrayBuffer())
  const zipHash = sha256(buffer)
  const entries = parseZipEntries(buffer)

  const { data: existingPeriod, error: existingPeriodError } = await adminClient
    .from('gw_payroll_periods')
    .select('id')
    .eq('payroll_month', payrollMonth)
    .eq('payroll_kind', kind)
    .maybeSingle()

  if (existingPeriodError) {
    return NextResponse.json({ error: existingPeriodError.message }, { status: 500 })
  }

  let payrollPeriodId = existingPeriod?.id || null
  if (!payrollPeriodId) {
    const { data: createdPeriod, error: periodError } = await adminClient
      .from('gw_payroll_periods')
      .insert({
        payroll_month: payrollMonth,
        payroll_kind: kind,
        attendance_month: attendanceMonth,
        period_start: attendanceMonth,
        period_end: monthEnd(attendanceMonth),
        pay_date: `${payrollMonth.slice(0, 7)}-10`,
        created_by: user.id,
      })
      .select('id')
      .single()

    if (periodError || !createdPeriod) {
      return NextResponse.json({ error: periodError?.message || '給与期間を作成できませんでした' }, { status: 500 })
    }
    payrollPeriodId = createdPeriod.id
  }

  let drive: { id?: string | null; webViewLink?: string | null; webContentLink?: string | null } | null = null
  let driveUploadError: string | null = null
  try {
    drive = await uploadFileToDrive(buffer, `労務ZIP_${payrollMonth.slice(0, 7)}_${file.name}`, 'application/zip')
  } catch (error) {
    driveUploadError = error instanceof Error ? error.message : 'Drive upload failed'
  }

  const summary = {
    source: 'labor_zip_upload',
    zipFileName: file.name,
    zipSha256: zipHash,
    zipFileSize: buffer.length,
    zipDriveFileId: drive?.id || null,
    zipDriveUrl: drive?.webViewLink || null,
    driveUploadError,
    entryCount: entries.length,
    supportedEntryCount: entries.length,
    analysisStage: 'source_registered',
    requiresExtraction: true,
    payrollPeriodId,
    nextStep: 'ZIP内ファイルを労務士データとして解析し、自社計算との差分を確認する',
  }

  const { data: batch, error: batchError } = await adminClient
    .from('gw_labor_import_batches')
    .insert({
      source_root: `zip:${file.name}`,
      payroll_kind: kind,
      target_attendance_month: attendanceMonth,
      target_payroll_month: payrollMonth,
      period_start: attendanceMonth,
      period_end: new Date(Date.UTC(Number(attendanceMonth.slice(0, 4)), Number(attendanceMonth.slice(5, 7)), 0)).toISOString().slice(0, 10),
      pay_date: `${payrollMonth.slice(0, 7)}-10`,
      status: 'draft',
      summary,
      imported_by: user.id,
    })
    .select('id')
    .single()

  if (batchError || !batch) {
    return NextResponse.json({ error: batchError?.message || '取込バッチを作成できませんでした' }, { status: 500 })
  }

  const zipDocument = {
    import_batch_id: batch.id,
    relative_path: file.name,
    file_name: file.name,
    file_extension: '.zip',
    file_size: buffer.length,
    sha256: zipHash,
    document_type: 'zip_package',
    target_attendance_month: attendanceMonth,
    target_payroll_month: payrollMonth,
    extraction_status: 'pending',
    extraction_notes: driveUploadError ? `Drive保管失敗: ${driveUploadError}` : 'ZIPを保管しました。中身の解析待ちです。',
    extracted_summary: summary,
  }

  const entryDocuments = entries.map((entry) => ({
    import_batch_id: batch.id,
    relative_path: `${file.name}/${entry.entryPath}`,
    file_name: entry.fileName,
    file_extension: entry.fileExtension,
    file_size: entry.fileSize,
    sha256: entryHash(zipHash, entry),
    document_type: entry.documentType,
    target_attendance_month: attendanceMonth,
    target_payroll_month: payrollMonth,
    extraction_status: 'pending',
    extraction_notes: 'ZIP取込で検出。本文解析待ちです。',
    extracted_summary: {
      source: 'labor_zip_entry',
      zipFileName: file.name,
      entryPath: entry.entryPath,
      compressedSize: entry.compressedSize,
      crc32: entry.crc32,
    },
  }))

  const { error: documentsError } = await adminClient
    .from('gw_labor_source_documents')
    .upsert([zipDocument, ...entryDocuments], { onConflict: 'sha256' })

  if (documentsError) {
    return NextResponse.json({ error: documentsError.message }, { status: 500 })
  }

  let analysis: Awaited<ReturnType<typeof analyzeLaborImportBatch>> | null = null
  let analysisError: string | null = null
  try {
    analysis = await analyzeLaborImportBatch(batch.id, buffer)
  } catch (error) {
    analysisError = error instanceof Error ? error.message : '労務ZIPの解析に失敗しました'
  }

  return NextResponse.json({
    ok: true,
    batchId: batch.id,
    driveUploaded: !driveUploadError,
    driveUploadError,
    payrollPeriodId,
    analysisStage: 'source_registered',
    requiresExtraction: !analysis,
    analysis,
    analysisError,
    summary,
    entries,
  })
}
