import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

function directChatKey(userIdA: string, userIdB: string) {
  return `direct:${[userIdA, userIdB].sort().join(':')}`
}

export async function GET() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const { data: users, error } = await adminClient
    .from('gw_users')
    .select('id, display_name, picture_url, role')
    .eq('status', 'approved')
    .order('display_name', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const sortedUsers = (users || []).sort((a, b) => {
    if (a.id === user.id) return -1
    if (b.id === user.id) return 1
    return a.display_name.localeCompare(b.display_name, 'ja')
  })

  return NextResponse.json({
    users: sortedUsers.map(member => ({
      ...member,
      isSelf: member.id === user.id,
    })),
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
    .select('id, display_name, picture_url, status')
    .eq('id', targetUserId)
    .eq('status', 'approved')
    .single()

  if (targetError || !targetUser) {
    return NextResponse.json({ error: '相手ユーザーが見つかりません' }, { status: 404 })
  }

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
