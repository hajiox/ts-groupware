import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'
import { deleteFileFromDrive } from '@/lib/drive'
import { getDeviceIdFromRequest, markGroupRead } from '@/lib/read-status'

/**
 * GET /api/posts?group_id=xxx — 投稿一覧取得
 * POST /api/posts — 新規投稿作成
 */

type Attachment = {
  driveId?: string
  url?: string
  webViewLink?: string
}

type GroupMember = {
  id: string
  display_name: string
  picture_url: string | null
  role: string
  group_role: string
}

async function withTimeout(promise: PromiseLike<unknown>, ms: number, fallback: unknown, label: string): Promise<any> {
  let timer: ReturnType<typeof setTimeout> | null = null

  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<unknown>(resolve => {
        timer = setTimeout(() => {
          console.error(`[Posts API timeout] ${label}`)
          resolve(fallback)
        }, ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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

function getAttachmentDriveIds(posts: { attachments?: Attachment[] | null }[]) {
  const ids = new Set<string>()

  for (const post of posts) {
    for (const attachment of post.attachments || []) {
      const id =
        attachment.driveId ||
        (attachment.url ? getDriveFileIdFromUrl(attachment.url) : null) ||
        (attachment.webViewLink ? getDriveFileIdFromUrl(attachment.webViewLink) : null)

      if (id) ids.add(id)
    }
  }

  return [...ids]
}

function normalizeMentionedUserIds(value: unknown) {
  if (!Array.isArray(value)) return []

  return [...new Set(
    value
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, 50)
  )]
}

async function getGroupAccess(groupId: string, userId: string) {
  const [{ data: group }, { data: membership }] = await Promise.all([
    adminClient
      .from('gw_groups')
      .select('id, name, type')
      .eq('id', groupId)
      .maybeSingle(),
    adminClient
      .from('gw_group_members')
      .select('role')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .maybeSingle(),
  ])

  if (!group) {
    return { group: null, error: 'グループが見つかりません', status: 404 }
  }

  if (!membership) {
    return { group: null, error: 'このグループに参加していません', status: 403 }
  }

  return { group, error: null, status: 0 }
}

async function getGroupMembers(groupId: string): Promise<GroupMember[]> {
  const { data: memberRows, error: memberError } = await adminClient
    .from('gw_group_members')
    .select('user_id, role')
    .eq('group_id', groupId)

  if (memberError || !memberRows?.length) {
    if (memberError) console.error('[Group members fetch error]', memberError.message)
    return []
  }

  const userIds = memberRows.map(member => member.user_id)
  const { data: users, error: usersError } = await adminClient
    .from('gw_users')
    .select('id, display_name, real_name, picture_url, role')
    .in('id', userIds)

  if (usersError || !users?.length) {
    if (usersError) console.error('[Group member users fetch error]', usersError.message)
    return []
  }

  const userById = new Map((users || []).map(memberUser => [
    memberUser.id,
    { ...memberUser, display_name: memberUser.real_name || memberUser.display_name },
  ]))

  return memberRows
    .map(member => {
      const memberUser = userById.get(member.user_id)
      if (!memberUser) return null

      return {
        id: memberUser.id,
        display_name: memberUser.display_name,
        picture_url: memberUser.picture_url,
        role: memberUser.role,
        group_role: member.role,
      }
    })
    .filter((member): member is GroupMember => Boolean(member))
    .sort((a, b) => a.display_name.localeCompare(b.display_name, 'ja'))
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

  const parentOnly = request.nextUrl.searchParams.get('parent_only') !== 'false'
  const parentId = request.nextUrl.searchParams.get('parent_id')
  const limit = parseInt(request.nextUrl.searchParams.get('limit') || '50')
  const deviceId = getDeviceIdFromRequest(request)

  const access = await getGroupAccess(groupId, user.id)
  if (access.error) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const membersPromise = withTimeout(getGroupMembers(groupId), 3000, [], 'group members')

  let query = adminClient
    .from('gw_posts')
    .select('*')
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (parentId) {
    query = query.eq('parent_id', parentId)
  } else if (parentOnly) {
    query = query.is('parent_id', null)
  }

  const [{ data: posts, error }, members] = await Promise.all([
    withTimeout(
      query,
      8000,
      { data: null, error: { message: '投稿取得がタイムアウトしました' } },
      'posts query'
    ),
    membersPromise,
  ])

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!posts?.length) {
    markGroupRead(user.id, groupId, deviceId)
      .then(undefined, e => console.error('[Read status update error]', e))

    return NextResponse.json({ posts: [], groupName: access.group?.name || null, members })
  }

  // ユーザー情報を取得
  const userIds = [...new Set((posts || []).map((post: { user_id: string }) => post.user_id))]
  const postIds = (posts || []).map((post: { id: string }) => post.id)
  const [{ data: users }, { data: reactions }, { data: commentCounts }] = await Promise.all([
    withTimeout(adminClient
      .from('gw_users')
      .select('id, display_name, real_name, picture_url')
      .in('id', userIds), 3000, { data: [], error: null }, 'post authors'),
    withTimeout(adminClient
      .from('gw_reactions')
      .select('post_id, emoji, user_id')
      .in('post_id', postIds), 3000, { data: [], error: null }, 'post reactions'),
    withTimeout(adminClient
      .from('gw_posts')
      .select('parent_id')
      .in('parent_id', postIds), 3000, { data: [], error: null }, 'comment counts'),
  ])

  const userMap = Object.fromEntries((users || []).map((u: { id: string; display_name: string; real_name?: string | null; picture_url: string | null }) => [
    u.id, 
    { ...u, display_name: u.real_name || u.display_name }
  ]))

  // リアクション集計
  const reactionMap: Record<string, Record<string, { count: number; hasOwn: boolean }>> = {}
  for (const r of reactions || []) {
    if (!reactionMap[r.post_id]) reactionMap[r.post_id] = {}
    if (!reactionMap[r.post_id][r.emoji]) reactionMap[r.post_id][r.emoji] = { count: 0, hasOwn: false }
    reactionMap[r.post_id][r.emoji].count++
    if (r.user_id === user.id) reactionMap[r.post_id][r.emoji].hasOwn = true
  }

  // コメント数集計
  const commentCountMap: Record<string, number> = {}
  for (const c of commentCounts || []) {
    if (c.parent_id) {
      commentCountMap[c.parent_id] = (commentCountMap[c.parent_id] || 0) + 1
    }
  }

  markGroupRead(user.id, groupId, deviceId)
    .then(undefined, e => console.error('[Read status update error]', e))

  const enrichedPosts = (posts || []).map((post: { id: string; user_id: string }) => ({
    ...post,
    author: userMap[post.user_id] || { display_name: '不明', picture_url: null },
    reactions: reactionMap[post.id] || {},
    commentCount: commentCountMap[post.id] || 0,
  }))

  return NextResponse.json({ posts: enrichedPosts, groupName: access.group?.name || null, members })
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json()
  const { group_id, content, attachments, parent_id, mentioned_user_ids } = body

  if (!group_id) {
    return NextResponse.json({ error: 'group_id が必要です' }, { status: 400 })
  }
  if (!content?.trim() && (!attachments || attachments.length === 0)) {
    return NextResponse.json({ error: '内容が必要です' }, { status: 400 })
  }

  const access = await getGroupAccess(group_id, user.id)
  if (access.error) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const groupMembers = await getGroupMembers(group_id)
  const requestedMentionIds = new Set(normalizeMentionedUserIds(mentioned_user_ids))
  const mentionedMembers = groupMembers.filter(member => (
    member.id !== user.id && requestedMentionIds.has(member.id)
  ))
  const mentionedUserIds = mentionedMembers.map(member => member.id)

  const { data: post, error } = await adminClient
    .from('gw_posts')
    .insert({
      group_id,
      user_id: user.id,
      content: content?.trim() || null,
      attachments: attachments || [],
      parent_id: parent_id || null,
    })
    .select()
    .single()

  if (error || !post) {
    return NextResponse.json({ error: error?.message || '投稿失敗' }, { status: 500 })
  }

  const [{ data: group }] = await Promise.all([
    adminClient
      .from('gw_groups')
      .select('name')
      .eq('id', group_id)
      .single(),
    adminClient
      .from('gw_groups')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', group_id),
  ])

  void import('@/lib/web-push')
    .then(async ({ sendPushNotificationToGroup, sendPushNotificationToUser }) => {
      const authorName = user.display_name || 'メンバー'
      const messageBody = content?.trim() ? content.trim().substring(0, 50) : 'ファイルを送信しました'
      const postNotificationId = post.parent_id || post.id
      const url = `/board/${group_id}`

      await sendPushNotificationToGroup(group_id, user.id, {
        title: group?.name ? `${group.name} - ${authorName}` : authorName,
        body: messageBody,
        url,
      }, postNotificationId, { excludeUserIds: mentionedUserIds })

      await Promise.all(mentionedMembers.map(member => (
        sendPushNotificationToUser(member.id, {
          title: parent_id
            ? `${authorName} さんがコメントであなたをメンションしました`
            : `${authorName} さんがあなたをメンションしました`,
          body: messageBody,
          url,
          tag: `tsg-mention-${post.id}-${member.id}`,
        }, postNotificationId, { ignorePostMute: true })
      )))
    })
    .catch(e => console.error('[Push Error]', e))

  return NextResponse.json({
    post: {
      ...post,
      author: {
        id: user.id,
        display_name: user.display_name,
        picture_url: user.picture_url,
      },
      reactions: {},
      commentCount: 0,
    },
  }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json()
  const { post_id, content } = body
  const trimmedContent = typeof content === 'string' ? content.trim() : ''

  if (!post_id) {
    return NextResponse.json({ error: 'post_id が必要です' }, { status: 400 })
  }

  const { data: existing, error: fetchError } = await adminClient
    .from('gw_posts')
    .select('id, user_id, group_id, content, attachments, parent_id')
    .eq('id', post_id)
    .single()

  if (fetchError || !existing) {
    return NextResponse.json({ error: '投稿が見つかりません' }, { status: 404 })
  }

  if (existing.user_id !== user.id) {
    return NextResponse.json({ error: '自分の投稿のみ編集できます' }, { status: 403 })
  }

  const access = await getGroupAccess(existing.group_id, user.id)
  if (access.error) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  if (!trimmedContent && (!existing.attachments || existing.attachments.length === 0)) {
    return NextResponse.json({ error: '内容が必要です' }, { status: 400 })
  }

  const { data: post, error } = await adminClient
    .from('gw_posts')
    .update({
      content: trimmedContent || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', post_id)
    .select()
    .single()

  if (error || !post) {
    return NextResponse.json({ error: error?.message || '投稿の更新に失敗しました' }, { status: 500 })
  }


  return NextResponse.json({ post })
}

export async function DELETE(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const postId = request.nextUrl.searchParams.get('post_id')
  if (!postId) {
    return NextResponse.json({ error: 'post_id が必要です' }, { status: 400 })
  }

  const { data: post, error: fetchError } = await adminClient
    .from('gw_posts')
    .select('id, user_id, group_id, content, attachments, parent_id')
    .eq('id', postId)
    .single()

  if (fetchError || !post) {
    return NextResponse.json({ error: '投稿が見つかりません' }, { status: 404 })
  }

  if (post.user_id !== user.id && user.role !== 'admin') {
    return NextResponse.json({ error: '削除権限がありません' }, { status: 403 })
  }

  const access = await getGroupAccess(post.group_id, user.id)
  if (access.error) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const { data: comments } = await adminClient
    .from('gw_posts')
    .select('id, attachments')
    .eq('parent_id', postId)

  const postIds = [postId, ...(comments || []).map(comment => comment.id)]
  const attachmentDriveIds = getAttachmentDriveIds([post, ...(comments || [])])
  const attachmentDeleteResults = await Promise.allSettled(
    attachmentDriveIds.map(fileId => deleteFileFromDrive(fileId))
  )
  const failedAttachmentDeletes = attachmentDeleteResults
    .map((result, index) => ({ result, fileId: attachmentDriveIds[index] }))
    .filter(({ result }) => result.status === 'rejected')
    .map(({ result, fileId }) => ({
      fileId,
      error: result.status === 'rejected' && result.reason instanceof Error
        ? result.reason.message
        : 'Drive file delete failed',
    }))

  if (failedAttachmentDeletes.length > 0) {
    console.error('[Drive attachment delete errors]', failedAttachmentDeletes)
  }

  await adminClient
    .from('gw_reactions')
    .delete()
    .in('post_id', postIds)

  const { error } = await adminClient
    .from('gw_posts')
    .delete()
    .in('id', postIds)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  adminClient
    .from('gw_groups')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', post.group_id)
    .then(undefined, e => console.error('[Group timestamp update error]', e))


  return NextResponse.json({
    ok: true,
    deletedIds: postIds,
    deletedDriveFileIds: attachmentDriveIds.filter(fileId => (
      !failedAttachmentDeletes.some(failure => failure.fileId === fileId)
    )),
    attachmentDeleteErrors: failedAttachmentDeletes,
  })
}
