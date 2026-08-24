import { NextRequest, NextResponse } from 'next/server'
import { USER_DEPARTMENTS, type UserDepartment } from '@/lib/departments'
import { compactPledgeName, normalizePledgeItems } from '@/lib/pledges'
import { pledgeReminderInfo, pledgeReminderRank } from '@/lib/pledge-reminders'
import { getUserSession } from '@/lib/session'
import { isManagementUser } from '@/lib/user-roles'
import { adminClient } from '@/lib/supabase/admin'

function cleanText(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

async function requireAdmin() {
  const user = await getUserSession()
  if (!user) return { user: null, error: '認証が必要です', status: 401 }
  if (!isManagementUser(user)) return { user: null, error: '役員または管理者権限が必要です', status: 403 }
  return { user, error: null, status: 0 }
}

export async function GET() {
  const auth = await requireAdmin()
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const [templatesResult, usersResult, deliveriesResult] = await Promise.all([
    adminClient
      .from('gw_pledge_templates')
      .select('id, title, body, check_items, agreement_label, company_name, is_active, updated_at')
      .order('updated_at', { ascending: false }),
    adminClient
      .from('gw_users')
      .select('id, display_name, real_name, picture_url, department, role, status')
      .eq('status', 'approved')
      .order('display_name', { ascending: true }),
    adminClient
      .from('gw_pledge_deliveries')
      .select('id, template_id, title_snapshot, target_type, target_label, is_test, sent_at')
      .order('sent_at', { ascending: false })
      .limit(30),
  ])
  const dbError = templatesResult.error || usersResult.error || deliveriesResult.error
  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 })

  const deliveryIds = (deliveriesResult.data || []).map((delivery) => delivery.id)
  const assignmentsResult = deliveryIds.length > 0
    ? await adminClient
      .from('gw_pledge_assignments')
      .select('id, delivery_id, user_id, recipient_name, recipient_department, status, pledged_at, signed_attachment, created_at')
      .in('delivery_id', deliveryIds)
    : { data: [], error: null }
  if (assignmentsResult.error) return NextResponse.json({ error: assignmentsResult.error.message }, { status: 500 })

  const counts = new Map<string, { total: number; submitted: number }>()
  const usersById = new Map((usersResult.data || []).map((user) => [user.id, user]))
  const deliveriesById = new Map((deliveriesResult.data || []).map((delivery) => [delivery.id, delivery]))
  const assignmentsByDelivery = new Map<string, Array<Record<string, unknown>>>()
  for (const assignment of assignmentsResult.data || []) {
    const current = counts.get(assignment.delivery_id) || { total: 0, submitted: 0 }
    current.total += 1
    if (assignment.status === 'submitted') current.submitted += 1
    counts.set(assignment.delivery_id, current)

    const delivery = deliveriesById.get(assignment.delivery_id)
    const currentUser = assignment.user_id ? usersById.get(assignment.user_id) : null
    const reminder = delivery
      ? pledgeReminderInfo(delivery.sent_at, delivery.is_test)
      : pledgeReminderInfo(assignment.created_at, false)
    const rows = assignmentsByDelivery.get(assignment.delivery_id) || []
    rows.push({
      ...assignment,
      recipient_name: assignment.recipient_name || currentUser?.real_name || currentUser?.display_name || '削除済みユーザー',
      recipient_department: assignment.recipient_department || currentUser?.department || null,
      elapsed_days: reminder.elapsedDays,
      reminder_level: assignment.status === 'submitted' ? 'submitted' : reminder.level,
    })
    assignmentsByDelivery.set(assignment.delivery_id, rows)
  }

  for (const rows of assignmentsByDelivery.values()) {
    rows.sort((a, b) => {
      const aLevel = typeof a.reminder_level === 'string' && a.reminder_level !== 'submitted' ? a.reminder_level : 'pending'
      const bLevel = typeof b.reminder_level === 'string' && b.reminder_level !== 'submitted' ? b.reminder_level : 'pending'
      const aSubmitted = a.reminder_level === 'submitted'
      const bSubmitted = b.reminder_level === 'submitted'
      if (aSubmitted !== bSubmitted) return aSubmitted ? 1 : -1
      return pledgeReminderRank(bLevel as 'pending' | 'warning' | 'final') - pledgeReminderRank(aLevel as 'pending' | 'warning' | 'final')
        || String(a.recipient_name || '').localeCompare(String(b.recipient_name || ''), 'ja')
    })
  }

  const users = (usersResult.data || [])
    .filter((user) => compactPledgeName(user.real_name || user.display_name) !== 'TSG君')
    .map((user) => ({ ...user, display_name: user.real_name || user.display_name }))

  return NextResponse.json({
    templates: templatesResult.data || [],
    users,
    deliveries: (deliveriesResult.data || []).map((delivery) => ({
      ...delivery,
      total: counts.get(delivery.id)?.total || 0,
      submitted: counts.get(delivery.id)?.submitted || 0,
      assignments: assignmentsByDelivery.get(delivery.id) || [],
    })),
  })
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin()
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const body = await request.json().catch(() => ({})) as Record<string, unknown>
  const action = cleanText(body.action, 40)

  if (action === 'save_template') {
    const templateId = cleanText(body.template_id, 80)
    const title = cleanText(body.title, 180)
    const templateBody = cleanText(body.body, 12000)
    const agreementLabel = cleanText(body.agreement_label, 180)
    const companyName = cleanText(body.company_name, 180)
    const isActive = body.is_active !== false
    const checkItems = normalizePledgeItems(body.check_items)
    if (!title || !templateBody || !agreementLabel || !companyName || checkItems.length === 0) {
      return NextResponse.json({ error: 'タイトル、本文、チェック項目、同意ボタン、会社名を確認してください' }, { status: 400 })
    }

    const payload = {
      title,
      body: templateBody,
      check_items: checkItems,
      agreement_label: agreementLabel,
      company_name: companyName,
      is_active: isActive,
      updated_by: auth.user!.id,
      updated_at: new Date().toISOString(),
    }

    if (templateId) {
      const { data, error } = await adminClient
        .from('gw_pledge_templates')
        .update(payload)
        .eq('id', templateId)
        .select('id')
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true, template_id: data.id })
    }

    const { data, error } = await adminClient
      .from('gw_pledge_templates')
      .insert({ ...payload, created_by: auth.user!.id })
      .select('id')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, template_id: data.id })
  }

  if (action === 'set_template_active') {
    const templateId = cleanText(body.template_id, 80)
    const isActive = body.is_active === true
    if (!templateId) return NextResponse.json({ error: '誓約書を選択してください' }, { status: 400 })

    const { data, error } = await adminClient
      .from('gw_pledge_templates')
      .update({
        is_active: isActive,
        updated_by: auth.user!.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', templateId)
      .select('id, is_active')
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: '誓約書が見つかりません' }, { status: 404 })
    return NextResponse.json({ success: true, template_id: data.id, is_active: data.is_active })
  }

  if (action !== 'send' && action !== 'send_test') {
    return NextResponse.json({ error: '未対応の操作です' }, { status: 400 })
  }

  const templateId = cleanText(body.template_id, 80)
  if (!templateId) return NextResponse.json({ error: '誓約テンプレートを保存してください' }, { status: 400 })
  const { data: template, error: templateError } = await adminClient
    .from('gw_pledge_templates')
    .select('id, title, body, check_items, agreement_label, company_name')
    .eq('id', templateId)
    .eq('is_active', true)
    .single()
  if (templateError || !template) return NextResponse.json({ error: '誓約テンプレートが見つかりません' }, { status: 404 })

  const { data: approvedUsers, error: usersError } = await adminClient
    .from('gw_users')
    .select('id, display_name, real_name, department, status')
    .eq('status', 'approved')
  if (usersError) return NextResponse.json({ error: usersError.message }, { status: 500 })
  const eligibleUsers = (approvedUsers || []).filter((user) => compactPledgeName(user.real_name || user.display_name) !== 'TSG君')

  const isTest = action === 'send_test'
  let targetType: 'all' | 'department' | 'individual' | 'test' = 'test'
  let targetLabel = '佐藤正彦（テスト）'
  let targets = eligibleUsers.filter((user) => compactPledgeName(user.real_name || user.display_name) === '佐藤正彦')

  if (!isTest) {
    const requestedType = cleanText(body.target_type, 30)
    if (requestedType === 'all') {
      targetType = 'all'
      targetLabel = '全員'
      targets = eligibleUsers
    } else if (requestedType === 'department') {
      const department = cleanText(body.department, 30) as UserDepartment
      if (!USER_DEPARTMENTS.includes(department)) return NextResponse.json({ error: '所属を確認してください' }, { status: 400 })
      targetType = 'department'
      targetLabel = department
      targets = eligibleUsers.filter((user) => user.department === department)
    } else if (requestedType === 'individual') {
      const targetIds = new Set(Array.isArray(body.user_ids) ? body.user_ids.filter((id): id is string => typeof id === 'string') : [])
      targetType = 'individual'
      targets = eligibleUsers.filter((user) => targetIds.has(user.id))
      targetLabel = targets.length === 1 ? (targets[0].real_name || targets[0].display_name) : `個別 ${targets.length}名`
    } else {
      return NextResponse.json({ error: '送信先を選択してください' }, { status: 400 })
    }
  }

  if (targets.length === 0) {
    return NextResponse.json({ error: isTest ? '佐藤正彦の承認済みアカウントが見つかりません' : '送信対象者がいません' }, { status: 400 })
  }

  const { data: delivery, error: deliveryError } = await adminClient
    .from('gw_pledge_deliveries')
    .insert({
      template_id: template.id,
      title_snapshot: template.title,
      body_snapshot: template.body,
      check_items_snapshot: normalizePledgeItems(template.check_items),
      agreement_label_snapshot: template.agreement_label,
      company_name_snapshot: template.company_name,
      target_type: targetType,
      target_label: targetLabel,
      is_test: isTest,
      sent_by: auth.user!.id,
      sent_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (deliveryError || !delivery) return NextResponse.json({ error: deliveryError?.message || '配信を作成できませんでした' }, { status: 500 })

  const { error: assignmentError } = await adminClient
    .from('gw_pledge_assignments')
    .insert(targets.map((target) => ({
      delivery_id: delivery.id,
      user_id: target.id,
      recipient_name: target.real_name || target.display_name,
      recipient_department: target.department,
      status: 'pending',
    })))
  if (assignmentError) {
    await adminClient.from('gw_pledge_deliveries').delete().eq('id', delivery.id)
    return NextResponse.json({ error: assignmentError.message }, { status: 500 })
  }

  try {
    const { sendPushNotificationToUser } = await import('@/lib/web-push')
    await Promise.allSettled(targets.map((target) => sendPushNotificationToUser(target.id, {
      title: '誓約書が届いています',
      body: template.title,
      url: '/groups',
      tag: `tsg-pledge-${delivery.id}`,
    })))
  } catch (error) {
    console.error('[Pledge push error]', error)
  }

  return NextResponse.json({ success: true, delivery_id: delivery.id, recipients: targets.length, is_test: isTest })
}
