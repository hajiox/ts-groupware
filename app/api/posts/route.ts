import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'
import { deleteFileFromDrive } from '@/lib/drive'
import { markGroupRead } from '@/lib/read-status'
import { normalizeMentionContent } from '@/lib/mention-names'
import { isManagementUser } from '@/lib/user-roles'

/**
 * GET /api/posts?group_id=xxx — 投稿一覧取得
 * POST /api/posts — 新規投稿作成
 */

type Attachment = {
  driveId?: string
  url?: string
  viewUrl?: string
  name?: string
  type?: string
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
  canceled_at?: string | null
  canceled_by?: string | null
  cancel_reason?: string | null
  created_at: string
}

type UserSummary = {
  id: string
  display_name: string
  real_name?: string | null
  picture_url?: string | null
}

type ParentPostSummary = {
  id: string
  group_id: string
  parent_id: string | null
}

type ReplyTargetSummary = ParentPostSummary & {
  user_id: string
}

type PostRow = {
  id: string
  group_id: string
  user_id: string
  content: string | null
  attachments?: Attachment[] | null
  parent_id: string | null
  reply_to_id?: string | null
  created_at: string
  is_pinned?: boolean
}

type GroupPostingPolicy = {
  postingDisabled: boolean
  message: string | null
}

async function loadGroupPostingPolicy(groupId: string): Promise<GroupPostingPolicy> {
  const { data, error } = await adminClient
    .from('gw_groups')
    .select('posting_disabled, posting_disabled_message')
    .eq('id', groupId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('掲示板が見つかりません')

  return {
    postingDisabled: Boolean(data.posting_disabled),
    message: typeof data.posting_disabled_message === 'string' && data.posting_disabled_message.trim()
      ? data.posting_disabled_message.trim()
      : null,
  }
}

function postingDisabledResponse(policy: GroupPostingPolicy) {
  return NextResponse.json({
    error: policy.message || 'この掲示板は閲覧専用です',
  }, { status: 403 })
}

async function hasGroupMembership(groupId: string, userId: string) {
  const { data, error } = await adminClient
    .from('gw_group_members')
    .select('user_id')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return Boolean(data)
}

function normalizeTaskRequest(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const task = value as { assignee_ids?: unknown; due_date?: unknown }
  const assigneeIds = Array.isArray(task.assignee_ids)
    ? [...new Set(task.assignee_ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map(id => id.trim()))]
    : []
  const dueDate = typeof task.due_date === 'string' ? task.due_date.trim() : ''
  if (assigneeIds.length === 0 && !dueDate) return null
  return { assigneeIds, dueDate }
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime())
}

function normalizeAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return []

  return value
    .filter((item): item is Attachment => item && typeof item === 'object')
    .map(item => ({
      url: typeof item.url === 'string' ? item.url : '',
      viewUrl: typeof item.viewUrl === 'string' ? item.viewUrl : undefined,
      name: typeof item.name === 'string' ? item.name : 'attachment',
      type: typeof item.type === 'string' ? item.type : 'application/octet-stream',
      driveId: typeof item.driveId === 'string' ? item.driveId : undefined,
      webViewLink: typeof item.webViewLink === 'string' ? item.webViewLink : undefined,
    }))
    .filter(item => item.url || item.viewUrl)
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

async function validateTaskAssignees(
  groupId: string,
  assigneeIds: string[],
  user: { id: string; role?: string | null },
) {
  const { data: members } = await adminClient
    .from('gw_group_members')
    .select('user_id')
    .eq('group_id', groupId)
    .in('user_id', assigneeIds)

  const allowedIds = new Set((members || []).map(member => member.user_id))
  if (isManagementUser(user) && assigneeIds.includes(user.id)) {
    allowedIds.add(user.id)
  }

  return assigneeIds.every(assigneeId => allowedIds.has(assigneeId))
}

async function enrichTaskRows(taskRows: TaskRow[]) {
  if (taskRows.length === 0) return []

  const userIds = [...new Set(taskRows.flatMap(task => [
    task.requester_id,
    task.assignee_id,
    task.completed_by,
  ].filter(Boolean) as string[]))]

  const { data: users } = await adminClient
    .from('gw_users')
    .select('id, display_name, real_name, picture_url')
    .in('id', userIds)

  const userMap = Object.fromEntries(((users || []) as UserSummary[]).map(user => [
    user.id,
    { ...user, display_name: displayName(user) },
  ]))

  return taskRows.map(task => ({
    ...task,
    requester: userMap[task.requester_id] || null,
    assignee: userMap[task.assignee_id] || null,
    completedBy: task.completed_by ? userMap[task.completed_by] || null : null,
  }))
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

  try {
    if (!await hasGroupMembership(groupId, user.id)) {
      return NextResponse.json({ error: 'この掲示板に参加していません' }, { status: 403 })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '所属確認に失敗しました'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const parentOnly = request.nextUrl.searchParams.get('parent_only') !== 'false'
  const parentId = request.nextUrl.searchParams.get('parent_id')
  const requestedLimit = parseInt(request.nextUrl.searchParams.get('limit') || '50', 10)
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50
  const before = request.nextUrl.searchParams.get('before')
  const isParentTimelineRequest = !parentId && parentOnly
  let fetchedPosts: PostRow[] = []
  let hasMore = false
  let error: { message: string } | null = null

  if (isParentTimelineRequest) {
    const pinnedResult = before
      ? { data: [], error: null }
      : await adminClient
        .from('gw_posts')
        .select('*')
        .eq('group_id', groupId)
        .is('parent_id', null)
        .eq('is_pinned', true)
        .order('created_at', { ascending: false })
        .limit(50)

    let regularQuery = adminClient
      .from('gw_posts')
      .select('*')
      .eq('group_id', groupId)
      .is('parent_id', null)
      .eq('is_pinned', false)
      .order('created_at', { ascending: false })
      .limit(limit + 1)

    if (before) {
      regularQuery = regularQuery.lt('created_at', before)
    }

    const regularResult = await regularQuery
    error = pinnedResult.error || regularResult.error
    hasMore = (regularResult.data || []).length > limit
    fetchedPosts = [
      ...((pinnedResult.data || []) as PostRow[]),
      ...((regularResult.data || []).slice(0, limit) as PostRow[]),
    ]
  } else {
    let query = adminClient
      .from('gw_posts')
      .select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(limit + 1)

    if (parentId) {
      query = query.eq('parent_id', parentId)
    } else if (parentOnly) {
      query = query.is('parent_id', null)
    }
    if (before) {
      query = query.lt('created_at', before)
    }

    const result = await query
    error = result.error
    hasMore = (result.data || []).length > limit
    fetchedPosts = (result.data || []).slice(0, limit) as PostRow[]
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const posts = fetchedPosts

  if (!posts?.length) {
    markGroupRead(user.id, groupId)
      .then(result => {
        if (result.error) console.error('[Read status update error]', result.error)
      }, e => console.error('[Read status update error]', e))

    return NextResponse.json({ posts: [], hasMore: false })
  }

  // ユーザー情報を取得
  const postIds = (posts || []).map(p => p.id)
  const [tasksResult, commentRowsResult, readRowsResult] = await Promise.all([
    adminClient
      .from('gw_tasks')
      .select('*')
      .in('post_id', postIds)
      .is('canceled_at', null)
      .order('due_date', { ascending: true })
      .order('created_at', { ascending: true }),
    isParentTimelineRequest
      ? adminClient
        .from('gw_posts')
        .select('*')
        .in('parent_id', postIds)
        .order('created_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    adminClient
      .from('gw_read_status')
      .select('user_id, last_read_at')
      .eq('group_id', groupId),
  ])
  if (tasksResult.error || commentRowsResult.error || readRowsResult.error) {
    return NextResponse.json({ error: tasksResult.error?.message || commentRowsResult.error?.message || readRowsResult.error?.message }, { status: 500 })
  }

  const taskRows = (tasksResult.data || []) as TaskRow[]
  const commentRows = (commentRowsResult.data || []) as PostRow[]
  const commentCountMap: Record<string, number> = {}
  const commentPreviewMap: Record<string, PostRow[]> = {}
  for (const comment of commentRows) {
    if (!comment.parent_id) continue
    commentCountMap[comment.parent_id] = (commentCountMap[comment.parent_id] || 0) + 1
    const preview = commentPreviewMap[comment.parent_id] || []
    if (preview.length < 5) preview.push(comment)
    commentPreviewMap[comment.parent_id] = preview
  }
  for (const preview of Object.values(commentPreviewMap)) preview.reverse()

  const commentPreviewRows = Object.values(commentPreviewMap).flat()
  const commentPreviewIds = commentPreviewRows.map(comment => comment.id)
  const readRows = readRowsResult.data || []
  const userIds = [...new Set([
    ...(posts || []).map(p => p.user_id),
    ...commentRows.map(comment => comment.user_id),
    ...commentPreviewRows.map(comment => comment.user_id),
    ...taskRows.flatMap(task => [task.requester_id, task.assignee_id, task.completed_by].filter(Boolean) as string[]),
    ...readRows.map(receipt => receipt.user_id),
  ])]
  const [{ data: users }, { data: reactions }] = await Promise.all([
    adminClient
      .from('gw_users')
      .select('id, display_name, real_name, picture_url')
      .in('id', userIds),
    adminClient
      .from('gw_reactions')
      .select('post_id, emoji, user_id')
      .in('post_id', [...postIds, ...commentPreviewIds]),
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

  const readReceipts = readRows
    .filter(receipt => receipt.user_id !== user.id)
    .map(receipt => {
      const reader = userMap[receipt.user_id]
      return {
        user_id: receipt.user_id,
        last_read_at: receipt.last_read_at,
        display_name: reader?.display_name || 'メンバー',
        picture_url: reader?.picture_url || null,
      }
    })

  // 既読更新 + グループ名取得を並列
  const [readResult, { data: groupInfo }] = await Promise.all([
    markGroupRead(user.id, groupId),
    adminClient
      .from('gw_groups')
      .select('name, posting_disabled, posting_disabled_message')
      .eq('id', groupId)
      .single(),
  ])
  if (readResult.error) {
    console.error('[Read status update error]', readResult.error)
  }

  const availablePostMap = new Map<string, PostRow>([
    ...(posts || []).map(post => [post.id, post] as const),
    ...commentRows.map(comment => [comment.id, comment] as const),
  ])
  const enrichPost = (post: PostRow) => {
    const replyTarget = post.reply_to_id ? availablePostMap.get(post.reply_to_id) : null
    const replyTargetAuthor = replyTarget ? userMap[replyTarget.user_id] : null

    return {
      ...post,
      author: userMap[post.user_id] || { display_name: '不明', picture_url: null },
      reactions: reactionMap[post.id] || {},
      commentCount: commentCountMap[post.id] || 0,
      tasks: taskMap[post.id] || [],
      reply_to: replyTarget
        ? {
            id: replyTarget.id,
            display_name: replyTargetAuthor?.display_name || 'メンバー',
          }
        : null,
    }
  }
  const enrichedPosts = (posts || []).map(post => ({
    ...enrichPost(post),
    commentPreview: (commentPreviewMap[post.id] || []).map(enrichPost),
  }))

  return NextResponse.json({
    posts: enrichedPosts,
    groupName: groupInfo?.name || null,
    postingDisabled: Boolean(groupInfo?.posting_disabled),
    postingDisabledMessage: groupInfo?.posting_disabled_message || null,
    hasMore,
    readReceipts,
  })
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json()
  const { group_id, content, attachments, parent_id, reply_to_id } = body
  const trimmedContent = typeof content === 'string' ? normalizeMentionContent(content.trim()) : ''
  const parentPostId = typeof parent_id === 'string' ? parent_id.trim() : ''
  const replyToId = typeof reply_to_id === 'string' ? reply_to_id.trim() : ''
  const taskRequest = normalizeTaskRequest(body.task)

  if (!group_id) {
    return NextResponse.json({ error: 'group_id が必要です' }, { status: 400 })
  }
  let postingPolicy: GroupPostingPolicy
  try {
    if (!await hasGroupMembership(group_id, user.id)) {
      return NextResponse.json({ error: 'この掲示板に参加していません' }, { status: 403 })
    }
    postingPolicy = await loadGroupPostingPolicy(group_id)
  } catch (error) {
    const message = error instanceof Error ? error.message : '所属確認に失敗しました'
    return NextResponse.json({ error: message }, { status: 500 })
  }
  if (postingPolicy.postingDisabled) return postingDisabledResponse(postingPolicy)
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

    const assigneesAreValid = await validateTaskAssignees(group_id, taskRequest.assigneeIds, user)
    if (!assigneesAreValid) {
      return NextResponse.json({ error: 'タスク担当者にグループ外のメンバーが含まれています' }, { status: 400 })
    }
  }

  let parentPost: ParentPostSummary | null = null
  let replyTarget: ReplyTargetSummary | null = null
  let replyTargetAuthor: UserSummary | null = null
  if (parentPostId) {
    const { data: fetchedParentPost, error: parentError } = await adminClient
      .from('gw_posts')
      .select('id, group_id, parent_id')
      .eq('id', parentPostId)
      .single()

    if (parentError || !fetchedParentPost) {
      return NextResponse.json({ error: 'コメント先の投稿が見つかりません' }, { status: 404 })
    }

    if (fetchedParentPost.group_id !== group_id) {
      return NextResponse.json({ error: 'コメント先の投稿がグループと一致しません' }, { status: 400 })
    }

    if (fetchedParentPost.parent_id) {
      return NextResponse.json({ error: 'コメントへの返信は作成できません' }, { status: 400 })
    }

    parentPost = fetchedParentPost as ParentPostSummary

    if (replyToId) {
      const { data: fetchedReplyTarget, error: replyTargetError } = await adminClient
        .from('gw_posts')
        .select('id, group_id, parent_id, user_id')
        .eq('id', replyToId)
        .single()

      if (replyTargetError || !fetchedReplyTarget) {
        return NextResponse.json({ error: '返信先のコメントが見つかりません' }, { status: 404 })
      }
      if (fetchedReplyTarget.group_id !== group_id || fetchedReplyTarget.parent_id !== parentPost.id) {
        return NextResponse.json({ error: '返信先のコメントが投稿と一致しません' }, { status: 400 })
      }

      replyTarget = fetchedReplyTarget as ReplyTargetSummary
      const { data: fetchedReplyTargetAuthor } = await adminClient
        .from('gw_users')
        .select('id, display_name, real_name, picture_url')
        .eq('id', replyTarget.user_id)
        .maybeSingle()
      replyTargetAuthor = fetchedReplyTargetAuthor as UserSummary | null
    }
  } else if (replyToId) {
    return NextResponse.json({ error: '返信先には元投稿の指定が必要です' }, { status: 400 })
  }

  const { data: post, error } = await adminClient
    .from('gw_posts')
    .insert({
      group_id,
      user_id: user.id,
      content: trimmedContent || null,
      attachments: attachments || [],
      parent_id: parentPost?.id || null,
      reply_to_id: replyTarget?.id || null,
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
    const [{ sendPushNotificationToGroup, sendPushNotificationToUser }, { findMentionedUsersInGroup, sendMentionNotifications }] = await Promise.all([
      import('@/lib/web-push'),
      import('@/lib/mentions'),
    ])
    const authorName = user.display_name || '\u30e1\u30f3\u30d0\u30fc'
    const messageBody = trimmedContent ? trimmedContent.substring(0, 50) : '\u30d5\u30a1\u30a4\u30eb\u3092\u9001\u4fe1\u3057\u307e\u3057\u305f'
    const mutePostId = post.parent_id || post.id
    const isComment = Boolean(post.parent_id)
    const mentionedUsers = await findMentionedUsersInGroup(group_id, trimmedContent, user.id)
    const mentionedUserIds = mentionedUsers.map(mentionedUser => mentionedUser.id)
    const url = `/board/${group_id}#post-${mutePostId}`
    const notificationTitle = replyTarget
      ? (group?.name ? `${group.name} - コメントへの返信` : 'コメントへの返信')
      : isComment
      ? (group?.name ? `${group.name} - 新しいコメント` : '新しいコメント')
      : (group?.name ? `${group.name} - ${authorName}` : authorName)
    const notificationBody = isComment ? `${authorName}: ${messageBody}` : messageBody

    const replyTargetUserId = replyTarget?.user_id && replyTarget.user_id !== user.id
      ? replyTarget.user_id
      : null
    const groupExcludedUserIds = [
      ...mentionedUserIds,
      ...(replyTargetUserId ? [replyTargetUserId] : []),
    ]
    const notificationJobs: Promise<unknown>[] = [
      sendPushNotificationToGroup(group_id, user.id, {
        title: notificationTitle,
        body: notificationBody,
        url,
        tag: isComment ? `tsg-comment-${post.id}` : undefined,
      }, mutePostId, { excludeUserIds: groupExcludedUserIds }),
    ]

    if (replyTargetUserId && !mentionedUserIds.includes(replyTargetUserId)) {
      notificationJobs.push(sendPushNotificationToUser(replyTargetUserId, {
        title: notificationTitle,
        body: notificationBody,
        url,
        tag: `tsg-reply-${post.id}`,
      }, mutePostId))
    }

    if (mentionedUsers.length > 0) {
      notificationJobs.push(sendMentionNotifications(mentionedUsers, {
        senderId: user.id,
        senderName: authorName,
        groupId: group_id,
        groupName: group?.name || null,
        contextType: 'board',
        contextLabel: '掲示板',
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
      reply_to: replyTarget
        ? {
            id: replyTarget.id,
            display_name: displayName(replyTargetAuthor),
          }
        : null,
    },
  }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json()
  const { post_id, content, action } = body
  const trimmedContent = typeof content === 'string' ? normalizeMentionContent(content.trim()) : ''
  const attachmentsEditRequested = Object.prototype.hasOwnProperty.call(body, 'attachments')
  const requestedAttachments = attachmentsEditRequested ? normalizeAttachments(body.attachments) : null
  const taskEditRequested = Object.prototype.hasOwnProperty.call(body, 'task')
  const taskRequest = taskEditRequested ? normalizeTaskRequest(body.task) : null

  if (!post_id) {
    return NextResponse.json({ error: 'post_id が必要です' }, { status: 400 })
  }

  const { data: existing, error: fetchError } = await adminClient
    .from('gw_posts')
    .select('id, user_id, group_id, content, attachments, parent_id, is_pinned')
    .eq('id', post_id)
    .single()

  if (fetchError || !existing) {
    return NextResponse.json({ error: '投稿が見つかりません' }, { status: 404 })
  }

  let postingPolicy: GroupPostingPolicy
  try {
    if (!await hasGroupMembership(existing.group_id, user.id)) {
      return NextResponse.json({ error: 'この掲示板に参加していません' }, { status: 403 })
    }
    postingPolicy = await loadGroupPostingPolicy(existing.group_id)
  } catch (error) {
    const message = error instanceof Error ? error.message : '所属確認に失敗しました'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  if (action === 'pin') {
    if (existing.parent_id) {
      return NextResponse.json({ error: 'コメントは固定できません' }, { status: 400 })
    }
    if (!isManagementUser(user)) {
      return NextResponse.json({ error: '固定操作は役員または管理者のみ実行できます' }, { status: 403 })
    }

    const nextPinned = Boolean(body.is_pinned)
    const { data: post, error } = await adminClient
      .from('gw_posts')
      .update({
        is_pinned: nextPinned,
        updated_at: new Date().toISOString(),
      })
      .eq('id', post_id)
      .select()
      .single()

    if (error || !post) {
      return NextResponse.json({ error: error?.message || '固定状態の更新に失敗しました' }, { status: 500 })
    }

    adminClient
      .from('gw_groups')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', existing.group_id)
      .then(undefined, e => console.error('[Group timestamp update error]', e))

    return NextResponse.json({ post })
  }

  if (postingPolicy.postingDisabled) return postingDisabledResponse(postingPolicy)

  if (action === 'attachments') {
    if (!attachmentsEditRequested) {
      return NextResponse.json({ error: 'attachments is required' }, { status: 400 })
    }

    const canUpdateAttachments = existing.user_id === user.id || isManagementUser(user)
    if (!canUpdateAttachments) {
      return NextResponse.json({ error: 'Attachment update is not allowed' }, { status: 403 })
    }

    if (!existing.content && (!requestedAttachments || requestedAttachments.length === 0)) {
      return NextResponse.json({ error: 'Content or attachment is required' }, { status: 400 })
    }

    const { data: post, error } = await adminClient
      .from('gw_posts')
      .update({
        attachments: requestedAttachments || [],
        updated_at: new Date().toISOString(),
      })
      .eq('id', post_id)
      .select()
      .single()

    if (error || !post) {
      return NextResponse.json({ error: error?.message || 'Attachment update failed' }, { status: 500 })
    }

    adminClient
      .from('gw_groups')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', existing.group_id)
      .then(undefined, e => console.error('[Group timestamp update error]', e))

    return NextResponse.json({ post })
  }

  const { data: existingTasks, error: existingTasksError } = await adminClient
    .from('gw_tasks')
    .select('*')
    .eq('post_id', post_id)

  if (existingTasksError) {
    return NextResponse.json({ error: existingTasksError.message }, { status: 500 })
  }

  const existingTaskRows = (existingTasks || []) as TaskRow[]
  const isTaskPost = existingTaskRows.length > 0
  const canEdit = existing.user_id === user.id || (isManagementUser(user) && isTaskPost)

  if (!canEdit) {
    return NextResponse.json({ error: '自分の投稿のみ編集できます' }, { status: 403 })
  }

  if (!trimmedContent && (!existing.attachments || existing.attachments.length === 0)) {
    return NextResponse.json({ error: '内容が必要です' }, { status: 400 })
  }

  if (taskEditRequested) {
    if (!isTaskPost) {
      return NextResponse.json({ error: 'タスク依頼ではない投稿です' }, { status: 400 })
    }
    if (existing.parent_id) {
      return NextResponse.json({ error: 'コメントのタスク編集はできません' }, { status: 400 })
    }
    if (!taskRequest || taskRequest.assigneeIds.length === 0) {
      return NextResponse.json({ error: 'タスク担当者を選択してください' }, { status: 400 })
    }
    if (!isIsoDate(taskRequest.dueDate)) {
      return NextResponse.json({ error: 'タスク期限を選択してください' }, { status: 400 })
    }

    const assigneesAreValid = await validateTaskAssignees(existing.group_id, taskRequest.assigneeIds, user)
    if (!assigneesAreValid) {
      return NextResponse.json({ error: 'タスク担当者にグループ外のメンバーが含まれています' }, { status: 400 })
    }
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

  let updatedTasks: unknown[] | undefined
  if (taskEditRequested && taskRequest) {
    const now = new Date().toISOString()
    const desiredAssigneeIds = taskRequest.assigneeIds
    const desiredAssigneeSet = new Set(desiredAssigneeIds)
    const existingByAssignee = new Map(existingTaskRows.map(task => [task.assignee_id, task]))

    const updateResults = await Promise.all(existingTaskRows.map(task => {
      if (desiredAssigneeSet.has(task.assignee_id)) {
        return adminClient
          .from('gw_tasks')
          .update({
            due_date: taskRequest.dueDate,
            canceled_at: null,
            canceled_by: null,
            cancel_reason: null,
            updated_at: now,
          })
          .eq('id', task.id)
      }

      if (!task.canceled_at) {
        return adminClient
          .from('gw_tasks')
          .update({
            canceled_at: now,
            canceled_by: user.id,
            cancel_reason: 'removed_by_task_edit',
            updated_at: now,
          })
          .eq('id', task.id)
      }

      return Promise.resolve({ error: null })
    }))

    const updateError = updateResults.find(result => result.error)?.error
    if (updateError) {
      return NextResponse.json({ error: updateError.message || 'タスク依頼の更新に失敗しました' }, { status: 500 })
    }

    const insertRows = desiredAssigneeIds
      .filter(assigneeId => !existingByAssignee.has(assigneeId))
      .map(assigneeId => ({
        post_id: post.id,
        group_id: existing.group_id,
        requester_id: existing.user_id,
        assignee_id: assigneeId,
        due_date: taskRequest.dueDate,
      }))

    if (insertRows.length > 0) {
      const { error: insertError } = await adminClient
        .from('gw_tasks')
        .insert(insertRows)

      if (insertError) {
        return NextResponse.json({ error: insertError.message || 'タスク担当者の追加に失敗しました' }, { status: 500 })
      }
    }

    const { data: activeTasks, error: activeTaskError } = await adminClient
      .from('gw_tasks')
      .select('*')
      .eq('post_id', post.id)
      .is('canceled_at', null)
      .order('due_date', { ascending: true })
      .order('created_at', { ascending: true })

    if (activeTaskError) {
      return NextResponse.json({ error: activeTaskError.message }, { status: 500 })
    }

    updatedTasks = await enrichTaskRows((activeTasks || []) as TaskRow[])
  }

  adminClient
    .from('gw_groups')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', existing.group_id)
    .then(undefined, e => console.error('[Group timestamp update error]', e))

  return NextResponse.json({
    post: {
      ...post,
      ...(updatedTasks ? { tasks: updatedTasks } : {}),
    },
  })
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

  let postingPolicy: GroupPostingPolicy
  try {
    if (!await hasGroupMembership(post.group_id, user.id)) {
      return NextResponse.json({ error: 'この掲示板に参加していません' }, { status: 403 })
    }
    postingPolicy = await loadGroupPostingPolicy(post.group_id)
  } catch (error) {
    const message = error instanceof Error ? error.message : '所属確認に失敗しました'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  if (postingPolicy.postingDisabled && !isManagementUser(user)) {
    return postingDisabledResponse(postingPolicy)
  }

  if (post.user_id !== user.id && !isManagementUser(user)) {
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
