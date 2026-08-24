import { adminClient } from '@/lib/supabase/admin'
import { DEFAULT_USER_DEPARTMENT, USER_DEPARTMENTS, type UserDepartment } from '@/lib/departments'
import { mentionDisplayName } from '@/lib/mention-names'
import { sendPushNotificationToUser } from '@/lib/web-push'

type MentionUserRow = {
  id: string
  display_name: string | null
  real_name: string | null
  department?: string | null
}

export type MentionedUser = {
  id: string
  displayName: string
}

type MentionContextType = 'board' | 'chat' | 'dm'

const HONORIFIC_SUFFIX_RE = /(さん|様|さま|君|くん|ちゃん)$/
const MENTION_AFTER_BOUNDARY_RE = '(?=$|[\\s　、。,.!！?？)）\\]】」』])'

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function displayName(user: MentionUserRow) {
  return mentionDisplayName(user.real_name || user.display_name || '')
}

function stripHonorific(value: string) {
  return value.trim().replace(HONORIFIC_SUFFIX_RE, '')
}

function mentionAliases(user: MentionUserRow) {
  const aliases = new Set<string>()
  for (const value of [user.real_name, user.display_name]) {
    const base = stripHonorific(value || '')
    if (!base) continue
    aliases.add(base)
    aliases.add(mentionDisplayName(base))

    const compact = base.replace(/[\s　]+/g, '')
    if (compact && compact !== base) aliases.add(compact)
  }
  return [...aliases]
}

function contentMentionsAlias(content: string, alias: string) {
  const pattern = `(^|[\\s　])@${escapeRegExp(alias)}(?:さん|様|さま|君|くん|ちゃん)?${MENTION_AFTER_BOUNDARY_RE}`
  return new RegExp(pattern, 'u').test(content)
}

function contentMentionsDepartment(content: string, department: UserDepartment) {
  const pattern = `(^|[\\s　])@${escapeRegExp(department)}${MENTION_AFTER_BOUNDARY_RE}`
  return new RegExp(pattern, 'u').test(content)
}

export async function findMentionedUsersInGroup(groupId: string, content: string, senderId: string): Promise<MentionedUser[]> {
  const text = content.trim()
  if (!text || !text.includes('@')) return []

  const { data: memberships } = await adminClient
    .from('gw_group_members')
    .select('user_id')
    .eq('group_id', groupId)

  const memberIds = [...new Set((memberships || [])
    .map(member => member.user_id)
    .filter((id): id is string => Boolean(id && id !== senderId)))]

  if (memberIds.length === 0) return []

  const { data: users } = await adminClient
    .from('gw_users')
    .select('id, display_name, real_name, department, status')
    .in('id', memberIds)
    .eq('status', 'approved')

  const targetDepartments = USER_DEPARTMENTS.filter(department => contentMentionsDepartment(text, department))
  const mentioned = new Map<string, MentionedUser>()

  for (const user of (users || []) as Array<MentionUserRow & { status?: string }>) {
    const aliases = mentionAliases(user)
    const department = (user.department || DEFAULT_USER_DEPARTMENT) as UserDepartment
    if (targetDepartments.includes(department) || aliases.some(alias => contentMentionsAlias(text, alias))) {
      const name = displayName(user)
      mentioned.set(user.id, { id: user.id, displayName: name || 'メンバー' })
    }
  }

  return [...mentioned.values()]
}

export async function sendMentionNotifications(
  users: MentionedUser[],
  params: {
    senderId?: string
    senderName: string
    content: string
    url: string
    postId: string
    mutePostId?: string
    groupId?: string
    groupName?: string | null
    contextType?: MentionContextType
    contextLabel?: string
  }
) {
  if (users.length === 0) return

  const snippet = (params.content.trim() || 'ファイルを送信しました').slice(0, 80)
  const senderName = params.senderName || 'メンバー'
  const contextLabel = params.contextLabel || 'TSG'
  const locationLabel = params.groupName ? `${contextLabel}「${params.groupName}」` : contextLabel

  await recordMentionHistory(users, {
    ...params,
    senderName,
    contextLabel,
    contentSnippet: snippet,
  }).catch(error => {
    console.error('[Mention history save error]', error)
  })

  const results = await Promise.allSettled(
    users.map(user => sendPushNotificationToUser(user.id, {
      title: `${locationLabel}でメンション`,
      body: `${senderName}: ${snippet}`,
      url: params.url,
      tag: `tsg-mention-${params.postId}`,
    }, params.mutePostId || params.postId))
  )

  const failed = results.filter(result => result.status === 'rejected')
  if (failed.length > 0) {
    console.error('[Mention push error]', { failed: failed.length, total: users.length })
  }
}

export async function pruneMentionHistory(userIds: string[] | string, keep = 30) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))]
  for (const userId of ids) {
    const { data: staleRows, error: selectError } = await adminClient
      .from('gw_mentions')
      .select('id')
      .eq('mentioned_user_id', userId)
      .order('created_at', { ascending: false })
      .range(keep, 10000)

    if (selectError) throw selectError

    const staleIds = (staleRows || []).map(row => row.id).filter(Boolean)
    if (staleIds.length === 0) continue

    const { error: deleteError } = await adminClient
      .from('gw_mentions')
      .delete()
      .in('id', staleIds)

    if (deleteError) throw deleteError
  }
}

async function recordMentionHistory(
  users: MentionedUser[],
  params: {
    senderId?: string
    senderName: string
    groupId?: string
    groupName?: string | null
    postId: string
    mutePostId?: string
    contextType?: MentionContextType
    contextLabel: string
    contentSnippet: string
    url: string
  },
) {
  if (users.length === 0) return

  const contextType = params.contextType || (
    params.contextLabel === 'Chat' ? 'chat' :
    params.contextLabel === 'DM' ? 'dm' :
    'board'
  )

  const rows = users.map(user => ({
    mentioned_user_id: user.id,
    sender_id: params.senderId || null,
    sender_name: params.senderName,
    group_id: params.groupId || null,
    group_name: params.groupName || null,
    post_id: params.postId,
    target_post_id: params.mutePostId || params.postId,
    context_type: contextType,
    context_label: params.contextLabel,
    content_snippet: params.contentSnippet,
    url: params.url,
    updated_at: new Date().toISOString(),
  }))

  const { error } = await adminClient
    .from('gw_mentions')
    .upsert(rows, { onConflict: 'mentioned_user_id,post_id' })

  if (error) throw error

  await pruneMentionHistory(users.map(user => user.id))
}
