import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

/**
 * 管理者用グループ管理 API
 *
 * GET    /api/admin/groups — 全グループ一覧
 * DELETE /api/admin/groups — グループ削除
 */

async function requireAdmin() {
  const user = await getUserSession()
  if (!user) return { error: '認証が必要です', status: 401 }
  if (user.role !== 'admin') return { error: '管理者権限が必要です', status: 403 }
  return { error: null, status: 0 }
}

function isDirectChat(group: { type?: string; description?: string | null }) {
  return group.type === 'chat' && typeof group.description === 'string' && group.description.startsWith('direct:')
}

export async function GET() {
  const { error, status } = await requireAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const { data: groups, error: dbError } = await adminClient
    .from('gw_groups')
    .select('*')
    .order('updated_at', { ascending: false })

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ groups: (groups || []).filter(group => !isDirectChat(group)) })
}

export async function DELETE(request: NextRequest) {
  const { error, status } = await requireAdmin()
  if (error) return NextResponse.json({ error }, { status })

  const body = await request.json()
  const { group_id } = body

  if (!group_id) {
    return NextResponse.json({ error: 'group_id が必要です' }, { status: 400 })
  }

  // 関連データを削除
  await adminClient.from('gw_reactions').delete().in(
    'post_id',
    adminClient.from('gw_posts').select('id').eq('group_id', group_id).then(r => (r.data || []).map(p => p.id))
  ).catch(() => {})

  // 投稿を削除
  await adminClient.from('gw_posts').delete().eq('group_id', group_id)
  // 既読ステータスを削除
  await adminClient.from('gw_read_status').delete().eq('group_id', group_id)
  // メンバーシップを削除
  await adminClient.from('gw_group_members').delete().eq('group_id', group_id)
  // グループを削除
  const { error: dbError } = await adminClient.from('gw_groups').delete().eq('id', group_id)

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
