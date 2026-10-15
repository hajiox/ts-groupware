import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'
import { isManagementUser } from '@/lib/user-roles'
import { isCodexMtgGroup } from '@/lib/codex-mtg-policy'

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const MAX_POST_IDS = 100

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  })
}

// Refresh only known attachments. Unlike timeline reads this must not mark
// unseen posts as read or replace expanded comments with a limited preview.
export async function GET(request: NextRequest) {
  try {
    const user = await getUserSession()
    if (!user) return json({ error: '認証が必要です' }, 401)

    const groupId = request.nextUrl.searchParams.get('group_id') || ''
    const rawIds = (request.nextUrl.searchParams.get('post_ids') || '').split(',')
    if (!UUID_PATTERN.test(groupId) || rawIds.length > MAX_POST_IDS
      || rawIds.some(id => !UUID_PATTERN.test(id))) {
      return json({ error: '掲示板と投稿IDを100件以内で指定してください' }, 400)
    }
    const postIds = [...new Set(rawIds.map(id => id.toLowerCase()))]

    if (isCodexMtgGroup(groupId) && !isManagementUser(user)) {
      return json({ error: 'この掲示板に参加していません' }, 403)
    }
    const { data: membership, error: membershipError } = await adminClient
      .from('gw_group_members')
      .select('user_id')
      .eq('group_id', groupId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (membershipError) return json({ error: '所属確認に失敗しました' }, 500)
    if (!membership) return json({ error: 'この掲示板に参加していません' }, 403)

    const { data, error } = await adminClient.from('gw_posts')
      .select('id, attachments')
      .eq('group_id', groupId)
      .in('id', postIds)
    if (error) return json({ error: '添付の更新確認に失敗しました' }, 500)

    return json({ posts: data || [] })
  } catch {
    return json({ error: '添付の更新確認に失敗しました' }, 500)
  }
}
