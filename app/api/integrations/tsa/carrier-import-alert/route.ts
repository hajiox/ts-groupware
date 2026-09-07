import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getTsgUserId } from '@/lib/tsg-ai'
import {
  normalizeManagementBoardName,
} from '@/lib/meeting-transcriber-summary'
import { carrierImportAlert, carrierImportAlertPostId } from '@/lib/carrier-import-alert'

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

class IntegrationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

const MANAGEMENT_BOARD_NAME = 'TS（管理職）'
const NORMALIZED_MANAGEMENT_BOARD_NAME = normalizeManagementBoardName(MANAGEMENT_BOARD_NAME)

function getBearerToken(request: NextRequest) {
  const value = request.headers.get('authorization') || ''
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : ''
}

function authorize(request: NextRequest) {
  const expected = process.env.TSG_INTEGRATION_SECRET?.trim()
  if (!expected) {
    return NextResponse.json({ error: 'Carrier import alert integration is not configured' }, { status: 500 })
  }

  const actual = request.headers.get('x-tsg-integration-secret')?.trim() || getBearerToken(request)
  return actual === expected ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

async function getManagementBoard() {
  const { data, error } = await adminClient
    .from('gw_groups')
    .select('id,name,type')
    .eq('type', 'board')

  if (error) throw new Error(error.message)

  const matches = ((data || []) as GroupRow[]).filter(
    group => normalizeManagementBoardName(group.name) === NORMALIZED_MANAGEMENT_BOARD_NAME,
  )
  if (matches.length !== 1) {
    throw new IntegrationError(`Management board must resolve exactly once (matched ${matches.length})`, 409)
  }
  return matches[0]
}

function isMatchingPost(post: PostRow, groupId: string, tsgUserId: string, content: string) {
  return post.group_id === groupId && post.user_id === tsgUserId && post.content === content
}

export async function POST(request: NextRequest) {
  const authError = authorize(request)
  if (authError) return authError

  try {
    const reader = request.body?.getReader()
    if (!reader) throw new IntegrationError('Request body must be valid JSON', 400)
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 4096) {
        await reader.cancel()
        throw new IntegrationError('Request body is too large', 413)
      }
      chunks.push(value)
    }
    let raw: unknown
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new IntegrationError('Request body must be valid JSON', 400) }
    const { sourceKey, content } = carrierImportAlert(raw)

    const [group, tsgUserId] = await Promise.all([
      getManagementBoard(),
      getTsgUserId(),
    ])
    if (!tsgUserId) throw new Error('TSG君 user was not found')

    const postId = carrierImportAlertPostId(sourceKey)
    const { data: existing, error: existingError } = await adminClient
      .from('gw_posts')
      .select('id,group_id,user_id,content,created_at')
      .eq('id', postId)
      .maybeSingle()
    if (existingError) throw new Error(existingError.message)

    let post = existing as PostRow | null
    let duplicate = Boolean(post)
    if (post && !isMatchingPost(post, group.id, tsgUserId, content)) {
      throw new IntegrationError('Integration message identity conflict', 409)
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
        .select('id,group_id,user_id,content,created_at')
        .single()

      if (insertError?.code === '23505') {
        const concurrent = await adminClient
          .from('gw_posts')
          .select('id,group_id,user_id,content,created_at')
          .eq('id', postId)
          .single()
        if (concurrent.error || !concurrent.data) {
          throw new Error(concurrent.error?.message || 'Concurrent carrier import alert was not found')
        }
        post = concurrent.data as PostRow
        duplicate = true
      } else if (insertError || !inserted) {
        throw new Error(insertError?.message || 'Failed to create carrier import alert post')
      } else {
        post = inserted as PostRow
        duplicate = false
        const { error: groupUpdateError } = await adminClient
          .from('gw_groups')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', group.id)
        if (groupUpdateError) {
          console.error('[Carrier import alert summary group timestamp error]', groupUpdateError)
        }
      }
    }

    if (!post || !isMatchingPost(post, group.id, tsgUserId, content)) {
      throw new IntegrationError('Integration message identity conflict', 409)
    }

    if (!duplicate) {
      await import('@/lib/web-push')
        .then(({ sendPushNotificationToGroup }) => sendPushNotificationToGroup(group.id, tsgUserId, {
          title: `${group.name} - TSG君`,
          body: content.substring(0, 80),
          url: `/board/${group.id}#post-${post.id}`,
          tag: `tsg-carrier-import-alert-${post.id}`,
        }, post.id))
        .catch(error => console.error('[Carrier import alert summary push error]', error))
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
    const status = error instanceof IntegrationError
      ? error.status
      : error instanceof Error && error.message.endsWith(' is invalid')
        ? 400
        : 500
    if (status === 500) {
      console.error('[Carrier import alert summary integration error]', error)
    }
    return NextResponse.json({
      error: status === 500
        ? 'Failed to create carrier import alert post'
        : error instanceof Error
          ? error.message
          : 'Failed to create carrier import alert post',
    }, { status })
  }
}

// Read-only readiness check for the local application's delivery outbox.
export async function GET(request: NextRequest) {
  const authError = authorize(request)
  if (authError) return authError
  try {
    const [group, tsgUserId] = await Promise.all([getManagementBoard(), getTsgUserId()])
    if (!tsgUserId) throw new Error('TSG君 user was not found')
    return NextResponse.json({ ok: true, group: { name: group.name }, poster: { displayName: 'TSG君' } }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return NextResponse.json({ error: 'Carrier import alert destination is unavailable' }, {
      status: error instanceof IntegrationError ? error.status : 503,
    })
  }
}
