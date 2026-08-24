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
  'TS（管理職）',
  'TS(管理職)',
  'ＴＳ（管理職）',
  'ＴＳ(管理職)',
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
    .replace(/Ｔ/g, 'T')
    .replace(/ｔ/g, 't')
    .replace(/Ｓ/g, 'S')
    .replace(/ｓ/g, 's')
    .toLowerCase()
}

async function getTargetGroup() {
  const configuredName = process.env.TSG_INDEED_APPLICATION_GROUP_NAME?.trim()
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
    return normalized.includes('ts') && normalized.includes('管理職')
  })
  if (fuzzy) return fuzzy

  throw new Error(`Target board was not found: ${targetNames[0]}`)
}

function getBodyString(body: Record<string, unknown>, key: string) {
  return typeof body[key] === 'string' ? String(body[key]).trim() : ''
}

function formatDateTime(value: unknown) {
  const raw = typeof value === 'string' ? value : ''
  const date = raw ? new Date(raw) : new Date()
  if (Number.isNaN(date.getTime())) return raw || new Date().toLocaleString('ja-JP')

  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function buildContent(body: Record<string, unknown>) {
  const sourceKey = getBodyString(body, 'sourceKey')
  const applicantName = getBodyString(body, 'applicantName') || '応募者名不明'
  const jobTitle = getBodyString(body, 'jobTitle') || '求人名不明'
  const jobLocation = getBodyString(body, 'jobLocation')
  const relatedExperience = getBodyString(body, 'relatedExperience')
  const detailUrl = getBodyString(body, 'detailUrl')

  return [
    '【Indeed応募通知】',
    'Indeedから新しい応募がありました。',
    '',
    `応募者: ${applicantName}`,
    `求人: ${jobTitle}`,
    jobLocation ? `勤務地: ${jobLocation}` : '',
    relatedExperience ? `関連経験: ${relatedExperience}` : '',
    `受信日時: ${formatDateTime(body.receivedAt)}`,
    detailUrl ? `応募内容を確認する: ${detailUrl}` : '応募内容を確認する: URLを取得できませんでした',
    sourceKey ? `通知ID: ${sourceKey}` : '',
  ].filter(Boolean).join('\n')
}

async function getExistingPost(groupId: string, userId: string, sourceKey: string, content: string) {
  if (sourceKey) {
    const { data, error } = await adminClient
      .from('gw_posts')
      .select('id, group_id, user_id, content, created_at')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .ilike('content', `%通知ID: ${sourceKey}%`)
      .is('parent_id', null)
      .order('created_at', { ascending: false })
      .limit(1)

    if (error) throw new Error(error.message)
    const existing = ((data || []) as PostRow[])[0]
    if (existing) return existing
  }

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
      { error: error instanceof Error ? error.message : 'Failed to load Indeed application integration status' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const authError = assertIntegrationSecret(request)
  if (authError) return authError

  try {
    const body = await request.json()
    const bodyObject = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    const sourceKey = getBodyString(bodyObject, 'sourceKey')
    const content = buildContent(bodyObject)

    const group = await getTargetGroup()
    const tsgUserId = await getTsgUserId()

    if (!tsgUserId) {
      return NextResponse.json({ error: 'TSG君 user was not found' }, { status: 500 })
    }

    const existingPost = await getExistingPost(group.id, tsgUserId, sourceKey, content)
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
        url: `/board/${group.id}#post-${existingPost.id}`,
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
      return NextResponse.json({ error: error?.message || 'Failed to create Indeed application post' }, { status: 500 })
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
        tag: `tsg-doc-scanner-indeed-application-${post.id}`,
      }, post.id))
      .catch(error => console.error('[DocScanner Indeed application push error]', error))

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
      url: `/board/${group.id}#post-${post.id}`,
    }, { status: 201 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create Indeed application post' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest) {
  const authError = assertIntegrationSecret(request)
  if (authError) return authError

  try {
    const body = await request.json().catch(() => ({}))
    const postId = typeof body.postId === 'string' ? body.postId.trim() : ''
    const sourceKey = typeof body.sourceKey === 'string' ? body.sourceKey.trim() : ''

    if (!postId && !sourceKey) {
      return NextResponse.json({ error: 'postId or sourceKey is required' }, { status: 400 })
    }

    const group = await getTargetGroup()
    const tsgUserId = await getTsgUserId()

    if (!tsgUserId) {
      return NextResponse.json({ error: 'TSG君 user was not found' }, { status: 500 })
    }

    let query = adminClient
      .from('gw_posts')
      .select('id, group_id, user_id, content, created_at')
      .eq('group_id', group.id)
      .eq('user_id', tsgUserId)
      .is('parent_id', null)

    query = postId
      ? query.eq('id', postId)
      : query.ilike('content', `%通知ID: ${sourceKey}%`)

    const { data: post, error: readError } = await query
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (readError) throw new Error(readError.message)
    if (!post) {
      return NextResponse.json({ ok: true, deleted: false, reason: 'not_found' })
    }

    const content = String(post.content || '')
    if (!content.includes('Indeed応募通知')) {
      return NextResponse.json({ error: 'Only Indeed application posts can be deleted by this integration' }, { status: 403 })
    }

    await adminClient.from('gw_reactions').delete().eq('post_id', post.id)
    await adminClient.from('gw_comments').delete().eq('post_id', post.id)
    await adminClient.from('gw_posts').delete().eq('parent_id', post.id)

    const { error: deleteError } = await adminClient
      .from('gw_posts')
      .delete()
      .eq('id', post.id)

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
      { error: error instanceof Error ? error.message : 'Failed to delete Indeed application post' },
      { status: 500 }
    )
  }
}
