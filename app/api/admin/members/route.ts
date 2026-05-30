// /app/api/admin/members/route.ts ver.2
import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

/**
 * 管理者用グループメンバー管理 API
 *
 * GET    /api/admin/members?group_id=xxx — グループのメンバー一覧 + 非メンバー一覧
 * POST   /api/admin/members — メンバー追加
 * DELETE /api/admin/members — メンバー削除
 */

async function requireAdmin() {
  const user = await getUserSession()
  if (!user) return { error: '認証が必要です', status: 401, user: null }
  if (user.role !== 'admin') return { error: '管理者権限が必要です', status: 403, user: null }
  return { error: null, status: 0, user }
}

export async function GET(request: NextRequest) {
  const { error, status } = await requireAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const groupId = request.nextUrl.searchParams.get('group_id')
  if (!groupId) {
    return NextResponse.json({ error: 'group_id が必要です' }, { status: 400 })
  }

  // グループのメンバー一覧
  const { data: members, error: membersError } = await adminClient
    .from('gw_group_members')
    .select('user_id, role, joined_at')
    .eq('group_id', groupId)

  if (membersError) {
    return NextResponse.json({ error: membersError.message }, { status: 500 })
  }

  const memberByUserId = new Map((members || []).map(m => [m.user_id, m]))
  const explicitMemberUserIds = (members || []).map(m => m.user_id)

  // 全ユーザー
  const { data: allUsers, error: usersError } = await adminClient
    .from('gw_users')
    .select('id, display_name, real_name, picture_url, role, status')
    .eq('status', 'approved')
    .order('display_name', { ascending: true })

  if (usersError) {
    return NextResponse.json({ error: usersError.message }, { status: 500 })
  }

  // メンバーに含まれるユーザー / 含まれないユーザー
  const memberUsers = (allUsers || [])
    .filter(u => explicitMemberUserIds.includes(u.id))
    .map(u => ({
      ...u,
      display_name: u.real_name || u.display_name,
      group_role: memberByUserId.get(u.id)?.role || 'member',
    }))

  const nonMembers = (allUsers || [])
    .filter(u => !explicitMemberUserIds.includes(u.id))
    .map(u => ({ ...u, display_name: u.real_name || u.display_name }))

  return NextResponse.json({ members: memberUsers, nonMembers })
}

export async function POST(request: NextRequest) {
  const { error, status } = await requireAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const body = await request.json()
  const { group_id, user_ids } = body

  if (!group_id || !user_ids?.length) {
    return NextResponse.json({ error: 'group_id と user_ids が必要です' }, { status: 400 })
  }

  const { data: approvedUsers } = await adminClient
    .from('gw_users')
    .select('id, role')
    .in('id', user_ids)
    .eq('status', 'approved')

  const approvedUserById = new Map((approvedUsers || []).map(u => [u.id, u]))
  const approvedUserIds = new Set(approvedUserById.keys())
  if (approvedUserIds.size !== user_ids.length) {
    return NextResponse.json({ error: '未承認または停止中のユーザーはメンバーに追加できません' }, { status: 400 })
  }

  const inserts = user_ids.map((uid: string) => ({
    group_id,
    user_id: uid,
    role: approvedUserById.get(uid)?.role === 'admin' ? 'admin' : 'member',
  }))

  const { error: dbError } = await adminClient
    .from('gw_group_members')
    .upsert(inserts, { onConflict: 'group_id,user_id' })

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

export async function DELETE(request: NextRequest) {
  const { error, status } = await requireAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const body = await request.json()
  const { group_id, user_id } = body

  if (!group_id || !user_id) {
    return NextResponse.json({ error: 'group_id と user_id が必要です' }, { status: 400 })
  }

  const { error: dbError } = await adminClient
    .from('gw_group_members')
    .delete()
    .eq('group_id', group_id)
    .eq('user_id', user_id)

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
