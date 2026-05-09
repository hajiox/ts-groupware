import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getUserSession } from '@/lib/session'

/**
 * GET /api/posts?group_id=xxx — 投稿一覧取得
 * POST /api/posts — 新規投稿作成
 */

export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const groupId = request.nextUrl.searchParams.get('group_id')
  if (!groupId) {
    return NextResponse.json({ error: 'group_id が必要です' }, { status: 400 })
  }

  const parentOnly = request.nextUrl.searchParams.get('parent_only') !== 'false'
  const limit = parseInt(request.nextUrl.searchParams.get('limit') || '50')

  let query = adminClient
    .from('gw_posts')
    .select('*')
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (parentOnly) {
    query = query.is('parent_id', null)
  }

  const { data: posts, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!posts?.length) {
    adminClient
      .from('gw_read_status')
      .upsert({
        user_id: user.id,
        group_id: groupId,
        last_read_at: new Date().toISOString(),
      }, { onConflict: 'user_id,group_id' })
      .then(undefined, e => console.error('[Read status update error]', e))

    return NextResponse.json({ posts: [] })
  }

  // ユーザー情報を取得
  const userIds = [...new Set((posts || []).map(p => p.user_id))]
  const postIds = (posts || []).map(p => p.id)
  const [{ data: users }, { data: reactions }, { data: commentCounts }] = await Promise.all([
    adminClient
      .from('gw_users')
      .select('id, display_name, picture_url')
      .in('id', userIds),
    adminClient
      .from('gw_reactions')
      .select('post_id, emoji, user_id')
      .in('post_id', postIds),
    adminClient
      .from('gw_posts')
      .select('parent_id')
      .in('parent_id', postIds),
  ])

  const userMap = Object.fromEntries((users || []).map(u => [u.id, u]))

  // リアクション集計
  const reactionMap: Record<string, Record<string, { count: number; hasOwn: boolean }>> = {}
  for (const r of reactions || []) {
    if (!reactionMap[r.post_id]) reactionMap[r.post_id] = {}
    if (!reactionMap[r.post_id][r.emoji]) reactionMap[r.post_id][r.emoji] = { count: 0, hasOwn: false }
    reactionMap[r.post_id][r.emoji].count++
    if (r.user_id === user.id) reactionMap[r.post_id][r.emoji].hasOwn = true
  }

  // コメント数集計
  const commentCountMap: Record<string, number> = {}
  for (const c of commentCounts || []) {
    if (c.parent_id) {
      commentCountMap[c.parent_id] = (commentCountMap[c.parent_id] || 0) + 1
    }
  }

  // 既読更新
  adminClient
    .from('gw_read_status')
    .upsert({
      user_id: user.id,
      group_id: groupId,
      last_read_at: new Date().toISOString(),
    }, { onConflict: 'user_id,group_id' })
    .then(undefined, e => console.error('[Read status update error]', e))

  const enrichedPosts = (posts || []).map(post => ({
    ...post,
    author: userMap[post.user_id] || { display_name: '不明', picture_url: null },
    reactions: reactionMap[post.id] || {},
    commentCount: commentCountMap[post.id] || 0,
  }))

  return NextResponse.json({ posts: enrichedPosts })
}

export async function POST(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const body = await request.json()
  const { group_id, content, attachments, parent_id } = body

  if (!group_id) {
    return NextResponse.json({ error: 'group_id が必要です' }, { status: 400 })
  }
  if (!content?.trim() && (!attachments || attachments.length === 0)) {
    return NextResponse.json({ error: '内容が必要です' }, { status: 400 })
  }

  const { data: post, error } = await adminClient
    .from('gw_posts')
    .insert({
      group_id,
      user_id: user.id,
      content: content?.trim() || null,
      attachments: attachments || [],
      parent_id: parent_id || null,
    })
    .select()
    .single()

  if (error || !post) {
    return NextResponse.json({ error: error?.message || '投稿失敗' }, { status: 500 })
  }

  const [{ data: group }] = await Promise.all([
    adminClient
      .from('gw_groups')
      .select('name')
      .eq('id', group_id)
      .single(),
    adminClient
      .from('gw_groups')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', group_id),
  ])

  import('@/lib/web-push')
    .then(({ sendPushNotificationToGroup }) => {
      const authorName = user.display_name || 'メンバー'
      const messageBody = content?.trim() ? content.trim().substring(0, 50) : 'ファイルを送信しました'

      return sendPushNotificationToGroup(group_id, user.id, {
        title: group?.name ? `${group.name} - ${authorName}` : authorName,
        body: messageBody,
        url: `/board/${group_id}`,
      })
    })
    .catch(e => console.error('[Push Error]', e))

  return NextResponse.json({
    post: {
      ...post,
      author: {
        id: user.id,
        display_name: user.display_name,
        picture_url: user.picture_url,
      },
      reactions: {},
      commentCount: 0,
    },
  }, { status: 201 })
}
