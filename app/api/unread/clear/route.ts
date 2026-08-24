import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'
import { markGroupsRead } from '@/lib/read-status'
import { isManagementUser } from '@/lib/user-roles'

function isDirectChat(group: { type?: string | null; description?: string | null }) {
  return group.type === 'chat'
    && typeof group.description === 'string'
    && group.description.startsWith('direct:')
}

export async function POST() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: memberships, error: membershipError } = await adminClient
    .from('gw_group_members')
    .select('group_id')
    .eq('user_id', user.id)

  if (membershipError) {
    return NextResponse.json({ error: membershipError.message }, { status: 500 })
  }

  const explicitGroupIds = (memberships || []).map(member => member.group_id)
  let groupIds = explicitGroupIds

  if (isManagementUser(user)) {
    const { data: groups, error: groupError } = await adminClient
      .from('gw_groups')
      .select('id, type, description')

    if (groupError) {
      return NextResponse.json({ error: groupError.message }, { status: 500 })
    }

    const visibleGroupIds = (groups || [])
      .filter(group => !isDirectChat(group))
      .map(group => group.id)

    groupIds = [...explicitGroupIds, ...visibleGroupIds]
  }

  const result = await markGroupsRead(user.id, groupIds)

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    accountScoped: true,
    deviceScoped: false,
    clearedGroups: result.count,
    lastReadAt: result.lastReadAt,
  })
}
