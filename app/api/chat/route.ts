import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

type Attachment = {
  url?: string
  viewUrl?: string
  name?: string
  type?: string
  driveId?: string
  webViewLink?: string
}

async function getChatAccess(groupId: string, userId: string, userRole: string) {
  const [{ data: group }, { data: membership }] = await Promise.all([
    adminClient
      .from('gw_groups')
      .select('id, name, description, type, icon, created_at, updated_at')
      .eq('id', groupId)
      .single(),
    adminClient
      .from('gw_group_members')
      .select('role')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .single(),
  ])

  if (!group || group.type !== 'chat') {
    return { group: null, membership: null, error: 'チャットが見つかりません', status: 404 }
  }

  const isDirectChat = typeof group.description === 'string' && group.description.startsWith('direct:')
  if (!membership && (userRole !== 'admin' || isDirectChat)) {
    return { group: null, membership: null, error: 'このチャットに参加していません', status: 403 }
  }

  return { group, membership: membership || { role: 'admin' }, error: null, status: 0 }
}

function normalizeAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return []

  return value
    .filter((item): item is Attachment => item && typeof item === 'object')
    .map(item => ({
      url: typeof item.url === 'string' ? item.url : '',
      viewUrl: typeof item.viewUrl === 'string' ? item.viewUrl : undefined,
      name: typeof item.name === 'string' ? item.name : '添付ファイル',
      type: typeof item.type === 'string' ? item.type : 'application/octet-stream',
      driveId: typeof item.driveId === 'string' ? item.driveId : undefined,
      webViewLink: typeof item.webViewLink === 'string' ? item.webViewLink : undefined,
    }))
    .filter(item => item.url || item.viewUrl)
}

export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const groupId = request.nextUrl.searchParams.get('group_id')
  if (!groupId) {
    return NextResponse.json({ error: 'group_id が必要です' }, { status: 400 })
  }

  const access = await getChatAccess(groupId, user.id, user.role)
  if (access.error) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const since = request.nextUrl.searchParams.get('since')
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '80', 10) || 80, 100)

  let query = adminClient
    .from('gw_posts')
    .select('id, group_id, user_id, content, attachments, created_at, updated_at')
    .eq('group_id', groupId)
    .is('parent_id', null)
    .order('created_at', { ascending: since ? true : false })
    .limit(limit)

  if (since) {
    query = query.gt('created_at', since)
  }

  const [{ data: rawMessages, error: messagesError }, { data: memberRows }] = await Promise.all([
    query,
    adminClient
      .from('gw_group_members')
      .select('user_id, role')
      .eq('group_id', groupId),
  ])

  if (messagesError) {
    return NextResponse.json({ error: messagesError.message }, { status: 500 })
  }

  const messages = since ? (rawMessages || []) : [...(rawMessages || [])].reverse()
  const userIds = [...new Set([
    ...messages.map(message => message.user_id),
    ...(memberRows || []).map(member => member.user_id),
  ])]

  const { data: users } = userIds.length > 0
    ? await adminClient
      .from('gw_users')
      .select('id, display_name, real_name, picture_url, role')
      .in('id', userIds)
    : { data: [] }

  const userMap = Object.fromEntries((users || []).map(chatUser => [
    chatUser.id, 
    { ...chatUser, display_name: chatUser.real_name || chatUser.display_name }
  ]))
  const members = (memberRows || [])
    .map(member => {
      const memberUser = userMap[member.user_id]
      if (!memberUser) return null
      return {
        id: memberUser.id,
        display_name: memberUser.display_name,
        picture_url: memberUser.picture_url,
        role: memberUser.role,
        group_role: member.role,
      }
    })
    .filter(Boolean)

  adminClient
    .from('gw_read_status')
    .upsert({
      user_id: user.id,
      group_id: groupId,
      last_read_at: new Date().toISOString(),
    }, { onConflict: 'user_id,group_id' })
    .then(undefined, e => console.error('[Chat read status update error]', e))

  return NextResponse.json({
    group: access.group,
    members,
    currentUser: {
      id: user.id,
      display_name: user.display_name,
      picture_url: user.picture_url,
      role: user.role,
    },
    messages: messages.map(message => ({
      ...message,
      author: userMap[message.user_id] || { display_name: '不明', picture_url: null },
      isOwn: message.user_id === user.id,
    })),
  })
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json()
  const groupId = body.group_id
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  const attachments = normalizeAttachments(body.attachments)

  if (!groupId) {
    return NextResponse.json({ error: 'group_id が必要です' }, { status: 400 })
  }
  if (!content && attachments.length === 0) {
    return NextResponse.json({ error: 'メッセージまたは添付ファイルが必要です' }, { status: 400 })
  }

  const access = await getChatAccess(groupId, user.id, user.role)
  if (access.error) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const { data: message, error } = await adminClient
    .from('gw_posts')
    .insert({
      group_id: groupId,
      user_id: user.id,
      content: content || null,
      attachments,
      parent_id: null,
    })
    .select('id, group_id, user_id, content, attachments, created_at, updated_at')
    .single()

  if (error || !message) {
    return NextResponse.json({ error: error?.message || 'メッセージ送信に失敗しました' }, { status: 500 })
  }

  await adminClient
    .from('gw_groups')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', groupId)

  await import('@/lib/web-push')
    .then(({ sendPushNotificationToGroup }) => {
      const bodyText = content || (attachments.length > 0 ? 'ファイルを送信しました' : '新しいメッセージ')
      return sendPushNotificationToGroup(groupId, user.id, {
        title: `${access.group?.name || 'チャット'} - ${user.display_name || 'メンバー'}`,
        body: bodyText.substring(0, 80),
        url: `/chat/${groupId}`,
        tag: `tsg-chat-${groupId}`,
      })
    })
    .catch(e => console.error('[Chat push error]', e))

  // TSG君 AI応答（非同期で実行 - レスポンスはブロックしない）
  import('@/lib/tsg-ai')
    .then(({ isTsgDirectChat, handleTsgAiResponse }) =>
      isTsgDirectChat(groupId).then(isDm => {
        if (isDm) return handleTsgAiResponse(groupId, user.id)
      })
    )
    .catch(e => console.error('[TSG AI trigger error]', e))

  return NextResponse.json({
    message: {
      ...message,
      author: {
        id: user.id,
        display_name: user.display_name,
        picture_url: user.picture_url,
      },
      isOwn: true,
    },
  }, { status: 201 })
}
