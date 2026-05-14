import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

/**
 * DM未読メッセージ数を返すAPI
 * count: 全DM合計の未読数
 * perUser: ユーザーIDごとの未読数 { [userId]: count }
 */
export async function GET() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ count: 0, perUser: {} }, { status: 401 })
  }

  // 自分が参加しているDMグループを取得
  const { data: myGroups } = await adminClient
    .from('gw_group_members')
    .select('group_id')
    .eq('user_id', user.id)

  if (!myGroups || myGroups.length === 0) {
    return NextResponse.json({ count: 0, perUser: {} })
  }

  const groupIds = myGroups.map(g => g.group_id)

  // DMグループ（description が direct: で始まる）を絞り込み
  const { data: dmGroups } = await adminClient
    .from('gw_groups')
    .select('id, description')
    .in('id', groupIds)
    .eq('type', 'chat')
    .like('description', 'direct:%')

  if (!dmGroups || dmGroups.length === 0) {
    return NextResponse.json({ count: 0, perUser: {} })
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

  // descriptionからDM相手のユーザーIDを取得
  // description format: "direct:userId1:userId2"
  function getOtherUserId(description: string): string | null {
    const parts = description.split(':')
    if (parts.length < 3) return null
    const id1 = parts[1]
    const id2 = parts[2]
    return id1 === user.id ? id2 : id1
  }

  // 各DMグループの未読メッセージ数を集計
  let totalUnread = 0
  const perUser: Record<string, number> = {}

  for (const dm of dmGroups) {
    const lastRead = readMap.get(dm.id)
    let query = adminClient
      .from('gw_posts')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', dm.id)
      .neq('user_id', user.id)
      .is('parent_id', null)

    if (lastRead) {
      query = query.gt('created_at', lastRead)
    }

    const { count } = await query
    const unread = count || 0
    totalUnread += unread

    if (unread > 0) {
      const otherUserId = getOtherUserId(dm.description || '')
      if (otherUserId) {
        perUser[otherUserId] = unread
      }
    }
  }

  return NextResponse.json({ count: totalUnread, perUser })
}
