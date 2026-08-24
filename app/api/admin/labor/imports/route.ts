import { NextResponse } from 'next/server'
import { getManagementPermissions } from '@/lib/management-permissions'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

type LaborBatchRow = {
  id: string
  source_root: string
  payroll_kind: string
  target_attendance_month: string | null
  target_payroll_month: string | null
  period_start: string | null
  period_end: string | null
  pay_date: string | null
  status: string
  summary: Record<string, unknown> | null
  imported_at: string
  created_at: string
}

type LaborDocumentRow = {
  id: string
  import_batch_id: string | null
  relative_path: string
  file_name: string
  file_extension: string
  file_size: number | string | null
  document_type: string
  target_attendance_month: string | null
  target_payroll_month: string | null
  extraction_status: string
  extraction_notes: string | null
  extracted_summary: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

function numberValue(value: number | string | null | undefined) {
  const next = Number(value || 0)
  return Number.isFinite(next) ? next : 0
}

function kindLabel(kind: string) {
  if (kind === 'bonus') return '賞与'
  if (kind === 'adjustment') return '調整'
  return '給与'
}

export async function GET() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const permissions = getManagementPermissions(user)
  if (!permissions.canViewPayroll) {
    return NextResponse.json({ error: '労務データ閲覧権限が必要です' }, { status: 403 })
  }

  const [
    { data: batches, error: batchesError },
    { data: documents, error: documentsError },
  ] = await Promise.all([
    adminClient
      .from('gw_labor_import_batches')
      .select('id, source_root, payroll_kind, target_attendance_month, target_payroll_month, period_start, period_end, pay_date, status, summary, imported_at, created_at')
      .order('target_payroll_month', { ascending: false, nullsFirst: false })
      .order('imported_at', { ascending: false }),
    adminClient
      .from('gw_labor_source_documents')
      .select('id, import_batch_id, relative_path, file_name, file_extension, file_size, document_type, target_attendance_month, target_payroll_month, extraction_status, extraction_notes, extracted_summary, created_at, updated_at')
      .order('target_payroll_month', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false }),
  ])

  const dbError = batchesError || documentsError
  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  const documentRows = ((documents || []) as LaborDocumentRow[]).map((document) => ({
    ...document,
    fileSize: numberValue(document.file_size),
  }))

  const documentsByBatch = new Map<string, typeof documentRows>()
  for (const document of documentRows) {
    if (!document.import_batch_id) continue
    const list = documentsByBatch.get(document.import_batch_id) || []
    list.push(document)
    documentsByBatch.set(document.import_batch_id, list)
  }

  const batchRows = ((batches || []) as LaborBatchRow[]).map((batch) => {
    const docs = documentsByBatch.get(batch.id) || []
    return {
      ...batch,
      payrollKindLabel: kindLabel(batch.payroll_kind),
      documentCount: docs.length,
      extractedCount: docs.filter((doc) => doc.extraction_status === 'extracted').length,
      imageOnlyCount: docs.filter((doc) => doc.extraction_status === 'image_only').length,
      failedCount: docs.filter((doc) => doc.extraction_status === 'failed').length,
      totalFileSize: docs.reduce((sum, doc) => sum + doc.fileSize, 0),
    }
  })

  const statusSummary = documentRows.reduce<Record<string, number>>((summary, document) => {
    summary[document.extraction_status] = (summary[document.extraction_status] || 0) + 1
    return summary
  }, {})

  const typeSummary = documentRows.reduce<Record<string, number>>((summary, document) => {
    summary[document.document_type] = (summary[document.document_type] || 0) + 1
    return summary
  }, {})

  return NextResponse.json({
    summary: {
      batches: batchRows.length,
      documents: documentRows.length,
      extracted: statusSummary.extracted || 0,
      imageOnly: statusSummary.image_only || 0,
      failed: statusSummary.failed || 0,
      totalFileSize: documentRows.reduce((sum, doc) => sum + doc.fileSize, 0),
    },
    statusSummary,
    typeSummary,
    batches: batchRows,
    documents: documentRows.slice(0, 240),
  })
}
