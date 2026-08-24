import { NextRequest, NextResponse } from 'next/server'
import {
  MAX_RESUME_BYTES,
  deleteHRResume,
  downloadHRResume,
  getHRResumeDocument,
  loadHREmployee,
  reprocessHRResume,
  saveAndProcessHRResume,
} from '@/lib/hr-resume-service'
import { getManagementPermissions } from '@/lib/management-permissions'
import { getUserSession } from '@/lib/session'

export const runtime = 'nodejs'
export const maxDuration = 60

async function requireHRPermission() {
  const user = await getUserSession()
  if (!user) return { error: NextResponse.json({ error: '認証が必要です' }, { status: 401 }), user: null }
  if (!getManagementPermissions(user).canViewPayroll) {
    return { error: NextResponse.json({ error: '人事管理権限が必要です' }, { status: 403 }), user: null }
  }
  return { error: null, user }
}

export async function GET(request: NextRequest) {
  const auth = await requireHRPermission()
  if (auth.error) return auth.error

  const documentId = request.nextUrl.searchParams.get('document_id') || ''
  if (!documentId) return NextResponse.json({ error: '履歴書を指定してください' }, { status: 400 })

  try {
    const document = await getHRResumeDocument(documentId)
    if (!document) return NextResponse.json({ error: '履歴書が見つかりません' }, { status: 404 })
    const file = await downloadHRResume(document)
    const encodedName = encodeURIComponent(document.file_name || '履歴書.pdf')
    return new NextResponse(file, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '履歴書を取得できませんでした' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireHRPermission()
  if (auth.error) return auth.error

  const form = await request.formData()
  const employeeId = typeof form.get('employee_id') === 'string' ? String(form.get('employee_id')).trim() : ''
  const file = form.get('file')
  if (!employeeId) return NextResponse.json({ error: '従業員を指定してください' }, { status: 400 })
  if (!(file instanceof File)) return NextResponse.json({ error: '履歴書PDFを選択してください' }, { status: 400 })
  if (file.size <= 0 || file.size > MAX_RESUME_BYTES) {
    return NextResponse.json({ error: '履歴書PDFは4MB以内にしてください' }, { status: 400 })
  }

  const employee = await loadHREmployee(employeeId).catch(() => null)
  if (!employee) return NextResponse.json({ error: '従業員が見つかりません' }, { status: 404 })
  const buffer = Buffer.from(await file.arrayBuffer())
  if (buffer.subarray(0, 5).toString() !== '%PDF-') {
    return NextResponse.json({ error: 'PDF形式の履歴書を選択してください' }, { status: 400 })
  }

  try {
    const result = await saveAndProcessHRResume({
      employeeId,
      buffer,
      fileName: file.name || '履歴書.pdf',
      fileSize: file.size,
      uploadedBy: auth.user!.id,
    })
    return NextResponse.json({ ok: true, document_id: result.document.id, ocr: result.ocr })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '履歴書を保存できませんでした' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireHRPermission()
  if (auth.error) return auth.error

  const body = await request.json().catch(() => null) as { document_id?: string } | null
  if (!body?.document_id) return NextResponse.json({ error: '履歴書を指定してください' }, { status: 400 })
  try {
    const result = await reprocessHRResume(body.document_id)
    return NextResponse.json({ ok: true, document_id: result.document.id, ocr: result.ocr })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI OCRを再実行できませんでした'
    return NextResponse.json({ error: message }, { status: message === '履歴書が見つかりません' ? 404 : 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireHRPermission()
  if (auth.error) return auth.error

  const body = await request.json().catch(() => null) as { document_id?: string } | null
  if (!body?.document_id) return NextResponse.json({ error: '履歴書を指定してください' }, { status: 400 })
  try {
    await deleteHRResume(body.document_id)
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : '履歴書を削除できませんでした'
    return NextResponse.json({ error: message }, { status: message === '履歴書が見つかりません' ? 404 : 500 })
  }
}
