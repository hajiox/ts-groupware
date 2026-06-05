import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

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
  updated_at?: string | null
}

type UserRow = {
  id: string
  display_name: string
  real_name?: string | null
  picture_url?: string | null
}

function displayName(user?: UserRow | null) {
  return user?.real_name || user?.display_name || '不明'
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

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ openCount: count || 0 })
  }

  let query = adminClient
    .from('gw_tasks')
    .select('*')
    .eq('assignee_id', user.id)
    .order('due_date', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(100)

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

  return NextResponse.json({ tasks: await enrichTasks(tasks), openCount })
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
  if (existing.assignee_id !== user.id && user.role !== 'admin') {
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
