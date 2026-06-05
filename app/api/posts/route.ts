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

type TaskRow = {
  id: string
  post_id: string
  group_id: string
  requester_id: string
  assignee_id: string
  due_date: string
  completed_at: string | null
  completed_by: string | null
  created_at: string
}

type UserSummary = {
  id: string
  display_name: string
  real_name?: string | null
  picture_url?: string | null
}

function normalizeTaskRequest(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const task = value as { assignee_ids?: unknown; due_date?: unknown }
  const assigneeIds = Array.isArray(task.assignee_ids)
    ? [...new Set(task.assignee_ids.filter((id): id is string => typeof id === 'string' && id.trim()).map(id => id.trim()))]
    : []
  const dueDate = typeof task.due_date === 'string' ? task.due_date.trim() : ''
  if (assigneeIds.length === 0 && !dueDate) return null
  return { assigneeIds, dueDate }
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime())
}

function displayName(user?: UserSummary | null) {
  return user?.real_name || user?.display_name || '不明'
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

  const { data: posts, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!posts?.length) {
    markGroupRead(user.id, groupId, deviceId)
      .then(undefined, e => console.error('[Read status update error]', e))

    return NextResponse.json({ posts: [] })
  }

  // ユーザー情報を取得
  const postIds = (posts || []).map(p => p.id)
  const { data: tasks } = await adminClient
    .from('gw_tasks')
    .select('*')
    .in('post_id', postIds)
    .order('due_date', { ascending: true })
    .order('created_at', { ascending: true })

  const taskRows = (tasks || []) as TaskRow[]
  const userIds = [...new Set([
    ...(posts || []).map(p => p.user_id),
    ...taskRows.flatMap(task => [task.requester_id, task.assignee_id, task.completed_by].filter(Boolean) as string[]),
  ])]
  const [{ data: users }, { data: reactions }, { data: commentCounts }] = await Promise.all([
    adminClient
      .from('gw_users')
      .select('id, display_name, real_name, picture_url')
      .in('id', userIds),
    adminClient
      .from('gw_reactions')
      .select('post_id, emoji, user_id')
      .in('post_id', postIds),
    adminClient
      .from('gw_posts')
      .select('parent_id')
      .in('parent_id', postIds),
  ])

  const userMap = Object.fromEntries(((users || []) as UserSummary[]).map(u => [
    u.id, 
    { ...u, display_name: displayName(u) }
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

  const taskMap: Record<string, unknown[]> = {}
  for (const task of taskRows) {
    if (!taskMap[task.post_id]) taskMap[task.post_id] = []
    taskMap[task.post_id].push({
      id: task.id,
      post_id: task.post_id,
      group_id: task.group_id,
      requester_id: task.requester_id,
      assignee_id: task.assignee_id,
      due_date: task.due_date,
      completed_at: task.completed_at,
      completed_by: task.completed_by,
      created_at: task.created_at,
      requester: userMap[task.requester_id] || null,
      assignee: userMap[task.assignee_id] || null,
      completedBy: task.completed_by ? userMap[task.completed_by] || null : null,
    })
  }

  // 既読更新 + グループ名取得を並列
  const [, { data: groupInfo }] = await Promise.all([
    markGroupRead(user.id, groupId, deviceId),
    adminClient
      .from('gw_groups')
      .select('name')
      .eq('id', groupId)
      .single(),
  ])

  const enrichedPosts = (posts || []).map(post => ({
    ...post,
    author: userMap[post.user_id] || { display_name: '不明', picture_url: null },
    reactions: reactionMap[post.id] || {},
    commentCount: commentCountMap[post.id] || 0,
    tasks: taskMap[post.id] || [],
  }))

  return NextResponse.json({ posts: enrichedPosts, groupName: groupInfo?.name || null })
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json()
  const { group_id, content, attachments, parent_id } = body
  const trimmedContent = typeof content === 'string' ? content.trim() : ''
  const taskRequest = normalizeTaskRequest(body.task)

  if (!group_id) {
    return NextResponse.json({ error: 'group_id が必要です' }, { status: 400 })
  }
  if (!trimmedContent && (!attachments || attachments.length === 0)) {
    return NextResponse.json({ error: '内容が必要です' }, { status: 400 })
  }
  if (taskRequest) {
    if (parent_id) {
      return NextResponse.json({ error: 'タスク依頼は通常投稿で作成してください' }, { status: 400 })
    }
    if (taskRequest.assigneeIds.length === 0) {
      return NextResponse.json({ error: 'タスク担当者を選択してください' }, { status: 400 })
    }
    if (!isIsoDate(taskRequest.dueDate)) {
      return NextResponse.json({ error: 'タスク期限を選択してください' }, { status: 400 })
    }

    const { data: members } = await adminClient
      .from('gw_group_members')
      .select('user_id')
      .eq('group_id', group_id)
      .in('user_id', taskRequest.assigneeIds)

    const allowedIds = new Set((members || []).map(member => member.user_id))
    if (user.role === 'admin' && taskRequest.assigneeIds.includes(user.id)) {
      allowedIds.add(user.id)
    }

    const invalidAssignee = taskRequest.assigneeIds.some(assigneeId => !allowedIds.has(assigneeId))
    if (invalidAssignee) {
      return NextResponse.json({ error: 'タスク担当者にグループ外のメンバーが含まれています' }, { status: 400 })
    }
  }

  const { data: post, error } = await adminClient
    .from('gw_posts')
    .insert({
      group_id,
      user_id: user.id,
      content: trimmedContent || null,
      attachments: attachments || [],
      parent_id: parent_id || null,
    })
    .select()
    .single()

  if (error || !post) {
    return NextResponse.json({ error: error?.message || '投稿失敗' }, { status: 500 })
  }

  let createdTasks: unknown[] = []
  if (taskRequest) {
    const rows = taskRequest.assigneeIds.map(assigneeId => ({
      post_id: post.id,
      group_id,
      requester_id: user.id,
      assignee_id: assigneeId,
      due_date: taskRequest.dueDate,
    }))
    const { data: taskRows, error: taskError } = await adminClient
      .from('gw_tasks')
      .insert(rows)
      .select('*')

    if (taskError) {
      await adminClient.from('gw_posts').delete().eq('id', post.id)
      return NextResponse.json({ error: taskError.message || 'タスク依頼の作成に失敗しました' }, { status: 500 })
    }

    const assigneeUsers = taskRequest.assigneeIds.length > 0
      ? await adminClient
        .from('gw_users')
        .select('id, display_name, real_name, picture_url')
        .in('id', taskRequest.assigneeIds)
      : { data: [] }
    const assigneeMap = Object.fromEntries(((assigneeUsers.data || []) as UserSummary[]).map(assignee => [
      assignee.id,
      { ...assignee, display_name: displayName(assignee) },
    ]))

    createdTasks = ((taskRows || []) as TaskRow[]).map(task => ({
      ...task,
      requester: {
        id: user.id,
        display_name: user.display_name,
        picture_url: user.picture_url,
      },
      assignee: assigneeMap[task.assignee_id] || null,
      completedBy: null,
    }))
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

  try {
    const [{ sendPushNotificationToGroup }, { findMentionedUsersInGroup, sendMentionNotifications }] = await Promise.all([
      import('@/lib/web-push'),
      import('@/lib/mentions'),
    ])
    const authorName = user.display_name || '\u30e1\u30f3\u30d0\u30fc'
    const messageBody = trimmedContent ? trimmedContent.substring(0, 50) : '\u30d5\u30a1\u30a4\u30eb\u3092\u9001\u4fe1\u3057\u307e\u3057\u305f'
    const mutePostId = post.parent_id || post.id
    const mentionedUsers = await findMentionedUsersInGroup(group_id, trimmedContent, user.id)
    const mentionedUserIds = mentionedUsers.map(mentionedUser => mentionedUser.id)
    const url = `/board/${group_id}#post-${mutePostId}`

    const notificationJobs: Promise<unknown>[] = [
      sendPushNotificationToGroup(group_id, user.id, {
        title: group?.name ? `${group.name} - ${authorName}` : authorName,
        body: messageBody,
        url,
      }, mutePostId, { excludeUserIds: mentionedUserIds }),
    ]

    if (mentionedUsers.length > 0) {
      notificationJobs.push(sendMentionNotifications(mentionedUsers, {
        senderName: authorName,
        groupName: group?.name || null,
        content: trimmedContent || messageBody,
        url,
        postId: post.id,
        mutePostId,
      }))
    }

    await Promise.allSettled(notificationJobs)
  } catch (e) {
    console.error('[Push Error]', e)
  }

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
      tasks: createdTasks,
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
