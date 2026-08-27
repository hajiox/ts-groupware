import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getTsgUserId } from '@/lib/tsg-ai'
import {
  directChatKey,
  normalizeDirectMessageUserName,
  requiredDirectMessageText,
  tsaDirectMessagePostId,
} from '@/lib/tsa-direct-message'

type UserRow = {
  id: string
  display_name: string | null
  real_name: string | null
}

type DirectGroupRow = {
  id: string
  description: string | null
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
  const expected = process.env.TSG_INTEGRATION_SECRET?.trim()
  if (!expected) {
    return NextResponse.json({ error: 'TSG_INTEGRATION_SECRET is not configured' }, { status: 500 })
  }

  const actual = request.headers.get('x-tsg-integration-secret')?.trim() || getBearerToken(request)
  return actual === expected ? null : NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

async function findRecipient(recipientName: string) {
  const normalizedTarget = normalizeDirectMessageUserName(recipientName)
  const { data, error } = await adminClient
    .from('gw_users')
    .select('id,display_name,real_name')
    .eq('status', 'approved')

  if (error) throw new Error(error.message)

  const matches = ((data || []) as UserRow[]).filter(user =>
    normalizeDirectMessageUserName(user.real_name || user.display_name || '') === normalizedTarget,
  )
  if (matches.length !== 1) {
    throw new IntegrationError(`recipientName must identify exactly one approved user (matched ${matches.length})`, 409)
  }
  return matches[0]
}

async function ensureDirectGroup(tsgUserId: string, recipient: UserRow) {
  const key = directChatKey(tsgUserId, recipient.id)
  const { data: existingGroups, error: existingError } = await adminClient
    .from('gw_groups')
    .select('id,description')
    .eq('type', 'chat')
    .eq('description', key)
    .order('created_at', { ascending: true })

  if (existingError) throw new Error(existingError.message)
  if ((existingGroups || []).length > 1) {
    throw new IntegrationError('Multiple direct-message groups exist for the same users', 409)
  }

  let group = ((existingGroups || []) as DirectGroupRow[])[0] || null
  if (!group) {
    const recipientDisplayName = recipient.real_name || recipient.display_name || 'メンバー'
    const { data: created, error: createError } = await adminClient
      .from('gw_groups')
      .insert({
        name: `TSG君 / ${recipientDisplayName}`,
        description: key,
        type: 'chat',
        icon: '💬',
        created_by: tsgUserId,
      })
      .select('id,description')
      .single()

    if (createError || !created) {
      throw new Error(createError?.message || 'Failed to create direct-message group')
    }
    group = created as DirectGroupRow
  }

  const { error: memberError } = await adminClient
    .from('gw_group_members')
    .upsert([
      { group_id: group.id, user_id: tsgUserId, role: 'member' },
      { group_id: group.id, user_id: recipient.id, role: 'member' },
    ], { onConflict: 'group_id,user_id' })
  if (memberError) throw new Error(memberError.message)

  const { data: memberRows, error: memberReadError } = await adminClient
    .from('gw_group_members')
    .select('user_id')
    .eq('group_id', group.id)
  if (memberReadError) throw new Error(memberReadError.message)

  const actualMembers = new Set((memberRows || []).map(member => member.user_id))
  if (actualMembers.size !== 2 || !actualMembers.has(tsgUserId) || !actualMembers.has(recipient.id)) {
    throw new IntegrationError('Direct-message group member verification failed', 409)
  }

  return group
}

export async function POST(request: NextRequest) {
  const authError = authorize(request)
  if (authError) return authError

  try {
    const raw = await request.json()
    const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const sourceKey = requiredDirectMessageText(body.sourceKey, 'sourceKey', 200)
    const recipientName = requiredDirectMessageText(body.recipientName, 'recipientName', 100)
    const content = requiredDirectMessageText(body.content, 'content', 4000)
    if (!/^[A-Za-z0-9:_-]+$/.test(sourceKey)) {
      return NextResponse.json({ error: 'sourceKey is invalid' }, { status: 400 })
    }

    const [recipient, tsgUserId] = await Promise.all([
      findRecipient(recipientName),
      getTsgUserId(),
    ])
    if (!tsgUserId) throw new Error('TSG君 user was not found')
    if (recipient.id === tsgUserId) {
      return NextResponse.json({ error: 'recipientName cannot be TSG君' }, { status: 400 })
    }

    const group = await ensureDirectGroup(tsgUserId, recipient)
    const postId = tsaDirectMessagePostId(sourceKey, recipient.id)
    const { data: existing, error: existingError } = await adminClient
      .from('gw_posts')
      .select('id,group_id,user_id,content,created_at')
      .eq('id', postId)
      .maybeSingle()
    if (existingError) throw new Error(existingError.message)

    let post = existing
    let duplicate = Boolean(post)
    if (post && (post.group_id !== group.id || post.user_id !== tsgUserId || post.content !== content)) {
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
          throw new Error(concurrent.error?.message || 'Concurrent direct message was not found')
        }
        post = concurrent.data
        duplicate = true
      } else if (insertError || !inserted) {
        throw new Error(insertError?.message || 'Failed to create direct message')
      } else {
        post = inserted
        duplicate = false
        await adminClient
          .from('gw_groups')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', group.id)
      }
    }

    if (!post || post.group_id !== group.id || post.user_id !== tsgUserId || post.content !== content) {
      throw new IntegrationError('Integration message identity conflict', 409)
    }

    if (!duplicate) {
      await import('@/lib/web-push')
        .then(({ sendPushNotificationToUser }) => sendPushNotificationToUser(recipient.id, {
          title: 'TSG君',
          body: content.substring(0, 80),
          url: `/chat/${group.id}`,
          tag: `tsg-tsa-direct-message-${post.id}`,
        }))
        .catch(error => console.error('[TSA direct-message push error]', error))
    }

    return NextResponse.json({
      ok: true,
      duplicate,
      recipient: {
        id: recipient.id,
        displayName: recipient.real_name || recipient.display_name,
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
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to create direct message',
    }, { status })
  }
}
