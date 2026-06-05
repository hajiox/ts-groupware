import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

/**
 * POST /api/reactions — リアクション追加/トグル
 *
 * body: { post_id, emoji }
 * 既にリアクション済みの場合は削除（トグル動作）
 */

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

    const { data: post } = await adminClient
      .from('gw_posts')
      .select('id, user_id, group_id, content, parent_id')
      .eq('id', post_id)
      .single()

    if (post && post.user_id !== user.id) {
      const { data: group } = await adminClient
        .from('gw_groups')
        .select('type')
        .eq('id', post.group_id)
        .single()
      const url = group?.type === 'chat' ? `/chat/${post.group_id}` : `/board/${post.group_id}`

      await import('@/lib/web-push')
        .then(({ sendPushNotificationToUser }) => {
          const authorName = user.display_name || 'メンバー'
          return sendPushNotificationToUser(post.user_id, {
            title: `${authorName} がリアクションしました`,
            body: `${emoji} ${post.content ? post.content.substring(0, 40) : '投稿へのリアクション'}`,
            url,
            tag: `tsg-reaction-${post_id}-${emoji}`,
          }, post.parent_id || post.id)
        })
        .catch(e => console.error('[Push Error]', e))
    }

    return NextResponse.json({ action: 'added' }, { status: 201 })
  }
}
