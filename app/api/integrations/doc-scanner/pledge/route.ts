import { NextRequest, NextResponse } from 'next/server'
import { deleteFileFromDrive, uploadFileToDrive } from '@/lib/drive'
import { normalizePledgePaperNumber, pledgePaperNumber } from '@/lib/pledge-paper'
import { normalizePledgeItems } from '@/lib/pledges'
import { adminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_PLEDGE_BYTES = 4 * 1024 * 1024

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

function normalizedPersonName(value: string | null | undefined) {
  return (value || '')
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .replace(/[（(](?:フロア|製造|道の駅)[）)]$/u, '')
    .trim()
}

function pledgedAtFromInput(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return new Date().toISOString()
  const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00+09:00`)
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString()
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || '紙提出誓約書.pdf'
}

export async function POST(request: NextRequest) {
  const authError = assertIntegrationSecret(request)
  if (authError) return authError

  let uploadedDriveId = ''
  try {
    const form = await request.formData()
    const file = form.get('file')
    const documentId = formString(form, 'document_id', 200)
    const sourceKey = formString(form, 'source_key', 240) || `pledge:${documentId}`
    const signerName = formString(form, 'signer_name', 100)
    const pledgeNumberInput = formString(form, 'pledge_number', 100)
    const pledgedDate = formString(form, 'pledged_date', 20)
    const fileNameInput = formString(form, 'file_name', 300)

    if (!documentId) return NextResponse.json({ error: 'document_id is required' }, { status: 400 })
    if (!signerName) return NextResponse.json({ error: '誓約者氏名を読み取れませんでした' }, { status: 422 })
    if (!pledgeNumberInput) return NextResponse.json({ error: '誓約書No.を読み取れませんでした' }, { status: 422 })
    if (!(file instanceof File)) return NextResponse.json({ error: 'PDF file is required' }, { status: 400 })
    if (file.size <= 0 || file.size > MAX_PLEDGE_BYTES) {
      return NextResponse.json({ error: 'PDF file must be 4MB or smaller' }, { status: 400 })
    }

    const { data: duplicate, error: duplicateError } = await adminClient
      .from('gw_pledge_assignments')
      .select('id, delivery_id, user_id, signer_name, pledged_at, signed_attachment')
      .contains('signed_attachment', { source_key: sourceKey })
      .maybeSingle()
    if (duplicateError) throw duplicateError
    if (duplicate) {
      return NextResponse.json({
        ok: true,
        duplicate: true,
        assignment_id: duplicate.id,
        delivery_id: duplicate.delivery_id,
        user_id: duplicate.user_id,
        signer_name: duplicate.signer_name,
        pledged_at: duplicate.pledged_at,
      })
    }

    const { data: deliveries, error: deliveriesError } = await adminClient
      .from('gw_pledge_deliveries')
      .select('id, sent_at, title_snapshot, check_items_snapshot, target_label')
      .eq('target_label', '紙原本')
      .order('sent_at', { ascending: false })
      .limit(500)
    if (deliveriesError) throw deliveriesError
    const normalizedNumber = normalizePledgePaperNumber(pledgeNumberInput)
    const delivery = (deliveries || []).find((candidate) => (
      normalizePledgePaperNumber(pledgePaperNumber(candidate)) === normalizedNumber
    ))
    if (!delivery) {
      return NextResponse.json({ error: `誓約書No.「${pledgeNumberInput}」に一致する紙原本がTSGにありません` }, { status: 404 })
    }

    const { data: approvedUsers, error: usersError } = await adminClient
      .from('gw_users')
      .select('id, display_name, real_name, department')
      .eq('status', 'approved')
    if (usersError) throw usersError
    const normalizedSigner = normalizedPersonName(signerName)
    const candidates = (approvedUsers || []).filter((user) => (
      [user.real_name, user.display_name].some((name) => normalizedPersonName(name) === normalizedSigner)
    ))
    if (candidates.length === 0) {
      return NextResponse.json({ error: `誓約者「${signerName}」に一致する承認済みTSGユーザーがいません` }, { status: 422 })
    }
    if (candidates.length > 1) {
      return NextResponse.json({
        error: `誓約者「${signerName}」の同名候補が複数います`,
        candidates: candidates.map((candidate) => ({ id: candidate.id, name: candidate.real_name || candidate.display_name, department: candidate.department })),
      }, { status: 409 })
    }
    const user = candidates[0]

    const { data: currentAssignment, error: assignmentLookupError } = await adminClient
      .from('gw_pledge_assignments')
      .select('id, status, signed_attachment')
      .eq('delivery_id', delivery.id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (assignmentLookupError) throw assignmentLookupError
    if (currentAssignment?.status === 'submitted') {
      return NextResponse.json({
        ok: true,
        duplicate: true,
        assignment_id: currentAssignment.id,
        delivery_id: delivery.id,
        user_id: user.id,
        signer_name: user.real_name || user.display_name,
      })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    if (buffer.subarray(0, 5).toString() !== '%PDF-') {
      return NextResponse.json({ error: 'file must be a PDF' }, { status: 400 })
    }

    const canonicalSignerName = user.real_name || user.display_name
    const pledgedAt = pledgedAtFromInput(pledgedDate)
    const fileName = safeFileName(fileNameInput || file.name || `紙提出誓約書_${canonicalSignerName}.pdf`)
    const driveFile = await uploadFileToDrive(buffer, fileName, 'application/pdf', { makePublic: false })
    if (!driveFile.id) throw new Error('紙の誓約書原本を保存できませんでした')
    uploadedDriveId = driveFile.id
    const attachment = {
      name: fileName,
      type: 'application/pdf',
      size: file.size,
      driveId: driveFile.id,
      source: 'doc-scanner-paper-pledge',
      source_key: sourceKey,
      source_document_id: documentId,
      pledge_number: pledgePaperNumber(delivery),
    }
    const assignmentPayload = {
      status: 'submitted',
      accepted_item_ids: normalizePledgeItems(delivery.check_items_snapshot).map((item) => item.id),
      signer_name: canonicalSignerName,
      pledged_at: pledgedAt,
      signed_attachment: attachment,
      recipient_name: canonicalSignerName,
      recipient_department: user.department,
      updated_at: new Date().toISOString(),
    }

    let assignmentId = currentAssignment?.id || ''
    if (currentAssignment) {
      const { error } = await adminClient
        .from('gw_pledge_assignments')
        .update(assignmentPayload)
        .eq('id', currentAssignment.id)
      if (error) throw error
    } else {
      const { data: inserted, error } = await adminClient
        .from('gw_pledge_assignments')
        .insert({ ...assignmentPayload, delivery_id: delivery.id, user_id: user.id })
        .select('id')
        .single()
      if (error || !inserted) throw error || new Error('紙提出の記録を作成できませんでした')
      assignmentId = inserted.id
    }
    uploadedDriveId = ''

    return NextResponse.json({
      ok: true,
      duplicate: false,
      assignment_id: assignmentId,
      delivery_id: delivery.id,
      user_id: user.id,
      signer_name: canonicalSignerName,
      pledged_at: pledgedAt,
      pledge_number: pledgePaperNumber(delivery),
    }, { status: 201 })
  } catch (error) {
    if (uploadedDriveId) await deleteFileFromDrive(uploadedDriveId).catch(() => {})
    return NextResponse.json({ error: error instanceof Error ? error.message : '紙の誓約書をTSGへ保存できませんでした' }, { status: 500 })
  }
}

