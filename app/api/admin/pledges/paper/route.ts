import { NextRequest, NextResponse } from 'next/server'
import { downloadFileFromDrive } from '@/lib/drive'
import { pledgePaperNumber } from '@/lib/pledge-paper'
import { normalizePledgeItems } from '@/lib/pledges'
import { getUserSession } from '@/lib/session'
import { isManagementUser } from '@/lib/user-roles'
import { adminClient } from '@/lib/supabase/admin'

async function requireAdmin() {
  const user = await getUserSession()
  if (!user) return { user: null, response: NextResponse.json({ error: '認証が必要です' }, { status: 401 }) }
  if (!isManagementUser(user)) return { user: null, response: NextResponse.json({ error: '役員または管理者権限が必要です' }, { status: 403 }) }
  return { user, response: null }
}

function attachmentObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin()
  if (auth.response) return auth.response

  const assignmentId = request.nextUrl.searchParams.get('assignment_id')?.trim() || ''
  if (assignmentId) {
    const { data: assignment, error } = await adminClient
      .from('gw_pledge_assignments')
      .select('signed_attachment')
      .eq('id', assignmentId)
      .eq('status', 'submitted')
      .single()
    if (error || !assignment) return NextResponse.json({ error: '紙の誓約書が見つかりません' }, { status: 404 })
    const attachment = attachmentObject(assignment.signed_attachment)
    const driveId = typeof attachment?.driveId === 'string' ? attachment.driveId : ''
    if (!driveId || attachment?.source !== 'doc-scanner-paper-pledge') {
      return NextResponse.json({ error: '紙の誓約書原本がありません' }, { status: 404 })
    }
    try {
      const file = await downloadFileFromDrive(driveId)
      const name = typeof attachment.name === 'string' ? attachment.name : '紙提出誓約書.pdf'
      return new NextResponse(file, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (downloadError) {
      return NextResponse.json({ error: downloadError instanceof Error ? downloadError.message : '紙の誓約書を取得できませんでした' }, { status: 500 })
    }
  }

  const deliveryId = request.nextUrl.searchParams.get('delivery_id')?.trim() || ''
  if (!deliveryId) return NextResponse.json({ error: 'delivery_idが必要です' }, { status: 400 })
  const { data: delivery, error } = await adminClient
    .from('gw_pledge_deliveries')
    .select('id, template_id, title_snapshot, body_snapshot, check_items_snapshot, agreement_label_snapshot, company_name_snapshot, target_label, sent_at')
    .eq('id', deliveryId)
    .single()
  if (error || !delivery || delivery.target_label !== '紙原本') {
    return NextResponse.json({ error: '印刷する誓約書が見つかりません' }, { status: 404 })
  }
  return NextResponse.json({
    delivery: {
      ...delivery,
      check_items_snapshot: normalizePledgeItems(delivery.check_items_snapshot),
      pledge_number: pledgePaperNumber(delivery),
    },
  })
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin()
  if (auth.response) return auth.response
  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const templateId = typeof body.template_id === 'string' ? body.template_id.trim() : ''
  if (!templateId) return NextResponse.json({ error: '誓約テンプレートを保存してください' }, { status: 400 })

  const { data: template, error: templateError } = await adminClient
    .from('gw_pledge_templates')
    .select('id, title, body, check_items, agreement_label, company_name')
    .eq('id', templateId)
    .eq('is_active', true)
    .single()
  if (templateError || !template) return NextResponse.json({ error: '誓約テンプレートが見つかりません' }, { status: 404 })

  const sentAt = new Date().toISOString()
  const { data: delivery, error: deliveryError } = await adminClient
    .from('gw_pledge_deliveries')
    .insert({
      template_id: template.id,
      title_snapshot: template.title,
      body_snapshot: template.body,
      check_items_snapshot: normalizePledgeItems(template.check_items),
      agreement_label_snapshot: template.agreement_label,
      company_name_snapshot: template.company_name,
      target_type: 'individual',
      target_label: '紙原本',
      is_test: false,
      sent_by: auth.user!.id,
      sent_at: sentAt,
    })
    .select('id, template_id, title_snapshot, body_snapshot, check_items_snapshot, agreement_label_snapshot, company_name_snapshot, target_label, sent_at')
    .single()
  if (deliveryError || !delivery) {
    return NextResponse.json({ error: deliveryError?.message || '紙原本を発行できませんでした' }, { status: 500 })
  }

  return NextResponse.json({
    delivery: {
      ...delivery,
      check_items_snapshot: normalizePledgeItems(delivery.check_items_snapshot),
      pledge_number: pledgePaperNumber(delivery),
    },
  }, { status: 201 })
}
