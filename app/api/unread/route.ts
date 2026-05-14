import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

export async function GET() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ dmUnread: 0, groupUnread: 0, totalUnread: 0 }, { status: 401 })
  }

  // 1. 自分が参加しているグループを取得
  const { data: myGroups } = await adminClient
    .from('gw_group_members')
    .select('group_id')
    .eq('user_id', user.id)

  if (!myGroups || myGroups.length === 0) {
    return NextResponse.json({ dmUnread: 0, groupUnread: 0, totalUnread: 0 })
  }

  const groupIds = myGroups.map(g => g.group_id)

  // 2. グループ詳細を取得し、DMと一般グループに分ける
  const { data: allGroups } = await adminClient
    .from('gw_groups')
    .select('id, type, description')
    .in('id', groupIds)

  if (!allGroups || allGroups.length === 0) {
    return NextResponse.json({ dmUnread: 0, groupUnread: 0, totalUnread: 0 })
  }

  const dmIds: string[] = []
  const normalGroupIds: string[] = []

  for (const g of allGroups) {
    if (g.type === 'chat' && typeof g.description === 'string' && g.description.startsWith('direct:')) {
      dmIds.push(g.id)
    } else {
      normalGroupIds.push(g.id)
    }
  }

  // 3. 自分の既読状態を取得
  const { data: readStatuses } = await adminClient
    .from('gw_read_status')
    .select('group_id, last_read_at')
    .eq('user_id', user.id)
    .in('group_id', groupIds)

  const readMap = new Map<string, string>()
  for (const rs of (readStatuses || [])) {
    readMap.set(rs.group_id, rs.last_read_at)
  }

  // 4. 未読数の集計関数
  async function countUnread(gIds: string[]) {
    let unread = 0
    for (const gid of gIds) {
      const lastRead = readMap.get(gid)
      let query = adminClient
        .from('gw_posts')
        .select('id', { count: 'exact', head: true })
        .eq('group_id', gid)
        .neq('user_id', user.id)

      // 親メッセージのみ（スレッドは別途取得が必要だが、現状の仕様に合わせる）
      query = query.is('parent_id', null)

      if (lastRead) {
        query = query.gt('created_at', lastRead)
      }

      const { count } = await query
      unread += (count || 0)
    }
    return unread
  }

  const [dmUnread, groupUnread] = await Promise.all([
    countUnread(dmIds),
    countUnread(normalGroupIds)
  ])

  return NextResponse.json({
    dmUnread,
    groupUnread,
    totalUnread: dmUnread + groupUnread
  })
}
