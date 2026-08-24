import { NextRequest, NextResponse } from 'next/server'
import { uploadFileToDrive } from '@/lib/drive'
import { createSignedPledgePdf } from '@/lib/pledge-pdf'
import { normalizePledgeItems } from '@/lib/pledges'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

type AssignmentRow = {
  id: string
  delivery_id: string
  status: 'pending' | 'processing' | 'submitted'
  signer_name: string | null
  pledged_at: string | null
  signed_attachment: Record<string, unknown> | null
  dm_group_id: string | null
  created_at: string
}

async function ensureSelfDirectChat(user: { id: string; display_name: string }) {
  const key = `direct:${user.id}:${user.id}`
  const { data: existing, error: existingError } = await adminClient
    .from('gw_groups')
    .select('id')
    .eq('type', 'chat')
    .eq('description', key)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (existingError) throw existingError

  let groupId = existing?.id || ''
  if (!groupId) {
    const { data: created, error } = await adminClient
      .from('gw_groups')
      .insert({
        name: `${user.display_name} のメモ`,
        description: key,
        type: 'chat',
        icon: '💬',
        created_by: user.id,
      })
      .select('id')
      .single()
    if (error || !created) throw error || new Error('本人DMを作成できませんでした')
    groupId = created.id
  }

  const { error: memberError } = await adminClient
    .from('gw_group_members')
    .upsert({ group_id: groupId, user_id: user.id, role: 'member' }, { onConflict: 'group_id,user_id' })
  if (memberError) throw memberError
  return groupId
}

async function loadAssignments(userId: string, assignmentId?: string) {
  await adminClient
    .from('gw_pledge_assignments')
    .update({ status: 'pending', updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('status', 'processing')
    .lt('updated_at', new Date(Date.now() - 10 * 60 * 1000).toISOString())

  let query = adminClient
    .from('gw_pledge_assignments')
    .select('id, delivery_id, status, signer_name, pledged_at, signed_attachment, dm_group_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (assignmentId) query = query.eq('id', assignmentId)
  else query = query.eq('status', 'pending')

  const { data, error } = await query
  if (error) throw error
  const assignments = (data || []) as AssignmentRow[]
  const deliveryIds = [...new Set(assignments.map((assignment) => assignment.delivery_id))]
  const { data: deliveries, error: deliveryError } = deliveryIds.length > 0
    ? await adminClient
      .from('gw_pledge_deliveries')
      .select('id, title_snapshot, body_snapshot, check_items_snapshot, agreement_label_snapshot, company_name_snapshot, is_test, sent_at')
      .in('id', deliveryIds)
    : { data: [], error: null }
  if (deliveryError) throw deliveryError
  const deliveryMap = new Map((deliveries || []).map((delivery) => [delivery.id, delivery]))

  return assignments.flatMap((assignment) => {
    const delivery = deliveryMap.get(assignment.delivery_id)
    return delivery ? [{ ...assignment, delivery }] : []
  })
}

export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  try {
    const assignmentId = request.nextUrl.searchParams.get('assignment_id') || undefined
    const assignments = await loadAssignments(user.id, assignmentId)
    if (assignmentId && assignments.length === 0) return NextResponse.json({ error: '誓約書が見つかりません' }, { status: 404 })
    return NextResponse.json({ assignments })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '誓約書を取得できませんでした' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const assignmentId = typeof body.assignment_id === 'string' ? body.assignment_id : ''
  const acceptedIds = [...new Set(Array.isArray(body.accepted_item_ids)
    ? body.accepted_item_ids.filter((value): value is string => typeof value === 'string')
    : [])]
  if (!assignmentId) return NextResponse.json({ error: '誓約書を確認してください' }, { status: 400 })

  await adminClient
    .from('gw_pledge_assignments')
    .update({ status: 'pending', updated_at: new Date().toISOString() })
    .eq('id', assignmentId)
    .eq('user_id', user.id)
    .eq('status', 'processing')
    .lt('updated_at', new Date(Date.now() - 10 * 60 * 1000).toISOString())

  const { data: assignment, error: assignmentError } = await adminClient
    .from('gw_pledge_assignments')
    .select('id, delivery_id, status, signed_attachment, dm_group_id')
    .eq('id', assignmentId)
    .eq('user_id', user.id)
    .single()
  if (assignmentError || !assignment) return NextResponse.json({ error: '誓約書が見つかりません' }, { status: 404 })
  if (assignment.status === 'submitted') {
    return NextResponse.json({ success: true, already_submitted: true, attachment: assignment.signed_attachment, dm_group_id: assignment.dm_group_id })
  }
  if (assignment.status === 'processing') return NextResponse.json({ error: '誓約書を作成中です。少し待ってから確認してください' }, { status: 409 })

  const { data: delivery, error: deliveryError } = await adminClient
    .from('gw_pledge_deliveries')
    .select('id, title_snapshot, body_snapshot, check_items_snapshot, agreement_label_snapshot, company_name_snapshot')
    .eq('id', assignment.delivery_id)
    .single()
  if (deliveryError || !delivery) return NextResponse.json({ error: '配信内容が見つかりません' }, { status: 404 })
  const checkItems = normalizePledgeItems(delivery.check_items_snapshot)
  const acceptedSet = new Set(acceptedIds)
  if (checkItems.length === 0 || checkItems.some((item) => !acceptedSet.has(item.id))) {
    return NextResponse.json({ error: 'すべてのチェック項目を確認してください' }, { status: 400 })
  }

  const processingAt = new Date().toISOString()
  const { data: locked, error: lockError } = await adminClient
    .from('gw_pledge_assignments')
    .update({ status: 'processing', updated_at: processingAt })
    .eq('id', assignment.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (lockError) return NextResponse.json({ error: lockError.message }, { status: 500 })
  if (!locked) return NextResponse.json({ error: '誓約書の状態が更新されています。再読み込みしてください' }, { status: 409 })

  try {
    const pledgedAt = new Date().toISOString()
    const signerName = user.real_name || user.display_name
    const pdf = await createSignedPledgePdf({
      title: delivery.title_snapshot,
      body: delivery.body_snapshot,
      checkItems,
      agreementLabel: delivery.agreement_label_snapshot,
      companyName: delivery.company_name_snapshot,
      signerName,
      pledgedAt,
    })
    const dateToken = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(pledgedAt))
    const safeName = signerName.replace(/[\\/:*?"<>|]/g, '_')
    const fileName = `誓約書_${safeName}_${dateToken}.pdf`
    const driveFile = await uploadFileToDrive(pdf, fileName, 'application/pdf', { makePublic: false })
    if (!driveFile.id) throw new Error('誓約書PDFの保存先IDを取得できませんでした')
    const fileUrl = `/pledges/pdf/${encodeURIComponent(assignment.id)}`
    const attachment = {
      url: fileUrl,
      viewUrl: fileUrl,
      name: fileName,
      type: 'application/pdf',
      driveId: driveFile.id,
    }

    const groupId = await ensureSelfDirectChat({ id: user.id, display_name: signerName })
    const { data: post, error: postError } = await adminClient
      .from('gw_posts')
      .insert({
        group_id: groupId,
        user_id: user.id,
        content: `【提出済み誓約書】${delivery.title_snapshot}`,
        attachments: [attachment],
        parent_id: null,
      })
      .select('id')
      .single()
    if (postError || !post) throw postError || new Error('DMへ誓約書を送信できませんでした')
    await adminClient.from('gw_groups').update({ updated_at: pledgedAt }).eq('id', groupId)

    const { error: completeError } = await adminClient
      .from('gw_pledge_assignments')
      .update({
        status: 'submitted',
        accepted_item_ids: checkItems.map((item) => item.id),
        signer_name: signerName,
        pledged_at: pledgedAt,
        signed_attachment: attachment,
        dm_group_id: groupId,
        dm_post_id: post.id,
        updated_at: pledgedAt,
      })
      .eq('id', assignment.id)
    if (completeError) throw completeError

    return NextResponse.json({ success: true, attachment, dm_group_id: groupId })
  } catch (error) {
    await adminClient
      .from('gw_pledge_assignments')
      .update({ status: 'pending', updated_at: new Date().toISOString() })
      .eq('id', assignment.id)
      .eq('status', 'processing')
    return NextResponse.json({ error: error instanceof Error ? error.message : '誓約書PDFを作成できませんでした' }, { status: 500 })
  }
}
