import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'
import { getDeviceIdFromRequest } from '@/lib/read-status'
import { getUnreadCountsByGroup } from '@/lib/unread'
import { withTimeout } from '@/lib/timeout'

export async function GET(request: Request) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ count: 0, perUser: {} }, { status: 401 })
  }

  const { data: myGroups } = await withTimeout(
    adminClient
      .from('gw_group_members')
      .select('group_id')
      .eq('user_id', user.id),
    5000,
    { data: [], error: null },
    'dm unread memberships'
  )

  if (!myGroups || myGroups.length === 0) {
    return NextResponse.json({ count: 0, perUser: {} })
  }

  const groupIds = myGroups.map(g => g.group_id)
  const { data: dmGroups } = await withTimeout(
    adminClient
      .from('gw_groups')
      .select('id, description')
      .in('id', groupIds)
      .eq('type', 'chat')
      .like('description', 'direct:%'),
    5000,
    { data: [], error: null },
    'dm unread groups'
  )

  if (!dmGroups || dmGroups.length === 0) {
    return NextResponse.json({ count: 0, perUser: {} })
  }

  function getOtherUserId(description: string): string | null {
    const parts = description.split(':')
    if (parts.length < 3) return null
    const id1 = parts[1]
    const id2 = parts[2]
    return id1 === user.id ? id2 : id1
  }

  const dmIds = dmGroups.map(g => g.id)
  const unreadMap = await withTimeout(
    getUnreadCountsByGroup(user.id, dmIds, getDeviceIdFromRequest(request)),
    8000,
    {},
    'dm unread counts'
  )
  let totalUnread = 0
  const perUser: Record<string, number> = {}

  for (const dm of dmGroups) {
    const unread = unreadMap[dm.id] || 0
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
