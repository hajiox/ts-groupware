import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getTsgUserId } from '@/lib/tsg-ai'
import {
  OEM_CONSULTATION_BOARD_ID,
  oemConsultationNotification,
  oemConsultationNotificationPostId,
} from '@/lib/oem-consultation-notification'

type GroupRow = { id: string; name: string; type: string }
type PostRow = { id: string; group_id: string; user_id: string; content: string | null }

class IntegrationError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

function authorize(request: NextRequest) {
  const expected = process.env.OEM_CONSULTATION_INTEGRATION_SECRET?.trim()
  if (!expected) return json({ success: false, error: 'OEM consultation integration is not configured' }, 503)
  const authorization = request.headers.get('authorization') || ''
  const actual = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : ''
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  const valid = actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
  return valid ? null : json({ success: false, error: 'Unauthorized' }, 401)
}

async function getDestination() {
  const [{ data, error }, tsgUserId] = await Promise.all([
    adminClient.from('gw_groups').select('id,name,type')
      .eq('id', OEM_CONSULTATION_BOARD_ID).eq('type', 'board').maybeSingle(),
    getTsgUserId(),
  ])
  if (error || !data || !tsgUserId) throw new Error('OEM consultation destination is unavailable')
  return { group: data as GroupRow, tsgUserId }
}

function isMatching(post: PostRow, group: GroupRow, tsgUserId: string, content: string) {
  return post.group_id === group.id && post.user_id === tsgUserId && post.content === content
}

async function readInput(request: NextRequest) {
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
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown
  } catch {
    throw new IntegrationError('Request body must be valid JSON', 400)
  }
}

export async function POST(request: NextRequest) {
  const authError = authorize(request)
  if (authError) return authError
  try {
    const { sourceKey, content } = oemConsultationNotification(await readInput(request))
    const { group, tsgUserId } = await getDestination()
    const postId = oemConsultationNotificationPostId(sourceKey)
    const { data: existing, error: existingError } = await adminClient
      .from('gw_posts').select('id,group_id,user_id,content').eq('id', postId).maybeSingle()
    if (existingError) throw new Error('Could not read OEM consultation post')
    let post = existing as PostRow | null
    let duplicate = Boolean(post)
    if (post && !isMatching(post, group, tsgUserId, content)) {
      throw new IntegrationError('Integration message identity conflict', 409)
    }
    if (!post) {
      const { data: inserted, error: insertError } = await adminClient.from('gw_posts')
        .insert({ id: postId, group_id: group.id, user_id: tsgUserId, content, attachments: [], parent_id: null })
        .select('id,group_id,user_id,content').single()
      if (insertError?.code === '23505') {
        const concurrent = await adminClient.from('gw_posts')
          .select('id,group_id,user_id,content').eq('id', postId).single()
        if (concurrent.error || !concurrent.data) throw new Error('Could not read concurrent OEM consultation post')
        post = concurrent.data as PostRow
        duplicate = true
      } else if (insertError || !inserted) {
        throw new Error('Could not save OEM consultation post')
      } else {
        post = inserted as PostRow
        duplicate = false
        const { error } = await adminClient.from('gw_groups')
          .update({ updated_at: new Date().toISOString() }).eq('id', group.id)
        if (error) console.error('[OEM consultation notification] group timestamp update failed')
      }
    }
    if (!post || !isMatching(post, group, tsgUserId, content)) {
      throw new IntegrationError('Integration message identity conflict', 409)
    }
    if (!duplicate) {
      await import('@/lib/web-push')
        .then(({ sendPushNotificationToGroup }) => sendPushNotificationToGroup(group.id, tsgUserId, {
          title: `${group.name} - TSG君`,
          body: '新しいOEM見積もり相談を受け付けました。掲示板で確認してください。',
          url: `/board/${group.id}#post-${post.id}`,
          tag: `tsg-oem-consultation-${post.id}`,
        }, post.id))
        .catch(() => console.error('[OEM consultation notification] push attempt failed'))
    }
    return json({ success: true, postId: post.id, duplicate }, duplicate ? 200 : 201)
  } catch (error) {
    const status = error instanceof IntegrationError ? error.status
      : error instanceof Error && error.message.endsWith(' is invalid') ? 400 : 500
    // Storage errors can contain request values. Only a fixed diagnostic is logged.
    if (status === 500) console.error('[OEM consultation notification] request failed')
    return json({ success: false, error: status === 500 ? 'Failed to save OEM consultation notification'
      : error instanceof Error ? error.message : 'Invalid request' }, status)
  }
}

// The OEM outbox can verify destination and service credentials without posting.
export async function GET(request: NextRequest) {
  const authError = authorize(request)
  if (authError) return authError
  if (request.nextUrl.search) return json({ success: false, error: 'Query parameters are not supported' }, 400)
  try {
    const { group, tsgUserId } = await getDestination()
    return json({ success: true, group: { id: group.id, name: group.name }, poster: { id: tsgUserId, displayName: 'TSG君' } })
  } catch {
    return json({ success: false, error: 'OEM consultation destination is unavailable' }, 503)
  }
}
