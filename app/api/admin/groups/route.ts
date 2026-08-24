import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'
import { isManagementUser } from '@/lib/user-roles'

/**
 * 管理者用グループ管理 API
 *
 * GET    /api/admin/groups — 管理対象の全グループ一覧
 * DELETE /api/admin/groups — グループ削除
 */

async function requireAdmin() {
  const user = await getUserSession()
  if (!user) return { error: '認証が必要です', status: 401 }
  if (!isManagementUser(user)) return { error: '役員または管理者権限が必要です', status: 403 }
  return { error: null, status: 0 }
}

function isDirectChat(group: { type?: string; description?: string | null }) {
  return group.type === 'chat'
    && typeof group.description === 'string'
    && group.description.startsWith('direct:')
}

export async function GET() {
  const { error, status } = await requireAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const { data, error: dbError } = await adminClient
    .from('gw_groups')
    .select('id, name, type, icon, description, created_at, updated_at')
    .order('updated_at', { ascending: false })

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ groups: (data || []).filter(group => !isDirectChat(group)) })
}

export async function DELETE(request: NextRequest) {
  const { error, status } = await requireAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const body = await request.json()
  const { group_id } = body

  if (!group_id) {
    return NextResponse.json({ error: 'group_id が必要です' }, { status: 400 })
  }

  const { data: group, error: groupError } = await adminClient
    .from('gw_groups')
    .select('id, type, description')
    .eq('id', group_id)
    .maybeSingle()

  if (groupError) {
    return NextResponse.json({ error: groupError.message }, { status: 500 })
  }
  if (!group) {
    return NextResponse.json({ error: 'グループが見つかりません' }, { status: 404 })
  }
  if (isDirectChat(group)) {
    return NextResponse.json({ error: 'DMはグループ管理から削除できません' }, { status: 400 })
  }

  // 関連テーブルは外部キーの ON DELETE CASCADE / SET NULL で整合性を保つ。
  const { error: dbError } = await adminClient
    .from('gw_groups')
    .delete()
    .eq('id', group_id)

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
