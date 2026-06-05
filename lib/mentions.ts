import { adminClient } from '@/lib/supabase/admin'
import { sendPushNotificationToUser } from '@/lib/web-push'

type MentionUserRow = {
  id: string
  display_name: string | null
  real_name: string | null
}

export type MentionedUser = {
  id: string
  displayName: string
}

const HONORIFIC_SUFFIX_RE = /(ちゃん|さん|さま|様|くん|君)$/
const MENTION_AFTER_BOUNDARY_RE = '(?=$|[\\s　、。,.!！?？:：;；)）\\]】」』])'

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function displayName(user: MentionUserRow) {
  return (user.real_name || user.display_name || '').trim()
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

    const compact = base.replace(/[\s　]+/g, '')
    if (compact && compact !== base) aliases.add(compact)
  }
  return [...aliases]
}

function contentMentionsAlias(content: string, alias: string) {
  const pattern = `(^|[\\s　])@${escapeRegExp(alias)}(?:ちゃん|さん|さま|様|くん|君)?${MENTION_AFTER_BOUNDARY_RE}`
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
    .select('id, display_name, real_name, status')
    .in('id', memberIds)
    .eq('status', 'approved')

  const mentioned: MentionedUser[] = []
  for (const user of (users || []) as Array<MentionUserRow & { status?: string }>) {
    const aliases = mentionAliases(user)
    if (aliases.some(alias => contentMentionsAlias(text, alias))) {
      const name = displayName(user)
      mentioned.push({ id: user.id, displayName: name || 'メンバー' })
    }
  }

  return mentioned
}

export async function sendMentionNotifications(
  users: MentionedUser[],
  params: {
    senderName: string
    content: string
    url: string
    postId: string
    mutePostId?: string
    groupName?: string | null
  }
) {
  if (users.length === 0) return

  const snippet = (params.content.trim() || 'ファイルを送信しました').slice(0, 80)
  const senderName = params.senderName || 'メンバー'
  const bodyPrefix = params.groupName ? `${params.groupName} / ${senderName}` : senderName

  const results = await Promise.allSettled(
    users.map(user => sendPushNotificationToUser(user.id, {
      title: 'メンションされた投稿があります',
      body: `${bodyPrefix}: ${snippet}`,
      url: params.url,
      tag: `tsg-mention-${params.postId}`,
    }, params.mutePostId || params.postId))
  )

  const failed = results.filter(result => result.status === 'rejected')
  if (failed.length > 0) {
    console.error('[Mention push error]', { failed: failed.length, total: users.length })
  }
}
