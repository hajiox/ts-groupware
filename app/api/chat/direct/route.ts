import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

function directChatKey(userIdA: string, userIdB: string) {
  return `direct:${[userIdA, userIdB].sort().join(':')}`
}

function getDirectChatMemberRows(groupId: string, userId: string, targetUserId: string) {
  return targetUserId === userId
    ? [{ group_id: groupId, user_id: userId, role: 'member' }]
    : [
      { group_id: groupId, user_id: userId, role: 'member' },
      { group_id: groupId, user_id: targetUserId, role: 'member' },
    ]
}

async function ensureDirectChatMembers(groupId: string, userId: string, targetUserId: string) {
  return adminClient
    .from('gw_group_members')
    .upsert(getDirectChatMemberRows(groupId, userId, targetUserId), { onConflict: 'group_id,user_id' })
}

function getSortTime(value: string | null | undefined) {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
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

  const normalizedUsers = (users || []).map(member => ({
    ...member,
    display_name: member.real_name || member.display_name,
    isSelf: member.id === user.id,
    isTsgAi: member.display_name === 'TSG君' || member.real_name === 'TSG君',
  }))

  const directKeys = normalizedUsers.map(member => directChatKey(user.id, member.id))
  const { data: directGroups } = directKeys.length > 0
    ? await adminClient
      .from('gw_groups')
      .select('id, description, created_at, updated_at')
      .eq('type', 'chat')
      .in('description', directKeys)
    : { data: [] }

  const groupByTargetUserId = new Map<string, { id: string; created_at: string | null; updated_at: string | null }>()
  for (const group of directGroups || []) {
    const parts = typeof group.description === 'string' ? group.description.split(':') : []
    if (parts.length < 3) continue
    const targetUserId = parts[1] === user.id ? parts[2] : parts[1]
    groupByTargetUserId.set(targetUserId, {
      id: group.id,
      created_at: group.created_at || null,
      updated_at: group.updated_at || null,
    })
  }

  const directGroupIds = [...groupByTargetUserId.values()].map(group => group.id)
  const { data: latestPosts } = directGroupIds.length > 0
    ? await adminClient
      .from('gw_posts')
      .select('group_id, created_at')
      .in('group_id', directGroupIds)
      .is('parent_id', null)
      .order('created_at', { ascending: false })
      .limit(Math.max(200, directGroupIds.length * 5))
    : { data: [] }

  const latestPostAtByGroupId = new Map<string, string>()
  for (const post of latestPosts || []) {
    if (!latestPostAtByGroupId.has(post.group_id)) {
      latestPostAtByGroupId.set(post.group_id, post.created_at)
    }
  }

  const enrichedUsers = normalizedUsers.map(member => {
    const group = groupByTargetUserId.get(member.id)
    const lastMessageAt = group
      ? latestPostAtByGroupId.get(group.id) || group.updated_at || group.created_at || null
      : null

    return {
      ...member,
      lastMessageAt,
    }
  })

  const sortedUsers = enrichedUsers.sort((a, b) => {
    const aRank = a.isSelf ? 0 : a.isTsgAi ? 1 : 2
    const bRank = b.isSelf ? 0 : b.isTsgAi ? 1 : 2
    if (aRank !== bRank) return aRank - bRank

    const aTime = getSortTime(a.lastMessageAt)
    const bTime = getSortTime(b.lastMessageAt)
    if (aTime !== bTime) return bTime - aTime

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
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (existing) {
    const { error: memberError } = await ensureDirectChatMembers(existing.id, user.id, targetUser.id)
    if (memberError) {
      return NextResponse.json({ error: memberError.message }, { status: 500 })
    }

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

  const { error: memberError } = await ensureDirectChatMembers(group.id, user.id, targetUser.id)

  if (memberError) {
    await adminClient.from('gw_groups').delete().eq('id', group.id)
    return NextResponse.json({ error: memberError.message }, { status: 500 })
  }

  return NextResponse.json({ group, existed: false }, { status: 201 })
}
