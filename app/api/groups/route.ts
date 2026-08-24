import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'
import { isManagementUser } from '@/lib/user-roles'
import { getUnreadCountsByGroup } from '@/lib/unread'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, no-cache, max-age=0, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
  Vary: 'Cookie',
}

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: PRIVATE_NO_STORE_HEADERS,
  })
}

/**
 * GET /api/groups — 自分が参加しているグループ一覧
 * POST /api/groups — グループ新規作成
 */

function isDirectChat(group: { type?: string; description?: string | null }) {
  return group.type === 'chat' && typeof group.description === 'string' && group.description.startsWith('direct:')
}

function isAllStaffGroupName(name: string) {
  const normalized = name.replace(/\s+/g, '')
  return normalized.includes('オールスタッフ') || normalized.includes('全スタッフ')
}

export async function GET() {
  const user = await getUserSession()
  if (!user) {
    return noStoreJson({ error: '認証が必要です' }, 401)
  }

  const { data: memberships } = await adminClient
    .from('gw_group_members')
    .select('group_id')
    .eq('user_id', user.id)

  const explicitGroupIds = memberships?.map(m => m.group_id) || []

  if (explicitGroupIds.length === 0) {
    return noStoreJson({ groups: [] })
  }

  const { data: rawGroups } = await adminClient
    .from('gw_groups')
    .select('*')
    .in('id', explicitGroupIds)
    .order('updated_at', { ascending: false })
  const groups = (rawGroups || []).filter(group => !isDirectChat(group))
  const groupIds = groups.map(group => group.id)

  if (groupIds.length === 0) {
    return noStoreJson({ groups: [] })
  }

  const { data: groupMembers } = await adminClient
    .from('gw_group_members')
    .select('group_id, user_id')
    .in('group_id', groupIds)

  const explicitGroupIdSet = new Set(explicitGroupIds)
  const directOtherUserIds = groups
    .filter(group => isDirectChat(group))
    .filter(group => explicitGroupIdSet.has(group.id))
    .map(group => (groupMembers || []).find(member => member.group_id === group.id && member.user_id !== user.id)?.user_id)
    .filter(Boolean)

  const { data: directUsers } = directOtherUserIds.length > 0
    ? await adminClient
      .from('gw_users')
      .select('id, display_name, real_name, picture_url')
      .in('id', directOtherUserIds)
    : { data: [] }

  const directUserMap = Object.fromEntries((directUsers || []).map(directUser => [
    directUser.id, 
    { ...directUser, display_name: directUser.real_name || directUser.display_name }
  ]))

  const [{ data: allPosts }, unreadMap] = await Promise.all([
    // 最新投稿を新しい順に取得（各グループの最新1件抽出用）
    // limit制限で全件スキャンを回避
    adminClient
      .from('gw_posts')
      .select('group_id, content, created_at')
      .in('group_id', groupIds)
      .is('parent_id', null)
      .order('created_at', { ascending: false })
      .limit(groupIds.length * 3),
    getUnreadCountsByGroup(user.id, groupIds),
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

  return noStoreJson({ groups: enrichedGroups })
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  // 役員・管理者のみグループ作成可
  if (!isManagementUser(user)) {
    return NextResponse.json({ error: '役員または管理者のみグループを作成できます' }, { status: 403 })
  }

  const body = await request.json()
  const { name, description, type, icon } = body

  if (!name?.trim()) {
    return NextResponse.json({ error: 'グループ名は必須です' }, { status: 400 })
  }

  const trimmedName = name.trim()
  const addAllMembers = Boolean(body.add_all_members || body.addAllMembers || isAllStaffGroupName(trimmedName))

  // チャットタイプはアイコン💬固定
  const resolvedType = type || 'board'
  const resolvedIcon = resolvedType === 'chat' ? '💬' : (icon || '📢')

  // グループ作成
  const { data: group, error } = await adminClient
    .from('gw_groups')
    .insert({
      name: trimmedName,
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

  let memberRows = [{
    group_id: group.id,
    user_id: user.id,
    role: 'admin',
  }]

  if (addAllMembers) {
    const { data: approvedUsers, error: usersError } = await adminClient
      .from('gw_users')
      .select('id, role')
      .or('status.eq.approved,status.is.null')

    if (usersError) {
      await adminClient.from('gw_groups').delete().eq('id', group.id)
      return NextResponse.json({ error: usersError.message }, { status: 500 })
    }

    memberRows = (approvedUsers || []).map(approvedUser => ({
      group_id: group.id,
      user_id: approvedUser.id,
      role: approvedUser.id === user.id ? 'admin' : 'member',
    }))
  }

  // 作成者、または全スタッフ指定時は承認済みユーザー全員をメンバーに追加
  const { error: memberError } = await adminClient
    .from('gw_group_members')
    .upsert(memberRows, { onConflict: 'group_id,user_id' })

  if (memberError) {
    await adminClient.from('gw_groups').delete().eq('id', group.id)
    return NextResponse.json({ error: memberError.message }, { status: 500 })
  }

  return NextResponse.json({ group: { ...group, memberCount: memberRows.length } }, { status: 201 })
}
