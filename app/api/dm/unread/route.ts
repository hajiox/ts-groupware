import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

/**
 * DM未読メッセージ数を返すAPI
 * gw_read_status の last_read_at 以降に投稿された DM メッセージをカウント
 */
export async function GET() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ count: 0 }, { status: 401 })
  }

  // 自分が参加しているDMグループを取得
  const { data: myGroups } = await adminClient
    .from('gw_group_members')
    .select('group_id')
    .eq('user_id', user.id)

  if (!myGroups || myGroups.length === 0) {
    return NextResponse.json({ count: 0 })
  }

  const groupIds = myGroups.map(g => g.group_id)

  // DMグループ（description が direct: で始まる）を絞り込み
  const { data: dmGroups } = await adminClient
    .from('gw_groups')
    .select('id')
    .in('id', groupIds)
    .eq('type', 'chat')
    .like('description', 'direct:%')

  if (!dmGroups || dmGroups.length === 0) {
    return NextResponse.json({ count: 0 })
  }

  const dmIds = dmGroups.map(g => g.id)

  // 自分の既読状態を取得
  const { data: readStatuses } = await adminClient
    .from('gw_read_status')
    .select('group_id, last_read_at')
    .eq('user_id', user.id)
    .in('group_id', dmIds)

  const readMap = new Map<string, string>()
  for (const rs of (readStatuses || [])) {
    readMap.set(rs.group_id, rs.last_read_at)
  }

  // 各DMグループの未読メッセージ数を集計
  let totalUnread = 0

  for (const dmId of dmIds) {
    const lastRead = readMap.get(dmId)
    let query = adminClient
      .from('gw_posts')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', dmId)
      .neq('user_id', user.id)
      .is('parent_id', null)

    if (lastRead) {
      query = query.gt('created_at', lastRead)
    }

    const { count } = await query
    totalUnread += (count || 0)
  }

  return NextResponse.json({ count: totalUnread })
}
