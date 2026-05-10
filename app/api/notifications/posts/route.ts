import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

/**
 * GET /api/notifications/posts?post_ids=xxx,yyy
 *   → { settings: { [post_id]: boolean } }
 *
 * POST /api/notifications/posts
 *   body: { post_id, muted }
 *   → { ok: true }
 */

export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const postIdsStr = request.nextUrl.searchParams.get('post_ids')
  if (!postIdsStr) {
    return NextResponse.json({ settings: {} })
  }

  const postIds = postIdsStr.split(',').map(s => s.trim()).filter(Boolean)
  if (postIds.length === 0) {
    return NextResponse.json({ settings: {} })
  }

  const { data: rows } = await adminClient
    .from('gw_post_notification_settings')
    .select('post_id, muted')
    .eq('user_id', user.id)
    .in('post_id', postIds)

  const settings: Record<string, boolean> = {}
  for (const row of rows || []) {
    settings[row.post_id] = row.muted
  }

  return NextResponse.json({ settings })
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json()
  const { post_id, muted } = body

  if (!post_id || typeof muted !== 'boolean') {
    return NextResponse.json({ error: 'post_id と muted (boolean) が必要です' }, { status: 400 })
  }

  const { error } = await adminClient
    .from('gw_post_notification_settings')
    .upsert({
      user_id: user.id,
      post_id,
      muted,
    }, { onConflict: 'user_id,post_id' })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
