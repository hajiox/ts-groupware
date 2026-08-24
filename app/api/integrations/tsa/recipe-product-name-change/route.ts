import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getTsgUserId } from '@/lib/tsg-ai'
import {
  buildRecipeProductNameBatchChangeContent,
  buildRecipeProductNameChangeContent,
  recipeProductNameChangePostId,
  requiredProductNameText,
} from '@/lib/recipe-product-name-change-post'

const GROUP_NAMES = ['NEWブランド館（フロア）', 'NEWブランド館(フロア)']

function bearer(request: NextRequest) {
  const value = request.headers.get('authorization') || ''
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : ''
}

function authorize(request: NextRequest) {
  const expected = process.env.TSG_INTEGRATION_SECRET?.trim()
  if (!expected) return NextResponse.json({ error: 'TSG_INTEGRATION_SECRET is not configured' }, { status: 500 })
  const actual = request.headers.get('x-tsg-integration-secret')?.trim() || bearer(request)
  return actual === expected ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

function normalized(value: string) {
  return value.replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').toLowerCase()
}

async function targetGroup() {
  const configured = process.env.TSG_RECIPE_PRODUCT_NAME_GROUP_NAME?.trim()
    || process.env.TSG_RECIPE_PRICE_GROUP_NAME?.trim()
  const targets = new Set([...(configured ? [configured] : []), ...GROUP_NAMES].map(normalized))
  const { data, error } = await adminClient.from('gw_groups').select('id,name,type').eq('type', 'board')
  if (error) throw new Error(error.message)
  const groups = data || []
  const exact = groups.find(group => targets.has(normalized(group.name)))
  if (exact) return exact
  const fuzzy = groups.find(group => {
    const name = normalized(group.name)
    return name.includes('new') && name.includes('ブランド館') && name.includes('フロア')
  })
  if (fuzzy) return fuzzy
  throw new Error('Target board was not found')
}

export async function POST(request: NextRequest) {
  const authError = authorize(request)
  if (authError) return authError
  try {
    const raw = await request.json()
    const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const sourceKey = requiredProductNameText(body.sourceKey, 'sourceKey', 200)
    if (!/^[A-Za-z0-9:_-]+$/.test(sourceKey)) return NextResponse.json({ error: 'sourceKey is invalid' }, { status: 400 })
    const content = Array.isArray(body.items)
      ? buildRecipeProductNameBatchChangeContent(body, sourceKey)
      : buildRecipeProductNameChangeContent(body, sourceKey)
    const group = await targetGroup()
    const userId = await getTsgUserId()
    if (!userId) throw new Error('TSG君 user was not found')
    const postId = recipeProductNameChangePostId(sourceKey)
    const { data: existing, error: existingError } = await adminClient
      .from('gw_posts').select('id,group_id,user_id,content,created_at').eq('id', postId).maybeSingle()
    if (existingError) throw new Error(existingError.message)
    let post = existing
    let duplicate = Boolean(post)
    if (post && (post.group_id !== group.id || post.user_id !== userId || post.content !== content)) {
      throw new Error('Integration post identity conflict')
    }
    if (!post) {
      const { data: inserted, error } = await adminClient.from('gw_posts').insert({
        id: postId, group_id: group.id, user_id: userId, content, attachments: [], parent_id: null,
      }).select('id,group_id,user_id,content,created_at').single()
      if (error?.code === '23505') {
        const concurrent = await adminClient.from('gw_posts').select('id,group_id,user_id,content,created_at').eq('id', postId).single()
        if (concurrent.error || !concurrent.data) throw new Error(concurrent.error?.message || 'Concurrent post was not found')
        post = concurrent.data
        duplicate = true
      } else if (error || !inserted) throw new Error(error?.message || 'Failed to create product name post')
      else {
        post = inserted
        duplicate = false
        await adminClient.from('gw_groups').update({ updated_at: new Date().toISOString() }).eq('id', group.id)
      }
    }
    if (!post || post.group_id !== group.id || post.user_id !== userId || post.content !== content) {
      throw new Error('Integration post identity conflict')
    }
    if (!duplicate) {
      await import('@/lib/web-push').then(({ sendPushNotificationToGroup }) =>
        sendPushNotificationToGroup(group.id, userId, {
          title: `${group.name} - TSG君`, body: content.substring(0, 80),
          url: `/board/${group.id}#post-${post.id}`, tag: `tsg-tsa-recipe-product-name-${post.id}`,
        }, post.id)).catch(error => console.error('[TSA product name push error]', error))
    }
    return NextResponse.json({
      ok: true, duplicate, group: { id: group.id, name: group.name },
      poster: { id: userId, displayName: 'TSG君' }, post,
      url: `/board/${group.id}#post-${post.id}`,
    }, { status: duplicate ? 200 : 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create product name post'
    const status = message.endsWith(' is invalid') || message === 'product name was not changed' || message === 'recipeId is duplicated' ? 400 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
