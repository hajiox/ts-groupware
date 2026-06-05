import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'
import { getDeviceIdFromRequest, markGroupRead } from '@/lib/read-status'
import { deleteFileFromDrive } from '@/lib/drive'

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

function getDriveFileIdFromUrl(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'drive.google.com') return null

    const id = parsed.searchParams.get('id')
    if (id) return id

    const filePathMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/)
    if (filePathMatch?.[1]) return filePathMatch[1]
  } catch {
    return null
  }

  return null
}

function getAttachmentDriveIds(attachments?: Attachment[] | null) {
  const ids = new Set<string>()
  for (const attachment of attachments || []) {
    const id =
      attachment.driveId ||
      (attachment.url ? getDriveFileIdFromUrl(attachment.url) : null) ||
      (attachment.webViewLink ? getDriveFileIdFromUrl(attachment.webViewLink) : null)

    if (id) ids.add(id)
  }

  return [...ids]
}

function canManageMessage(messageUserId: string, userId: string, userRole: string, groupRole?: string | null) {
  return messageUserId === userId || userRole === 'admin' || groupRole === 'admin'
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
  const deviceId = getDeviceIdFromRequest(request)

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

  const [{ data: rawMessages, error: messagesError }, { data: memberRows }, { data: readRows }] = await Promise.all([
    query,
    adminClient
      .from('gw_group_members')
      .select('user_id, role')
      .eq('group_id', groupId),
    adminClient
      .from('gw_read_status')
      .select('user_id, last_read_at')
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

  const messageIds = messages.map(message => message.id)
  const [{ data: users }, { data: reactions }] = await Promise.all([
    userIds.length > 0
      ? adminClient
        .from('gw_users')
        .select('id, display_name, real_name, picture_url, role')
        .in('id', userIds)
      : Promise.resolve({ data: [] }),
    messageIds.length > 0
      ? adminClient
        .from('gw_reactions')
        .select('post_id, emoji, user_id')
        .in('post_id', messageIds)
      : Promise.resolve({ data: [] }),
  ])

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

  const reactionMap: Record<string, Record<string, { count: number; hasOwn: boolean }>> = {}
  for (const reaction of reactions || []) {
    if (!reactionMap[reaction.post_id]) reactionMap[reaction.post_id] = {}
    if (!reactionMap[reaction.post_id][reaction.emoji]) {
      reactionMap[reaction.post_id][reaction.emoji] = { count: 0, hasOwn: false }
    }
    reactionMap[reaction.post_id][reaction.emoji].count++
    if (reaction.user_id === user.id) reactionMap[reaction.post_id][reaction.emoji].hasOwn = true
  }

  // 既読情報: 自分以外のメンバーのlast_read_atを返す
  const readReceipts = (readRows || [])
    .filter(r => r.user_id !== user.id)
    .map(r => ({
      user_id: r.user_id,
      last_read_at: r.last_read_at,
    }))

  markGroupRead(user.id, groupId, deviceId)
    .then(undefined, e => console.error('[Chat read status update error]', e))

  return NextResponse.json({
    group: access.group,
    members,
    currentUser: {
      id: user.id,
      display_name: user.display_name,
      picture_url: user.picture_url,
      role: user.role,
      group_role: access.membership?.role || null,
    },
    messages: messages.map(message => ({
      ...message,
      author: userMap[message.user_id] || { display_name: '不明', picture_url: null },
      isOwn: message.user_id === user.id,
      reactions: reactionMap[message.id] || {},
    })),
    readReceipts,
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

  // DM判定
  const isDirect = typeof access.group?.description === 'string' && access.group.description.startsWith('direct:')

  // プッシュ通知を送信（DM: 相手のみ / グループ: 全メンバー）
  try {
    const [{ sendPushNotificationToUser, sendPushNotificationToGroup }, { findMentionedUsersInGroup, sendMentionNotifications }] = await Promise.all([
      import('@/lib/web-push'),
      import('@/lib/mentions'),
    ])
    const bodyText = content || (attachments.length > 0 ? '\u30d5\u30a1\u30a4\u30eb\u3092\u9001\u4fe1\u3057\u307e\u3057\u305f' : '\u65b0\u3057\u3044\u30e1\u30c3\u30bb\u30fc\u30b8')
    const mentionedUsers = await findMentionedUsersInGroup(groupId, content, user.id)
    const mentionedUserIds = new Set(mentionedUsers.map(mentionedUser => mentionedUser.id))

    if (isDirect) {
      const { data: dmMembers } = await adminClient
        .from('gw_group_members')
        .select('user_id')
        .eq('group_id', groupId)
        .neq('user_id', user.id)

      if (dmMembers && dmMembers.length > 0) {
        for (const m of dmMembers) {
          if (mentionedUserIds.has(m.user_id)) continue
          await sendPushNotificationToUser(m.user_id, {
            title: `${user.display_name || '\u30e1\u30f3\u30d0\u30fc'}`,
            body: bodyText.substring(0, 80),
            url: `/chat/${groupId}`,
            tag: `tsg-dm-${groupId}`,
          })
        }
      }
    } else {
      await sendPushNotificationToGroup(groupId, user.id, {
        title: `${access.group?.name || 'Chat'} - ${user.display_name || '\u30e1\u30f3\u30d0\u30fc'}`,
        body: bodyText.substring(0, 80),
        url: `/chat/${groupId}`,
        tag: `tsg-chat-${groupId}`,
      }, message.id, { excludeUserIds: [...mentionedUserIds] })
    }

    if (mentionedUsers.length > 0) {
      await sendMentionNotifications(mentionedUsers, {
        senderName: user.display_name || '\u30e1\u30f3\u30d0\u30fc',
        groupName: access.group?.name || null,
        content: bodyText,
        url: `/chat/${groupId}`,
        postId: message.id,
      })
    }
  } catch (e) {
    console.error('[Chat push error]', e)
  }

  // TSG君 AI応答（DMの場合のみ、awaitで実行 — Serverless打ち切り防止）
  if (isDirect) {
    try {
      const { isTsgDirectChat, handleTsgAiResponse } = await import('@/lib/tsg-ai')
      const isTsg = await isTsgDirectChat(groupId)
      if (isTsg) {
        await handleTsgAiResponse(groupId, user.id)
        // AI応答後、ユーザーに通知
        const { sendPushNotificationToUser } = await import('@/lib/web-push')
        await sendPushNotificationToUser(user.id, {
          title: 'TSG君',
          body: '返信しました 💬',
          url: `/chat/${groupId}`,
          tag: `tsg-ai-${groupId}`,
        })
      }
    } catch (e) {
      console.error('[TSG AI trigger error]', e)
    }
  }

  return NextResponse.json({
    message: {
      ...message,
      author: {
        id: user.id,
        display_name: user.display_name,
        picture_url: user.picture_url,
      },
      isOwn: true,
      reactions: {},
    },
  }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const messageId = typeof body.message_id === 'string' ? body.message_id : ''
  const content = typeof body.content === 'string' ? body.content.trim() : ''

  if (!messageId) {
    return NextResponse.json({ error: 'message_id が必要です' }, { status: 400 })
  }

  const { data: existing, error: fetchError } = await adminClient
    .from('gw_posts')
    .select('id, group_id, user_id, content, attachments, parent_id')
    .eq('id', messageId)
    .single()

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'メッセージが見つかりません' }, { status: 404 })
  }

  if (existing.parent_id) {
    return NextResponse.json({ error: 'Chatメッセージではありません' }, { status: 400 })
  }

  const access = await getChatAccess(existing.group_id, user.id, user.role)
  if (access.error) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  if (!canManageMessage(existing.user_id, user.id, user.role, access.membership?.role)) {
    return NextResponse.json({ error: '編集権限がありません' }, { status: 403 })
  }

  const attachments = Array.isArray(existing.attachments) ? existing.attachments : []
  if (!content && attachments.length === 0) {
    return NextResponse.json({ error: '本文が必要です' }, { status: 400 })
  }

  const { data: message, error } = await adminClient
    .from('gw_posts')
    .update({
      content: content || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', messageId)
    .select('id, content, updated_at')
    .single()

  if (error || !message) {
    return NextResponse.json({ error: error?.message || '編集に失敗しました' }, { status: 500 })
  }

  return NextResponse.json({ message })
}

export async function DELETE(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const messageId = request.nextUrl.searchParams.get('message_id')
  if (!messageId) {
    return NextResponse.json({ error: 'message_id が必要です' }, { status: 400 })
  }

  const { data: existing, error: fetchError } = await adminClient
    .from('gw_posts')
    .select('id, group_id, user_id, attachments, parent_id')
    .eq('id', messageId)
    .single()

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'メッセージが見つかりません' }, { status: 404 })
  }

  if (existing.parent_id) {
    return NextResponse.json({ error: 'Chatメッセージではありません' }, { status: 400 })
  }

  const access = await getChatAccess(existing.group_id, user.id, user.role)
  if (access.error) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const isDirect = typeof access.group?.description === 'string' && access.group.description.startsWith('direct:')
  if (isDirect) {
    return NextResponse.json({ error: 'DMでは削除できません' }, { status: 403 })
  }

  if (!canManageMessage(existing.user_id, user.id, user.role, access.membership?.role)) {
    return NextResponse.json({ error: '削除権限がありません' }, { status: 403 })
  }

  const driveIds = getAttachmentDriveIds(existing.attachments as Attachment[] | null)
  const deleteResults = await Promise.allSettled(driveIds.map(fileId => deleteFileFromDrive(fileId)))
  const failedDriveIds = deleteResults
    .map((result, index) => ({ result, fileId: driveIds[index] }))
    .filter(({ result }) => result.status === 'rejected')
    .map(({ fileId }) => fileId)

  if (failedDriveIds.length > 0) {
    console.error('[Chat attachment delete errors]', failedDriveIds)
  }

  await adminClient
    .from('gw_reactions')
    .delete()
    .eq('post_id', messageId)

  const { error } = await adminClient
    .from('gw_posts')
    .delete()
    .eq('id', messageId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  adminClient
    .from('gw_groups')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', existing.group_id)
    .then(undefined, e => console.error('[Chat group timestamp update error]', e))

  return NextResponse.json({ ok: true, deletedId: messageId, deletedDriveFileIds: driveIds.filter(id => !failedDriveIds.includes(id)) })
}
