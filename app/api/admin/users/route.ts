import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

/**
 * 管理者用 API
 *
 * GET  /api/admin/users — 全ユーザー一覧
 * PUT  /api/admin/users — ユーザーの表示名・ロール・承認状態変更
 * DELETE /api/admin/users — ユーザー削除
 */

async function requireAdmin() {
  const user = await getUserSession()
  if (!user) return { error: '認証が必要です', status: 401, user: null }
  if (user.role !== 'admin') return { error: '管理者権限が必要です', status: 403, user: null }
  return { error: null, status: 0, user }
}

function isDirectChat(group: { type?: string; description?: string | null }) {
  return group.type === 'chat' && typeof group.description === 'string' && group.description.startsWith('direct:')
}

async function addAdminToAllRegularGroups(userId: string) {
  const { data: groups, error: groupsError } = await adminClient
    .from('gw_groups')
    .select('id, type, description')

  if (groupsError) {
    return groupsError
  }

  const rows = (groups || [])
    .filter(group => !isDirectChat(group))
    .map(group => ({
      group_id: group.id,
      user_id: userId,
      role: 'admin',
    }))

  if (rows.length === 0) {
    return null
  }

  const { error } = await adminClient
    .from('gw_group_members')
    .upsert(rows, { onConflict: 'group_id,user_id' })

  return error
}

export async function GET() {
  const { error, status } = await requireAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const { data: users, error: dbError } = await adminClient
    .from('gw_users')
    .select('id, display_name, real_name, picture_url, role, status, line_user_id, created_at, updated_at')
    .order('created_at', { ascending: true })

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ users: users || [] })
}

export async function PUT(request: NextRequest) {
  const { error, status, user } = await requireAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const body = await request.json()
  const { user_id, role, status: userStatus, display_name, real_name } = body

  if (!user_id) {
    return NextResponse.json({ error: 'user_id が必要です' }, { status: 400 })
  }

  if (!role && !userStatus && display_name === undefined && real_name === undefined) {
    return NextResponse.json({ error: '更新項目がありません' }, { status: 400 })
  }

  if (role && !['admin', 'member'].includes(role)) {
    return NextResponse.json({ error: 'role は admin または member です' }, { status: 400 })
  }

  if (userStatus && !['pending', 'approved', 'suspended'].includes(userStatus)) {
    return NextResponse.json({ error: 'status は pending, approved, suspended のいずれかです' }, { status: 400 })
  }

  if (display_name !== undefined) {
    const normalizedName = String(display_name).trim()
    if (!normalizedName) {
      return NextResponse.json({ error: '表示名を入力してください' }, { status: 400 })
    }
    if (normalizedName.length > 80) {
      return NextResponse.json({ error: '表示名は80文字以内で入力してください' }, { status: 400 })
    }
  }

  if (real_name !== undefined) {
    const normalizedRealName = real_name === null ? null : String(real_name).trim()
    if (normalizedRealName && normalizedRealName.length > 80) {
      return NextResponse.json({ error: '本名は80文字以内で入力してください' }, { status: 400 })
    }
  }

  if (user_id === user!.id && userStatus && userStatus !== 'approved') {
    return NextResponse.json({ error: '自分自身を未承認または停止にはできません' }, { status: 400 })
  }

  if (user_id === user!.id && role && role !== 'admin') {
    return NextResponse.json({ error: '自分自身の管理者権限は外せません' }, { status: 400 })
  }

  const { data: existingUser, error: existingUserError } = await adminClient
    .from('gw_users')
    .select('role, status')
    .eq('id', user_id)
    .single()

  if (existingUserError || !existingUser) {
    return NextResponse.json({ error: existingUserError?.message || 'ユーザーが見つかりません' }, { status: 404 })
  }

  const updates: Record<string, string | null> = {
    updated_at: new Date().toISOString(),
  }
  if (display_name !== undefined) updates.display_name = String(display_name).trim()
  if (real_name !== undefined) updates.real_name = real_name ? String(real_name).trim() : null
  if (role) updates.role = role
  if (userStatus) updates.status = userStatus

  const { error: dbError } = await adminClient
    .from('gw_users')
    .update(updates)
    .eq('id', user_id)

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  const nextRole = role || existingUser.role
  const nextStatus = userStatus || existingUser.status
  const becameApprovedAdmin = nextRole === 'admin'
    && nextStatus === 'approved'
    && (existingUser.role !== 'admin' || existingUser.status !== 'approved')

  if (becameApprovedAdmin) {
    const memberError = await addAdminToAllRegularGroups(user_id)
    if (memberError) {
      return NextResponse.json({ error: memberError.message }, { status: 500 })
    }
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
