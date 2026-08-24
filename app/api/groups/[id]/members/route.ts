import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'
import { isManagementRole } from '@/lib/user-roles'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const { id: groupId } = await params
  if (!groupId) {
    return NextResponse.json({ error: 'group_id が必要です' }, { status: 400 })
  }

  const { data: group } = await adminClient
    .from('gw_groups')
    .select('id, name')
    .eq('id', groupId)
    .single()

  if (!group) {
    return NextResponse.json({ error: 'グループが見つかりません' }, { status: 404 })
  }

  const { data: memberships } = await adminClient
    .from('gw_group_members')
    .select('user_id, role')
    .eq('group_id', groupId)

  const memberIds = [...new Set((memberships || []).map(member => member.user_id))]
  const hasAccess = memberIds.includes(user.id)
  if (!hasAccess) {
    return NextResponse.json({ error: 'アクセス権がありません' }, { status: 403 })
  }

  const { data: users } = memberIds.length > 0
    ? await adminClient
      .from('gw_users')
      .select('id, display_name, real_name, picture_url, role, department, status')
      .in('id', memberIds)
      .eq('status', 'approved')
    : { data: [] }

  const roleMap = new Map((memberships || []).map(member => [member.user_id, member.role || 'member']))
  const members = (users || [])
    .map(member => ({
      id: member.id,
      display_name: member.real_name || member.display_name,
      picture_url: member.picture_url || null,
      role: member.role || 'member',
      department: member.department || '製造',
      groupRole: roleMap.get(member.id) || 'member',
      isSelf: member.id === user.id,
    }))
    .sort((a, b) => {
      const aIsAdmin = isManagementRole(a.role) || a.groupRole === 'admin'
      const bIsAdmin = isManagementRole(b.role) || b.groupRole === 'admin'
      if (aIsAdmin !== bIsAdmin) return aIsAdmin ? -1 : 1
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
      return a.display_name.localeCompare(b.display_name, 'ja')
    })

  return NextResponse.json({ group, members })
}
