import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'
import { getUnreadCountsByGroup } from '@/lib/unread'
import { getDeviceIdFromRequest } from '@/lib/read-status'
import { withTimeout } from '@/lib/timeout'

/**
 * GET /api/groups — 自分が参加しているグループ一覧
 * POST /api/groups — グループ新規作成
 */

function isDirectChat(group: { type?: string; description?: string | null }) {
  return group.type === 'chat' && typeof group.description === 'string' && group.description.startsWith('direct:')
}

export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const { data: memberships } = await withTimeout(
    adminClient
      .from('gw_group_members')
      .select('group_id')
      .eq('user_id', user.id),
    5000,
    { data: [], error: null },
    'groups memberships'
  )

  const explicitGroupIds = memberships?.map(m => m.group_id) || []

  if (explicitGroupIds.length === 0) {
    return NextResponse.json({ groups: [] })
  }

  let groupsQuery = adminClient
    .from('gw_groups')
    .select('*')
    .order('updated_at', { ascending: false })
    .in('id', explicitGroupIds)

  const { data: rawGroups } = await withTimeout(
    groupsQuery,
    5000,
    { data: [], error: null },
    'groups list'
  )
  const groups = (rawGroups || []).filter(group => !isDirectChat(group))
  const groupIds = groups.map(group => group.id)

  if (groupIds.length === 0) {
    return NextResponse.json({ groups: [] })
  }

  const { data: groupMembers } = await withTimeout(
    adminClient
      .from('gw_group_members')
      .select('group_id, user_id')
      .in('group_id', groupIds),
    5000,
    { data: [], error: null },
    'groups members'
  )

  const explicitGroupIdSet = new Set(explicitGroupIds)
  const directOtherUserIds = groups
    .filter(group => isDirectChat(group))
    .filter(group => explicitGroupIdSet.has(group.id))
    .map(group => (groupMembers || []).find(member => member.group_id === group.id && member.user_id !== user.id)?.user_id)
    .filter(Boolean)

  const { data: directUsers } = directOtherUserIds.length > 0
    ? await withTimeout(
      adminClient
        .from('gw_users')
        .select('id, display_name, real_name, picture_url')
        .in('id', directOtherUserIds),
      5000,
      { data: [], error: null },
      'direct users'
    )
    : { data: [] }

  const directUserMap = Object.fromEntries((directUsers || []).map(directUser => [
    directUser.id, 
    { ...directUser, display_name: directUser.real_name || directUser.display_name }
  ]))

  const [{ data: allPosts }, unreadMap] = await Promise.all([
    // 最新投稿を新しい順に取得（各グループの最新1件抽出用）
    // limit制限で全件スキャンを回避
    withTimeout(
      adminClient
        .from('gw_posts')
        .select('group_id, content, created_at')
        .in('group_id', groupIds)
        .is('parent_id', null)
        .order('created_at', { ascending: false })
        .limit(groupIds.length * 3),
      5000,
      { data: [], error: null },
      'groups latest posts'
    ),
    withTimeout(
      getUnreadCountsByGroup(user.id, groupIds, getDeviceIdFromRequest(request)),
      8000,
      {},
      'groups unread counts'
    ),
  ])

  // グループごとの最新投稿をマップ化
  const latestPostMap: Record<string, { content: string | null; created_at: string }> = {}
  for (const post of allPosts || []) {
    if (!latestPostMap[post.group_id]) {
      latestPostMap[post.group_id] = post
    }
  }

  const enrichedGroups = groups.map((group) => {
    const directOtherUserId = isDirectChat(group) && explicitGroupIdSet.has(group.id)
      ? (groupMembers || []).find(member => member.group_id === group.id && member.user_id !== user.id)?.user_id
      : null
    const directUser = directOtherUserId ? directUserMap[directOtherUserId] : null
    const latestPost = latestPostMap[group.id]

    return {
      ...group,
      name: directUser?.display_name || group.name,
      isDirect: Boolean(directUser),
      directUser: directUser || null,
      lastMessage: latestPost?.content?.slice(0, 50) || '',
      lastMessageAt: latestPost?.created_at || group.created_at,
      unread: unreadMap[group.id] || 0,
    }
  })

  return NextResponse.json({ groups: enrichedGroups })
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  // 管理者のみグループ作成可
  if (user.role !== 'admin') {
    return NextResponse.json({ error: '管理者のみグループを作成できます' }, { status: 403 })
  }

  const body = await request.json()
  const { name, description, type, icon } = body

  if (!name?.trim()) {
    return NextResponse.json({ error: 'グループ名は必須です' }, { status: 400 })
  }

  // チャットタイプはアイコン💬固定
  const resolvedType = type || 'board'
  const resolvedIcon = resolvedType === 'chat' ? '💬' : (icon || '📢')

  // グループ作成
  const { data: group, error } = await adminClient
    .from('gw_groups')
    .insert({
      name: name.trim(),
      description: description || null,
      type: resolvedType,
      icon: resolvedIcon,
      created_by: user.id,
    })
    .select()
    .single()

  if (error || !group) {
    return NextResponse.json({ error: error?.message || '作成失敗' }, { status: 500 })
  }

  // 作成時点の承認済み管理者を全員参加にする。
  // 以後は管理画面のメンバー管理で個別に除外できる。
  const { data: adminUsers, error: adminUsersError } = await adminClient
    .from('gw_users')
    .select('id')
    .eq('role', 'admin')
    .eq('status', 'approved')

  if (adminUsersError) {
    await adminClient.from('gw_groups').delete().eq('id', group.id)
    return NextResponse.json({ error: adminUsersError.message }, { status: 500 })
  }

  const adminMemberRows = new Map<string, { group_id: string; user_id: string; role: 'admin' }>()
  for (const adminUser of adminUsers || []) {
    adminMemberRows.set(adminUser.id, {
      group_id: group.id,
      user_id: adminUser.id,
      role: 'admin',
    })
  }
  adminMemberRows.set(user.id, {
    group_id: group.id,
    user_id: user.id,
    role: 'admin',
  })

  const { error: memberError } = await adminClient
    .from('gw_group_members')
    .upsert([...adminMemberRows.values()], { onConflict: 'group_id,user_id' })

  if (memberError) {
    await adminClient.from('gw_groups').delete().eq('id', group.id)
    return NextResponse.json({ error: memberError.message }, { status: 500 })
  }

  return NextResponse.json({ group }, { status: 201 })
}
