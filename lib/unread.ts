import { adminClient } from '@/lib/supabase/admin'
import { shouldFallbackDeviceRead } from '@/lib/read-status'

type GroupRow = {
  id: string
  type: string | null
  description: string | null
}

export type UnreadSummary = {
  dmUnread: number
  groupUnread: number
  totalUnread: number
}

function isDirectChat(group: GroupRow) {
  return group.type === 'chat'
    && typeof group.description === 'string'
    && group.description.startsWith('direct:')
}

async function getReadMap(userId: string, groupIds: string[], deviceId?: string | null) {
  const userReadPromise = adminClient
    .from('gw_read_status')
    .select('group_id, last_read_at')
    .eq('user_id', userId)
    .in('group_id', groupIds)

  if (!deviceId) {
    const { data } = await userReadPromise
    return new Map((data || []).map(row => [row.group_id, row.last_read_at]))
  }

  const [{ data: userRows }, { data: deviceRows, error: deviceError }] = await Promise.all([
    userReadPromise,
    adminClient
      .from('gw_device_read_status')
      .select('group_id, last_read_at')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .in('group_id', groupIds),
  ])

  const readMap = new Map((userRows || []).map(row => [row.group_id, row.last_read_at]))

  if (deviceError) {
    if (!shouldFallbackDeviceRead(deviceError)) {
      console.error('[Device unread read-status error]', { userId, deviceId, error: deviceError.message })
    }
    return readMap
  }

  for (const row of deviceRows || []) {
    readMap.set(row.group_id, row.last_read_at)
  }

  return readMap
}

export async function getUnreadCountsByGroup(userId: string, groupIds: string[], deviceId?: string | null) {
  const uniqueGroupIds = [...new Set(groupIds)].filter(Boolean)
  if (uniqueGroupIds.length === 0) return {}

  const readMap = await getReadMap(userId, uniqueGroupIds, deviceId)

  const pairs = await Promise.all(uniqueGroupIds.map(async (groupId) => {
    let query = adminClient
      .from('gw_posts')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', groupId)
      .neq('user_id', userId)
      .is('parent_id', null)

    const lastRead = readMap.get(groupId)
    if (lastRead) {
      query = query.gt('created_at', lastRead)
    }

    const { count, error } = await query
    if (error) {
      console.error('[Unread count error]', { groupId, userId, error: error.message })
      return [groupId, 0] as const
    }
    return [groupId, count || 0] as const
  }))

  return Object.fromEntries(pairs)
}

export async function getUnreadSummary(userId: string, deviceId?: string | null): Promise<UnreadSummary> {
  const { data: memberships } = await adminClient
    .from('gw_group_members')
    .select('group_id')
    .eq('user_id', userId)

  const groupIds = [...new Set((memberships || []).map(row => row.group_id))]
  if (groupIds.length === 0) {
    return { dmUnread: 0, groupUnread: 0, totalUnread: 0 }
  }

  const { data: groups } = await adminClient
    .from('gw_groups')
    .select('id, type, description')
    .in('id', groupIds)

  const unreadByGroup = await getUnreadCountsByGroup(userId, groupIds, deviceId)
  let dmUnread = 0
  let groupUnread = 0

  for (const group of (groups || []) as GroupRow[]) {
    const count = unreadByGroup[group.id] || 0
    if (isDirectChat(group)) {
      dmUnread += count
    } else {
      groupUnread += count
    }
  }

  return {
    dmUnread,
    groupUnread,
    totalUnread: dmUnread + groupUnread,
  }
}
