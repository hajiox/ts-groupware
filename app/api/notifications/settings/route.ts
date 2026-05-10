import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

/**
 * GET /api/notifications/settings?group_id=xxx
 *   → { muted: boolean }
 *
 * GET /api/notifications/settings (group_id なし)
 *   → { settings: { [group_id]: boolean } }  全グループのミュート状態
 *
 * POST /api/notifications/settings
 *   body: { group_id, muted }
 *   → { ok: true }
 */

export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const groupId = request.nextUrl.searchParams.get('group_id')

  if (groupId) {
    // 特定グループの設定を返す
    const { data } = await adminClient
      .from('gw_notification_settings')
      .select('muted')
      .eq('user_id', user.id)
      .eq('group_id', groupId)
      .single()

    return NextResponse.json({ muted: data?.muted ?? false })
  }

  // 全グループの設定を返す
  const { data: rows } = await adminClient
    .from('gw_notification_settings')
    .select('group_id, muted')
    .eq('user_id', user.id)

  const settings: Record<string, boolean> = {}
  for (const row of rows || []) {
    settings[row.group_id] = row.muted
  }

  return NextResponse.json({ settings })
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json()
  const { group_id, muted } = body

  if (!group_id || typeof muted !== 'boolean') {
    return NextResponse.json({ error: 'group_id と muted (boolean) が必要です' }, { status: 400 })
  }

  const { error } = await adminClient
    .from('gw_notification_settings')
    .upsert({
      user_id: user.id,
      group_id,
      muted,
    }, { onConflict: 'user_id,group_id' })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
