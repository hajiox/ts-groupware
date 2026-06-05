import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getTsgUserId } from '@/lib/tsg-ai'

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
  'EC速報',
  'ＥＣ速報',
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
    .replace(/Ｅ/g, 'E')
    .replace(/ｅ/g, 'e')
    .replace(/Ｃ/g, 'C')
    .replace(/ｃ/g, 'c')
    .toLowerCase()
}

async function getTargetGroup() {
  const configuredName = process.env.TSG_EC_REPORT_GROUP_NAME?.trim()
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
    return normalized.includes('ec') && normalized.includes('速報')
  })
  if (fuzzy) return fuzzy

  throw new Error(`Target board was not found: ${targetNames[0]}`)
}

async function getExistingPost(groupId: string, userId: string, content: string) {
  const { data, error } = await adminClient
    .from('gw_posts')
    .select('id, group_id, user_id, content, created_at')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('content', content)
    .is('parent_id', null)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error) throw new Error(error.message)
  return ((data || []) as PostRow[])[0] || null
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
      group: {
        id: group.id,
        name: group.name,
      },
      poster: {
        id: tsgUserId,
        displayName: 'TSG君',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load EC report integration status' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const authError = assertIntegrationSecret(request)
  if (authError) return authError

  try {
    const body = await request.json()
    const content = typeof body.content === 'string' ? body.content : ''

    if (!content.trim()) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 })
    }

    const group = await getTargetGroup()
    const tsgUserId = await getTsgUserId()

    if (!tsgUserId) {
      return NextResponse.json({ error: 'TSG君 user was not found' }, { status: 500 })
    }

    const existingPost = await getExistingPost(group.id, tsgUserId, content)
    if (existingPost) {
      return NextResponse.json({
        ok: true,
        duplicate: true,
        group: {
          id: group.id,
          name: group.name,
        },
        poster: {
          id: tsgUserId,
          displayName: 'TSG君',
        },
        post: existingPost,
        url: `/board/${group.id}`,
      })
    }

    const { data: post, error } = await adminClient
      .from('gw_posts')
      .insert({
        group_id: group.id,
        user_id: tsgUserId,
        content,
        attachments: [],
        parent_id: null,
      })
      .select('id, group_id, user_id, content, created_at')
      .single()

    if (error || !post) {
      return NextResponse.json({ error: error?.message || 'Failed to create post' }, { status: 500 })
    }

    await adminClient
      .from('gw_groups')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', group.id)

    await import('@/lib/web-push')
      .then(({ sendPushNotificationToGroup }) => sendPushNotificationToGroup(group.id, tsgUserId, {
        title: `${group.name} - TSG君`,
        body: content.substring(0, 80),
        url: `/board/${group.id}#post-${post.id}`,
        tag: `tsg-doc-scanner-ec-report-${post.id}`,
      }, post.id))
      .catch(error => console.error('[DocScanner EC report push error]', error))

    return NextResponse.json({
      ok: true,
      duplicate: false,
      group: {
        id: group.id,
        name: group.name,
      },
      poster: {
        id: tsgUserId,
        displayName: 'TSG君',
      },
      post,
      url: `/board/${group.id}`,
    }, { status: 201 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create EC report post' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest) {
  const authError = assertIntegrationSecret(request)
  if (authError) return authError

  try {
    const body = await request.json().catch(() => ({}))
    const postId = typeof body.postId === 'string' ? body.postId : ''

    if (!postId) {
      return NextResponse.json({ error: 'postId is required' }, { status: 400 })
    }

    const group = await getTargetGroup()
    const tsgUserId = await getTsgUserId()

    if (!tsgUserId) {
      return NextResponse.json({ error: 'TSG君 user was not found' }, { status: 500 })
    }

    const { data: post, error: readError } = await adminClient
      .from('gw_posts')
      .select('id, group_id, user_id, content, created_at')
      .eq('id', postId)
      .eq('group_id', group.id)
      .eq('user_id', tsgUserId)
      .is('parent_id', null)
      .maybeSingle()

    if (readError) throw new Error(readError.message)
    if (!post) {
      return NextResponse.json({ ok: true, deleted: false, reason: 'not_found' })
    }

    const content = String(post.content || '')
    if (!content.includes('EC速報')) {
      return NextResponse.json({ error: 'Only EC report posts can be deleted by this integration' }, { status: 403 })
    }

    await adminClient.from('gw_reactions').delete().eq('post_id', postId)
    await adminClient.from('gw_comments').delete().eq('post_id', postId)

    const { error: deleteError } = await adminClient
      .from('gw_posts')
      .delete()
      .eq('id', postId)

    if (deleteError) throw new Error(deleteError.message)

    await adminClient
      .from('gw_groups')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', group.id)

    return NextResponse.json({
      ok: true,
      deleted: true,
      post: {
        id: post.id,
        created_at: post.created_at,
      },
      group: {
        id: group.id,
        name: group.name,
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete EC report post' },
      { status: 500 }
    )
  }
}
