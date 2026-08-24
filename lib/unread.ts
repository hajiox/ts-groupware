import { adminClient } from '@/lib/supabase/admin'

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

async function getReadMap(userId: string, groupIds: string[]) {
  const [readResult, membershipResult] = await Promise.all([
    adminClient
      .from('gw_read_status')
      .select('group_id, last_read_at')
      .eq('user_id', userId)
      .in('group_id', groupIds),
    adminClient
      .from('gw_group_members')
      .select('group_id, joined_at')
      .eq('user_id', userId)
      .in('group_id', groupIds),
  ])

  if (readResult.error) {
    console.error('[Unread read-status error]', {
      userId,
      error: readResult.error.message,
    })
    return null
  }

  if (membershipResult.error) {
    console.error('[Unread membership baseline error]', {
      userId,
      error: membershipResult.error.message,
    })
  }

  return {
    readMap: new Map((readResult.data || []).map(row => [row.group_id, row.last_read_at])),
    membershipMap: new Map(
      (membershipResult.data || []).map(row => [row.group_id, row.joined_at]),
    ),
  }
}

export async function getUnreadCountsByGroup(userId: string, groupIds: string[]) {
  const uniqueGroupIds = [...new Set(groupIds)].filter(Boolean)
  if (uniqueGroupIds.length === 0) return {}

  const readBaselines = await getReadMap(userId, uniqueGroupIds)
  if (!readBaselines) {
    return Object.fromEntries(uniqueGroupIds.map(groupId => [groupId, 0]))
  }

  const pairs = await Promise.all(uniqueGroupIds.map(async (groupId) => {
    let query = adminClient
      .from('gw_posts')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', groupId)
      .neq('user_id', userId)
      .is('parent_id', null)

    const baseline = readBaselines.readMap.get(groupId)
      || readBaselines.membershipMap.get(groupId)
    if (!baseline) {
      console.error('[Unread baseline missing]', { groupId, userId })
      return [groupId, 0] as const
    }
    query = query.gt('created_at', baseline)

    const { count, error } = await query
    if (error) {
      console.error('[Unread count error]', { groupId, userId, error: error.message })
      return [groupId, 0] as const
    }
    return [groupId, count || 0] as const
  }))

  return Object.fromEntries(pairs)
}

export async function getUnreadSummary(userId: string): Promise<UnreadSummary> {
  const { data: memberships, error: membershipError } = await adminClient
    .from('gw_group_members')
    .select('group_id')
    .eq('user_id', userId)

  if (membershipError) {
    console.error('[Unread membership error]', {
      userId,
      error: membershipError.message,
    })
    return { dmUnread: 0, groupUnread: 0, totalUnread: 0 }
  }

  const groupIds = [...new Set((memberships || []).map(row => row.group_id))]
  if (groupIds.length === 0) {
    return { dmUnread: 0, groupUnread: 0, totalUnread: 0 }
  }

  const { data: groups, error: groupsError } = await adminClient
    .from('gw_groups')
    .select('id, type, description')
    .in('id', groupIds)

  if (groupsError) {
    console.error('[Unread groups error]', {
      userId,
      error: groupsError.message,
    })
    return { dmUnread: 0, groupUnread: 0, totalUnread: 0 }
  }

  const unreadByGroup = await getUnreadCountsByGroup(userId, groupIds)
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
