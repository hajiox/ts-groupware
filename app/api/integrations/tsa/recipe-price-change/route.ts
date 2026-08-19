import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getTsgUserId } from '@/lib/tsg-ai'
import {
  buildRecipePriceChangeContent,
  recipePriceChangePostId,
  requiredRecipePriceText,
} from '@/lib/recipe-price-change-post'

type GroupRow = {
  id: string
  name: string
  type: string
}

type PostRow = {
  id: string
  group_id: string
  user_id: string
  content: string | null
  created_at: string
}

const DEFAULT_GROUP_NAMES = [
  'NEWブランド館（フロア）',
  'NEWブランド館(フロア)',
]

function getBearerToken(request: NextRequest) {
  const value = request.headers.get('authorization') || ''
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : ''
}

function assertIntegrationSecret(request: NextRequest) {
  const expected = process.env.TSG_INTEGRATION_SECRET?.trim()
  if (!expected) {
    return NextResponse.json({ error: 'TSG_INTEGRATION_SECRET is not configured' }, { status: 500 })
  }

  const actual = request.headers.get('x-tsg-integration-secret')?.trim() || getBearerToken(request)
  if (actual !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return null
}

function normalizeGroupName(name: string) {
  return name
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .toLowerCase()
}

async function getTargetGroup() {
  const configuredName = process.env.TSG_RECIPE_PRICE_GROUP_NAME?.trim()
  const targetNames = [...(configuredName ? [configuredName] : []), ...DEFAULT_GROUP_NAMES]
  const normalizedTargets = new Set(targetNames.map(normalizeGroupName))

  const { data: groups, error } = await adminClient
    .from('gw_groups')
    .select('id, name, type')
    .eq('type', 'board')

  if (error) throw new Error(error.message)

  const rows = (groups || []) as GroupRow[]
  const exact = rows.find(group => normalizedTargets.has(normalizeGroupName(group.name)))
  if (exact) return exact

  const fuzzy = rows.find(group => {
    const normalized = normalizeGroupName(group.name)
    return normalized.includes('new')
      && normalized.includes('ブランド館')
      && normalized.includes('フロア')
  })
  if (fuzzy) return fuzzy

  throw new Error(`Target board was not found: ${targetNames[0]}`)
}

export async function GET(request: NextRequest) {
  const authError = assertIntegrationSecret(request)
  if (authError) return authError

  try {
    const group = await getTargetGroup()
    const tsgUserId = await getTsgUserId()
    if (!tsgUserId) {
      return NextResponse.json({ error: 'TSG君 user was not found' }, { status: 500 })
    }
    return NextResponse.json({
      group: { id: group.id, name: group.name },
      poster: { id: tsgUserId, displayName: 'TSG君' },
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load recipe price integration status' },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  const authError = assertIntegrationSecret(request)
  if (authError) return authError

  try {
    const rawBody = await request.json()
    const body = rawBody && typeof rawBody === 'object'
      ? rawBody as Record<string, unknown>
      : {}
    const sourceKey = requiredRecipePriceText(body.sourceKey, 'sourceKey', 200)
    if (!/^[A-Za-z0-9:_-]+$/.test(sourceKey)) {
      return NextResponse.json({ error: 'sourceKey is invalid' }, { status: 400 })
    }
    const content = buildRecipePriceChangeContent(body, sourceKey)
    const group = await getTargetGroup()
    const tsgUserId = await getTsgUserId()
    if (!tsgUserId) {
      return NextResponse.json({ error: 'TSG君 user was not found' }, { status: 500 })
    }

    const postId = recipePriceChangePostId(sourceKey)
    const { data: existing, error: existingError } = await adminClient
      .from('gw_posts')
      .select('id, group_id, user_id, content, created_at')
      .eq('id', postId)
      .maybeSingle()
    if (existingError) throw new Error(existingError.message)

    let post = existing as PostRow | null
    let duplicate = Boolean(post)
    if (post && (post.group_id !== group.id || post.user_id !== tsgUserId || post.content !== content)) {
      throw new Error('Integration post identity conflict')
    }

    if (!post) {
      const { data: inserted, error: insertError } = await adminClient
        .from('gw_posts')
        .insert({
          id: postId,
          group_id: group.id,
          user_id: tsgUserId,
          content,
          attachments: [],
          parent_id: null,
        })
        .select('id, group_id, user_id, content, created_at')
        .single()
      if (insertError?.code === '23505') {
        const { data: concurrent, error: concurrentError } = await adminClient
          .from('gw_posts')
          .select('id, group_id, user_id, content, created_at')
          .eq('id', postId)
          .single()
        if (concurrentError || !concurrent) {
          throw new Error(concurrentError?.message || 'Concurrent integration post was not found')
        }
        post = concurrent as PostRow
        duplicate = true
      } else if (insertError || !inserted) {
        throw new Error(insertError?.message || 'Failed to create recipe price post')
      } else {
        post = inserted as PostRow
        duplicate = false
        await adminClient
          .from('gw_groups')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', group.id)
      }
    }

    if (!post) throw new Error('Integration post was not returned')
    if (post.group_id !== group.id || post.user_id !== tsgUserId || post.content !== content) {
      throw new Error('Integration post identity conflict')
    }

    if (!duplicate) {
      await import('@/lib/web-push')
        .then(({ sendPushNotificationToGroup }) => sendPushNotificationToGroup(group.id, tsgUserId, {
          title: `${group.name} - TSG君`,
          body: content.substring(0, 80),
          url: `/board/${group.id}#post-${post.id}`,
          tag: `tsg-tsa-recipe-price-${post.id}`,
        }, post.id))
        .catch(error => console.error('[TSA recipe price push error]', error))
    }

    return NextResponse.json({
      ok: true,
      duplicate,
      group: { id: group.id, name: group.name },
      poster: { id: tsgUserId, displayName: 'TSG君' },
      post,
      url: `/board/${group.id}#post-${post.id}`,
    }, { status: duplicate ? 200 : 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create recipe price post'
    const status = message.endsWith(' is invalid') || message === 'price was not changed' ? 400 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
