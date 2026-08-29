import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getTsgUserId } from '@/lib/tsg-ai'
import {
  meetingTranscriberSelfDmChatKey,
  meetingTranscriberSelfDmPostId,
  normalizeMeetingTranscriberDmName,
  requiredMeetingTranscriberDmText,
} from '@/lib/meeting-transcriber-self-dm'

type UserRow = {
  id: string
  display_name: string | null
  real_name: string | null
}

type GroupRow = {
  id: string
  description: string | null
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

function getBearerToken(request: NextRequest) {
  const value = request.headers.get('authorization') || ''
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : ''
}

function authorize(request: NextRequest) {
  const expected = process.env.MEETING_TRANSCRIBER_INTEGRATION_SECRET?.trim()
  if (!expected) {
    return NextResponse.json(
      { error: 'MeetingTranscriber integration is not configured' },
      { status: 500 },
    )
  }

  const actual = request.headers.get('x-tsg-integration-secret')?.trim() || getBearerToken(request)
  return actual === expected ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

async function findRecipient() {
  const configured = process.env.MEETING_TRANSCRIBER_DM_RECIPIENT_NAME?.trim()
  if (!configured) throw new IntegrationError('MeetingTranscriber DM recipient is not configured', 503)
  const target = normalizeMeetingTranscriberDmName(configured)
  const { data, error } = await adminClient
    .from('gw_users')
    .select('id,display_name,real_name')
    .eq('status', 'approved')
  if (error) throw new Error(error.message)
  const matches = ((data || []) as UserRow[]).filter(user =>
    normalizeMeetingTranscriberDmName(user.real_name || user.display_name || '') === target,
  )
  if (matches.length !== 1) {
    throw new IntegrationError(
      `Configured DM recipient must identify exactly one approved user (matched ${matches.length})`,
      409,
    )
  }
  return matches[0]
}

async function ensureDirectGroup(tsgUserId: string, recipient: UserRow) {
  const description = meetingTranscriberSelfDmChatKey(tsgUserId, recipient.id)
  const { data, error } = await adminClient
    .from('gw_groups')
    .select('id,description')
    .eq('type', 'chat')
    .eq('description', description)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  if ((data || []).length > 1) {
    throw new IntegrationError('Multiple direct-message groups exist for the same users', 409)
  }
  let group = ((data || []) as GroupRow[])[0] || null
  if (!group) {
    const displayName = recipient.real_name || recipient.display_name || 'メンバー'
    const created = await adminClient
      .from('gw_groups')
      .insert({
        name: `TSG君 / ${displayName}`,
        description,
        type: 'chat',
        icon: '💬',
        created_by: tsgUserId,
      })
      .select('id,description')
      .single()
    if (created.error || !created.data) {
      throw new Error(created.error?.message || 'Failed to create direct-message group')
    }
    group = created.data as GroupRow
  }
  const { error: memberError } = await adminClient
    .from('gw_group_members')
    .upsert([
      { group_id: group.id, user_id: tsgUserId, role: 'member' },
      { group_id: group.id, user_id: recipient.id, role: 'member' },
    ], { onConflict: 'group_id,user_id' })
  if (memberError) {
    throw new Error(memberError.message)
  }

  const members = await adminClient
    .from('gw_group_members')
    .select('user_id')
    .eq('group_id', group.id)
  if (members.error) {
    throw new Error(members.error.message)
  }

  const ids = new Set((members.data || []).map(row => row.user_id))
  if (ids.size !== 2 || !ids.has(tsgUserId) || !ids.has(recipient.id)) {
    throw new IntegrationError('Direct-message group member verification failed', 409)
  }
  return group
}

export async function POST(request: NextRequest) {
  const authError = authorize(request)
  if (authError) return authError
  try {
    const raw = await request.json().catch(() => {
      throw new IntegrationError('Request body must be valid JSON', 400)
    })
    const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const sourceKey = requiredMeetingTranscriberDmText(body.sourceKey, 'sourceKey', 200)
    const content = requiredMeetingTranscriberDmText(body.content, 'content', 4000)
    if (!/^[A-Za-z0-9:_-]+$/.test(sourceKey)) {
      throw new IntegrationError('sourceKey is invalid', 400)
    }
    const [recipient, tsgUserId] = await Promise.all([findRecipient(), getTsgUserId()])
    if (!tsgUserId) throw new Error('TSG君 user was not found')
    if (recipient.id === tsgUserId) {
      throw new IntegrationError('Configured DM recipient cannot be TSG君', 400)
    }
    const group = await ensureDirectGroup(tsgUserId, recipient)
    const postId = meetingTranscriberSelfDmPostId(sourceKey, recipient.id)
    const existingResult = await adminClient
      .from('gw_posts')
      .select('id,group_id,user_id,content,created_at')
      .eq('id', postId)
      .maybeSingle()
    if (existingResult.error) {
      throw new Error(existingResult.error.message)
    }

    let post = existingResult.data as PostRow | null
    let duplicate = Boolean(post)
    const matches = (candidate: PostRow) =>
      candidate.group_id === group.id && candidate.user_id === tsgUserId && candidate.content === content
    if (post && !matches(post)) {
      throw new IntegrationError('Integration message identity conflict', 409)
    }

    if (!post) {
      const inserted = await adminClient
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
      if (inserted.error?.code === '23505') {
        const concurrent = await adminClient
          .from('gw_posts')
          .select('id,group_id,user_id,content,created_at')
          .eq('id', postId)
          .single()
        if (concurrent.error || !concurrent.data) {
          throw new Error(concurrent.error?.message || 'Concurrent direct message was not found')
        }
        post = concurrent.data as PostRow
        duplicate = true
      } else if (inserted.error || !inserted.data) {
        throw new Error(inserted.error?.message || 'Failed to create direct message')
      } else {
        post = inserted.data as PostRow
        duplicate = false
        const update = await adminClient
          .from('gw_groups')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', group.id)
        if (update.error) {
          console.error('[MeetingTranscriber self-DM group timestamp error]', update.error)
        }
      }
    }
    if (!post || !matches(post)) {
      throw new IntegrationError('Integration message identity conflict', 409)
    }

    if (!duplicate) {
      await import('@/lib/web-push')
        .then(({ sendPushNotificationToUser }) => sendPushNotificationToUser(recipient.id, {
          title: 'TSG君',
          body: content.substring(0, 80),
          url: `/chat/${group.id}`,
          tag: `tsg-meeting-transcriber-self-dm-${post.id}`,
        }))
        .catch(error => console.error('[MeetingTranscriber self-DM push error]', error))
    }

    return NextResponse.json({
      ok: true,
      duplicate,
      recipient: {
        id: recipient.id,
        displayName: recipient.real_name || recipient.display_name,
        kind: 'self',
      },
      poster: { id: tsgUserId, displayName: 'TSG君' },
      post,
      url: `/chat/${group.id}`,
    }, { status: duplicate ? 200 : 201 })
  } catch (error) {
    const status = error instanceof IntegrationError
      ? error.status
      : error instanceof Error && error.message.endsWith(' is invalid')
        ? 400
        : 500
    if (status === 500) {
      console.error('[MeetingTranscriber self-DM integration error]', error)
    }
    return NextResponse.json({
      error: status === 500
        ? 'Failed to create MeetingTranscriber self-DM'
        : error instanceof Error
          ? error.message
          : 'Failed to create MeetingTranscriber self-DM',
    }, { status })
  }
}
