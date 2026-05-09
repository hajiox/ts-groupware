import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

/**
 * GET /api/groups — 自分が参加しているグループ一覧
 * POST /api/groups — グループ新規作成
 */

export async function GET() {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  // 自分が参加しているグループを取得
  const { data: memberships } = await adminClient
    .from('gw_group_members')
    .select('group_id')
    .eq('user_id', user.id)

  const groupIds = memberships?.map(m => m.group_id) || []

  if (groupIds.length === 0) {
    return NextResponse.json({ groups: [] })
  }

  // グループ情報取得 + 最新投稿
  const { data: groups } = await adminClient
    .from('gw_groups')
    .select('*')
    .in('id', groupIds)
    .order('updated_at', { ascending: false })

  // 各グループの最新投稿と未読数を取得
  const enrichedGroups = await Promise.all(
    (groups || []).map(async (group) => {
      // 最新投稿
      const { data: latestPost } = await adminClient
        .from('gw_posts')
        .select('content, created_at')
        .eq('group_id', group.id)
        .is('parent_id', null) // コメントを除外
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      // 既読管理から未読数を計算
      const { data: readStatus } = await adminClient
        .from('gw_read_status')
        .select('last_read_at')
        .eq('user_id', user.id)
        .eq('group_id', group.id)
        .single()

      let unreadCount = 0
      if (readStatus?.last_read_at) {
        const { count } = await adminClient
          .from('gw_posts')
          .select('id', { count: 'exact', head: true })
          .eq('group_id', group.id)
          .is('parent_id', null)
          .gt('created_at', readStatus.last_read_at)
        unreadCount = count || 0
      }

      return {
        ...group,
        lastMessage: latestPost?.content?.slice(0, 50) || '',
        lastMessageAt: latestPost?.created_at || group.created_at,
        unread: unreadCount,
      }
    })
  )

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

  // グループ作成
  const { data: group, error } = await adminClient
    .from('gw_groups')
    .insert({
      name: name.trim(),
      description: description || null,
      type: type || 'board',
      icon: icon || '📢',
      created_by: user.id,
    })
    .select()
    .single()

  if (error || !group) {
    return NextResponse.json({ error: error?.message || '作成失敗' }, { status: 500 })
  }

  // 作成者をメンバーに追加（admin）
  await adminClient
    .from('gw_group_members')
    .insert({
      group_id: group.id,
      user_id: user.id,
      role: 'admin',
    })

  return NextResponse.json({ group }, { status: 201 })
}
