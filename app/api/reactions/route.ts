import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

/**
 * POST /api/reactions — リアクション追加/トグル
 *
 * body: { post_id, emoji }
 * 既にリアクション済みの場合は削除（トグル動作）
 */

async function getPostAccess(postId: string, userId: string) {
  const { data: post } = await adminClient
    .from('gw_posts')
    .select('id, user_id, group_id, content, parent_id')
    .eq('id', postId)
    .single()

  if (!post) {
    return { post: null, error: '投稿が見つかりません', status: 404 }
  }

  const { data: membership } = await adminClient
    .from('gw_group_members')
    .select('role')
    .eq('group_id', post.group_id)
    .eq('user_id', userId)
    .maybeSingle()

  if (!membership) {
    return { post: null, error: 'このグループに参加していません', status: 403 }
  }

  return { post, error: null, status: 0 }
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json()
  const { post_id, emoji } = body

  if (!post_id || !emoji) {
    return NextResponse.json({ error: 'post_id と emoji が必要です' }, { status: 400 })
  }

  const access = await getPostAccess(post_id, user.id)
  if (access.error || !access.post) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  // 既存チェック
  const { data: existing } = await adminClient
    .from('gw_reactions')
    .select('id')
    .eq('post_id', post_id)
    .eq('user_id', user.id)
    .eq('emoji', emoji)
    .single()

  if (existing) {
    // 削除（トグルOFF）
    await adminClient
      .from('gw_reactions')
      .delete()
      .eq('id', existing.id)
    return NextResponse.json({ action: 'removed' })
  } else {
    // 追加（トグルON）
    const { error } = await adminClient
      .from('gw_reactions')
      .insert({
        post_id,
        user_id: user.id,
        emoji,
      })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const post = access.post
    if (post && post.user_id !== user.id) {
      await import('@/lib/web-push')
        .then(({ sendPushNotificationToUser }) => {
          const authorName = user.display_name || 'メンバー'
          return sendPushNotificationToUser(post.user_id, {
            title: `${authorName} がリアクションしました`,
            body: `${emoji} ${post.content ? post.content.substring(0, 40) : '投稿へのリアクション'}`,
            url: `/board/${post.group_id}`,
            tag: `tsg-reaction-${post_id}-${emoji}`,
          }, post.parent_id || post.id)
        })
        .catch(e => console.error('[Push Error]', e))
    }

    return NextResponse.json({ action: 'added' }, { status: 201 })
  }
}
