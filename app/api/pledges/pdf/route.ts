import { NextRequest, NextResponse } from 'next/server'
import { createSignedPledgePdf } from '@/lib/pledge-pdf'
import { normalizePledgeItems } from '@/lib/pledges'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  const assignmentId = request.nextUrl.searchParams.get('assignment_id') || ''
  if (!assignmentId) return NextResponse.json({ error: '誓約書を確認してください' }, { status: 400 })

  const { data: assignment, error } = await adminClient
    .from('gw_pledge_assignments')
    .select('status, delivery_id, signer_name, pledged_at, signed_attachment')
    .eq('id', assignmentId)
    .eq('user_id', user.id)
    .eq('status', 'submitted')
    .single()
  if (error || !assignment) return NextResponse.json({ error: '誓約書PDFが見つかりません' }, { status: 404 })

  const { data: delivery, error: deliveryError } = await adminClient
    .from('gw_pledge_deliveries')
    .select('title_snapshot, body_snapshot, check_items_snapshot, agreement_label_snapshot, company_name_snapshot')
    .eq('id', assignment.delivery_id)
    .single()
  if (deliveryError || !delivery || !assignment.signer_name || !assignment.pledged_at) {
    return NextResponse.json({ error: '誓約書PDFの署名情報がありません' }, { status: 404 })
  }

  const attachment = assignment.signed_attachment && typeof assignment.signed_attachment === 'object'
    ? assignment.signed_attachment as { name?: string }
    : null

  try {
    const pdf = await createSignedPledgePdf({
      title: delivery.title_snapshot,
      body: delivery.body_snapshot,
      checkItems: normalizePledgeItems(delivery.check_items_snapshot),
      agreementLabel: delivery.agreement_label_snapshot,
      companyName: delivery.company_name_snapshot,
      signerName: assignment.signer_name,
      pledgedAt: assignment.pledged_at,
    })
    const encodedName = encodeURIComponent(attachment?.name || '誓約書.pdf')
    return new NextResponse(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (pdfError) {
    return NextResponse.json({ error: pdfError instanceof Error ? pdfError.message : '誓約書PDFを取得できませんでした' }, { status: 500 })
  }
}
