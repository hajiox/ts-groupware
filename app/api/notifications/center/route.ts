import { NextRequest, NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, no-cache, max-age=0, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
  Vary: 'Cookie',
}

type NotificationFeedRow = {
  event_key: string
  event_type: 'mention' | 'task' | 'reaction' | 'comment'
  source_id: string
  actor_id: string | null
  actor_name: string
  actor_picture_url: string | null
  group_name: string | null
  title: string
  summary: string
  url: string
  created_at: string
  due_date: string | null
  completed_at: string | null
  emoji: string | null
}

function json(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: PRIVATE_NO_STORE_HEADERS })
}

export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) return json({ error: '認証が必要です' }, 401)

  const summaryOnly = request.nextUrl.searchParams.get('summary') === '1'
  const feedLimit = summaryOnly ? 200 : 100
  const [{ data: state, error: stateError }, { data: feed, error: feedError }] = await Promise.all([
    adminClient
      .from('gw_notification_center_state')
      .select('read_through')
      .eq('user_id', user.id)
      .maybeSingle(),
    adminClient.rpc('gw_notification_center_feed', {
      p_user_id: user.id,
      p_limit: feedLimit,
    }),
  ])

  if (stateError || feedError) {
    return json({ error: stateError?.message || feedError?.message || '通知を取得できませんでした' }, 500)
  }

  const readThrough = typeof state?.read_through === 'string'
    ? Date.parse(state.read_through)
    : Date.now()
  const items = ((feed || []) as NotificationFeedRow[]).map(item => ({
    ...item,
    is_unread: Date.parse(item.created_at) > readThrough,
  }))
  const unreadCount = items.reduce((count, item) => count + (item.is_unread ? 1 : 0), 0)
  const latestCreatedAt = items[0]?.created_at || null

  if (summaryOnly) {
    return json({ unreadCount, latestCreatedAt })
  }

  return json({ items, unreadCount, latestCreatedAt })
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) return json({ error: '認証が必要です' }, 401)

  const body = await request.json().catch(() => ({}))
  const requestedReadThrough = typeof body.read_through === 'string' ? body.read_through : ''
  const timestamp = Date.parse(requestedReadThrough)
  if (!requestedReadThrough || Number.isNaN(timestamp)) {
    return json({ error: '既読位置が正しくありません' }, 400)
  }

  const readThrough = new Date(Math.min(timestamp, Date.now())).toISOString()
  const { data, error } = await adminClient.rpc('gw_mark_notification_center_read', {
    p_user_id: user.id,
    p_read_through: readThrough,
  })

  if (error) return json({ error: error.message || '通知を既読にできませんでした' }, 500)
  return json({ readThrough: data || readThrough })
}
