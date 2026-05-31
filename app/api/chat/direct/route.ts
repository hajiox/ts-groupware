import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'
import { withTimeout } from '@/lib/timeout'

function directChatKey(userIdA: string, userIdB: string) {
  return `direct:${[userIdA, userIdB].sort().join(':')}`
}

function getOtherDirectUserId(description: string | null, currentUserId: string) {
  if (!description?.startsWith('direct:')) return null
  const parts = description.split(':')
  if (parts.length < 3) return null
  const [userIdA, userIdB] = [parts[1], parts[2]]
  return userIdA === currentUserId ? userIdB : userIdA
}

export async function GET() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const { data: users, error } = await adminClient
    .from('gw_users')
    .select('id, display_name, real_name, picture_url, role')
    .eq('status', 'approved')
    .order('display_name', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const { data: memberships } = await withTimeout(
    adminClient
      .from('gw_group_members')
      .select('group_id')
      .eq('user_id', user.id),
    5000,
    { data: [], error: null },
    'direct memberships'
  )
  const groupIds = memberships?.map(m => m.group_id) || []

  const { data: directGroups } = groupIds.length > 0
    ? await withTimeout(
      adminClient
        .from('gw_groups')
        .select('id, description, created_at, updated_at')
        .in('id', groupIds)
        .eq('type', 'chat')
        .like('description', 'direct:%'),
      5000,
      { data: [], error: null },
      'direct groups'
    )
    : { data: [] }

  const directGroupIds = (directGroups || []).map(group => group.id)
  const { data: latestPosts } = directGroupIds.length > 0
    ? await withTimeout(
      adminClient
        .from('gw_posts')
        .select('group_id, created_at')
        .in('group_id', directGroupIds)
        .is('parent_id', null)
        .order('created_at', { ascending: false })
        .limit(directGroupIds.length * 3),
      5000,
      { data: [], error: null },
      'direct latest posts'
    )
    : { data: [] }

  const latestPostAtByGroup = new Map<string, string>()
  for (const post of latestPosts || []) {
    if (!latestPostAtByGroup.has(post.group_id)) {
      latestPostAtByGroup.set(post.group_id, post.created_at)
    }
  }

  const directMetaByUser = new Map<string, { groupId: string; lastMessageAt: string }>()
  for (const group of directGroups || []) {
    const otherUserId = getOtherDirectUserId(group.description, user.id)
    if (!otherUserId) continue
    directMetaByUser.set(otherUserId, {
      groupId: group.id,
      lastMessageAt: latestPostAtByGroup.get(group.id) || group.updated_at || group.created_at,
    })
  }

  const normalizedUsers = (users || []).map(member => ({
    ...member,
    display_name: member.real_name || member.display_name,
    isSelf: member.id === user.id,
    isTsgAi: member.display_name === 'TSG君' || member.real_name === 'TSG君',
    directGroupId: directMetaByUser.get(member.id)?.groupId || null,
    lastMessageAt: directMetaByUser.get(member.id)?.lastMessageAt || null,
  }))

  const sortedUsers = normalizedUsers.sort((a, b) => {
    const pinA = a.isSelf ? 0 : a.isTsgAi ? 1 : 2
    const pinB = b.isSelf ? 0 : b.isTsgAi ? 1 : 2
    if (pinA !== pinB) return pinA - pinB

    if (a.lastMessageAt && b.lastMessageAt && a.lastMessageAt !== b.lastMessageAt) {
      return b.lastMessageAt.localeCompare(a.lastMessageAt)
    }
    if (a.lastMessageAt && !b.lastMessageAt) return -1
    if (!a.lastMessageAt && b.lastMessageAt) return 1
    return a.display_name.localeCompare(b.display_name, 'ja')
  })

  return NextResponse.json({
    users: sortedUsers,
  })
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json()
  const targetUserId = typeof body.target_user_id === 'string' ? body.target_user_id : ''

  if (!targetUserId) {
    return NextResponse.json({ error: 'target_user_id が必要です' }, { status: 400 })
  }
  const { data: targetUser, error: targetError } = await adminClient
    .from('gw_users')
    .select('id, display_name, real_name, picture_url, status')
    .eq('id', targetUserId)
    .eq('status', 'approved')
    .single()

  if (targetError || !targetUser) {
    return NextResponse.json({ error: '相手ユーザーが見つかりません' }, { status: 404 })
  }
  targetUser.display_name = targetUser.real_name || targetUser.display_name

  const key = directChatKey(user.id, targetUser.id)
  const { data: existing } = await adminClient
    .from('gw_groups')
    .select('id')
    .eq('type', 'chat')
    .eq('description', key)
    .maybeSingle()

  if (existing) {
    const members = targetUser.id === user.id
      ? [{ group_id: existing.id, user_id: user.id, role: 'member' }]
      : [
        { group_id: existing.id, user_id: user.id, role: 'member' },
        { group_id: existing.id, user_id: targetUser.id, role: 'member' },
      ]

    await adminClient
      .from('gw_group_members')
      .upsert(members, { onConflict: 'group_id,user_id' })

    return NextResponse.json({ group: existing, existed: true })
  }

  const { data: group, error: groupError } = await adminClient
    .from('gw_groups')
    .insert({
      name: targetUser.id === user.id
        ? `${user.display_name} のメモ`
        : `${user.display_name} / ${targetUser.display_name}`,
      description: key,
      type: 'chat',
      icon: '💬',
      created_by: user.id,
    })
    .select('id')
    .single()

  if (groupError || !group) {
    return NextResponse.json({ error: groupError?.message || '個人Chatの作成に失敗しました' }, { status: 500 })
  }

  const { error: memberError } = await adminClient
    .from('gw_group_members')
    .insert(targetUser.id === user.id
      ? [{ group_id: group.id, user_id: user.id, role: 'member' }]
      : [
        { group_id: group.id, user_id: user.id, role: 'member' },
        { group_id: group.id, user_id: targetUser.id, role: 'member' },
      ])

  if (memberError) {
    await adminClient.from('gw_groups').delete().eq('id', group.id)
    return NextResponse.json({ error: memberError.message }, { status: 500 })
  }

  return NextResponse.json({ group, existed: false }, { status: 201 })
}
