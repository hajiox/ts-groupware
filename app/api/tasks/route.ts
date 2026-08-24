import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { pruneMentionHistory } from '@/lib/mentions'
import { getUserSession } from '@/lib/session'
import { isManagementUser } from '@/lib/user-roles'

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
  updated_at?: string | null
}

type UserRow = {
  id: string
  display_name: string
  real_name?: string | null
  picture_url?: string | null
}

type MentionRow = {
  id: string
  mentioned_user_id: string
  sender_id: string | null
  sender_name: string
  group_id: string | null
  group_name: string | null
  post_id: string
  target_post_id: string | null
  context_type: 'board' | 'chat' | 'dm'
  context_label: string
  content_snippet: string
  url: string
  created_at: string
}

function displayName(user?: UserRow | null) {
  return user?.real_name || user?.display_name || '不明'
}

function mentionUrl(mention: MentionRow) {
  if (mention.url) return mention.url
  if (mention.context_type === 'board' && mention.group_id) {
    return `/board/${mention.group_id}#post-${mention.target_post_id || mention.post_id}`
  }
  if ((mention.context_type === 'chat' || mention.context_type === 'dm') && mention.group_id) {
    return `/chat/${mention.group_id}`
  }
  return '/groups'
}

async function enrichTasks(tasks: TaskRow[]) {
  if (tasks.length === 0) return []

  const postIds = [...new Set(tasks.map(task => task.post_id))]
  const groupIds = [...new Set(tasks.map(task => task.group_id))]
  const userIds = [...new Set(tasks.flatMap(task => [
    task.requester_id,
    task.assignee_id,
    task.completed_by,
  ].filter(Boolean) as string[]))]

  const [{ data: posts }, { data: groups }, { data: users }] = await Promise.all([
    adminClient
      .from('gw_posts')
      .select('id, content, created_at')
      .in('id', postIds),
    adminClient
      .from('gw_groups')
      .select('id, name, type')
      .in('id', groupIds),
    adminClient
      .from('gw_users')
      .select('id, display_name, real_name, picture_url')
      .in('id', userIds),
  ])

  const postMap = Object.fromEntries((posts || []).map(post => [post.id, post]))
  const groupMap = Object.fromEntries((groups || []).map(group => [group.id, group]))
  const userMap = Object.fromEntries(((users || []) as UserRow[]).map(user => [
    user.id,
    { ...user, display_name: displayName(user) },
  ]))

  return tasks.map(task => ({
    ...task,
    post: postMap[task.post_id] || null,
    group: groupMap[task.group_id] || null,
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

  const summaryOnly = request.nextUrl.searchParams.get('summary') === '1'
  const status = request.nextUrl.searchParams.get('status') || 'open'

  if (summaryOnly) {
    const { count, error } = await adminClient
      .from('gw_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('assignee_id', user.id)
      .is('completed_at', null)
      .is('canceled_at', null)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ openCount: count || 0 })
  }

  let query = adminClient
    .from('gw_tasks')
    .select('*')
    .eq('assignee_id', user.id)
    .is('canceled_at', null)
    .limit(100)

  if (status === 'all') {
    query = query.order('created_at', { ascending: false })
  } else {
    query = query
      .order('due_date', { ascending: true })
      .order('created_at', { ascending: false })
  }

  if (status !== 'all') {
    if (status === 'completed') query = query.not('completed_at', 'is', null)
    else query = query.is('completed_at', null)
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const tasks = (data || []) as TaskRow[]
  const openCount = tasks.filter(task => !task.completed_at).length

  await pruneMentionHistory(user.id).catch(error => {
    console.error('[Mention history prune error]', error)
  })

  const { data: mentions, error: mentionsError } = await adminClient
    .from('gw_mentions')
    .select('*')
    .eq('mentioned_user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(30)

  if (mentionsError) {
    return NextResponse.json({ error: mentionsError.message }, { status: 500 })
  }

  const mentionItems = ((mentions || []) as MentionRow[]).map(mention => ({
    ...mention,
    url: mentionUrl(mention),
  }))

  return NextResponse.json({ tasks: await enrichTasks(tasks), mentions: mentionItems, openCount })
}

export async function PATCH(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const taskId = typeof body.task_id === 'string' ? body.task_id.trim() : ''
  if (!taskId) {
    return NextResponse.json({ error: 'task_id が必要です' }, { status: 400 })
  }

  const { data: existing } = await adminClient
    .from('gw_tasks')
    .select('*')
    .eq('id', taskId)
    .single()

  if (!existing) {
    return NextResponse.json({ error: 'タスクが見つかりません' }, { status: 404 })
  }
  if ((existing as TaskRow).canceled_at) {
    return NextResponse.json({ error: '取り消されたタスクです' }, { status: 410 })
  }
  if (existing.assignee_id !== user.id && !isManagementUser(user)) {
    return NextResponse.json({ error: 'このタスクを完了にできません' }, { status: 403 })
  }
  if (existing.completed_at) {
    return NextResponse.json({ task: (await enrichTasks([existing as TaskRow]))[0] })
  }

  const { data: task, error } = await adminClient
    .from('gw_tasks')
    .update({
      completed_at: new Date().toISOString(),
      completed_by: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId)
    .select('*')
    .single()

  if (error || !task) {
    return NextResponse.json({ error: error?.message || 'タスクの完了に失敗しました' }, { status: 500 })
  }

  return NextResponse.json({ task: (await enrichTasks([task as TaskRow]))[0] })
}
