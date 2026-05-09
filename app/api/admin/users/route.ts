import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

/**
 * 管理者用 API
 *
 * GET  /api/admin/users — 全ユーザー一覧
 * PUT  /api/admin/users — ユーザーのロール変更
 * DELETE /api/admin/users — ユーザー削除
 */

async function requireAdmin() {
  const user = await getUserSession()
  if (!user) return { error: '認証が必要です', status: 401, user: null }
  if (user.role !== 'admin') return { error: '管理者権限が必要です', status: 403, user: null }
  return { error: null, status: 0, user }
}

export async function GET() {
  const { error, status } = await requireAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const { data: users, error: dbError } = await adminClient
    .from('gw_users')
    .select('id, display_name, picture_url, role, line_user_id, created_at, updated_at')
    .order('created_at', { ascending: true })

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ users: users || [] })
}

export async function PUT(request: NextRequest) {
  const { error, status } = await requireAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const body = await request.json()
  const { user_id, role } = body

  if (!user_id || !role) {
    return NextResponse.json({ error: 'user_id と role が必要です' }, { status: 400 })
  }

  if (!['admin', 'member'].includes(role)) {
    return NextResponse.json({ error: 'role は admin または member です' }, { status: 400 })
  }

  const { error: dbError } = await adminClient
    .from('gw_users')
    .update({ role, updated_at: new Date().toISOString() })
    .eq('id', user_id)

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

export async function DELETE(request: NextRequest) {
  const { error, status, user } = await requireAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const body = await request.json()
  const { user_id } = body

  if (!user_id) {
    return NextResponse.json({ error: 'user_id が必要です' }, { status: 400 })
  }

  // 自分自身は削除不可
  if (user_id === user!.id) {
    return NextResponse.json({ error: '自分自身は削除できません' }, { status: 400 })
  }

  // グループメンバーシップを削除
  await adminClient.from('gw_group_members').delete().eq('user_id', user_id)
  // リアクションを削除
  await adminClient.from('gw_reactions').delete().eq('user_id', user_id)
  // 既読ステータスを削除
  await adminClient.from('gw_read_status').delete().eq('user_id', user_id)
  // Push購読を削除
  await adminClient.from('gw_push_subscriptions').delete().eq('user_id', user_id)
  // ユーザーを削除
  const { error: dbError } = await adminClient.from('gw_users').delete().eq('id', user_id)

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
