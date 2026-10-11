import { adminClient } from '@/lib/supabase/admin'
import { CODEX_MTG_BOT_USER_ID } from '@/lib/codex-mtg-policy'
import { getBusinessContext } from '@/lib/business-api/context'

type Attachment = {
  driveId?: string
  url?: string
  viewUrl?: string
  webViewLink?: string
  name?: string
  type?: string
}

export function businessPostAuthor(user: { id: string; display_name?: string | null; picture_url?: string | null }) {
  return getBusinessContext()
    ? { id: CODEX_MTG_BOT_USER_ID, display_name: 'TSG君', picture_url: null }
    : { id: user.id, display_name: user.display_name, picture_url: user.picture_url }
}

export function businessPostContent(content: string) {
  const context = getBusinessContext()
  if (!context) return content
  // The registered PC is server state. Discard a caller-supplied leading badge.
  const text = content.replace(/^(?:【PC:[^\r\n】]*】\s*)+/, '')
  return `【PC: ${context.pcName}】\n${text}`.trimEnd()
}

export function isOwnBusinessPost(post: { user_id: string; content?: string | null }) {
  const context = getBusinessContext()
  return Boolean(context && post.user_id === CODEX_MTG_BOT_USER_ID
    && (post.content === `【PC: ${context.pcName}】` || post.content?.startsWith(`【PC: ${context.pcName}】\n`)))
}

function sameAttachment(left: Attachment, right: Attachment) {
  return ['driveId', 'url', 'viewUrl', 'webViewLink', 'name', 'type'].every(key => (
    (left[key as keyof Attachment] || '') === (right[key as keyof Attachment] || '')
  ))
}

function urlMatchesDriveId(value: string | undefined, driveId: string) {
  if (!value) return true
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com' || url.port || url.username || url.password) return false
    if (['/uc', '/thumbnail', '/open'].includes(url.pathname)) return url.searchParams.get('id') === driveId
    return url.pathname === `/file/d/${driveId}/view`
  } catch { return false }
}

/** Browser attachment handling remains unchanged; MCP accepts only its own uploads.
 * Unchanged old attachments may be retained, but cannot authorize a different ID/URL.
 */
export async function validateBusinessAttachments(attachments: Attachment[], existing: Attachment[] = []) {
  const context = getBusinessContext()
  if (!context) return null
  const additions = attachments.filter(attachment => !existing.some(previous => sameAttachment(attachment, previous)))
  if (additions.length === 0) return null
  if (additions.some(attachment => !attachment.driveId || !/^[A-Za-z0-9_-]+$/.test(attachment.driveId)
    || !urlMatchesDriveId(attachment.url, attachment.driveId)
    || !urlMatchesDriveId(attachment.viewUrl, attachment.driveId)
    || !urlMatchesDriveId(attachment.webViewLink, attachment.driveId))) {
    return { error: 'MCPの添付には、この接続でアップロードしたファイルを指定してください', status: 400 }
  }
  const ids = [...new Set(additions.map(attachment => attachment.driveId!))]
  const { data, error } = await adminClient.from('gw_data_business_uploads')
    .select('drive_id').eq('connection_id', context.connectionId).in('drive_id', ids)
  if (error) return { error: '添付ファイルの所有権を確認できませんでした', status: 500 }
  const ownedIds = new Set((data || []).map(row => row.drive_id))
  return ids.every(id => ownedIds.has(id)) ? null
    : { error: '別の接続のファイルは添付できません', status: 403 }
}

export function canDeleteBusinessDriveFiles() {
  // Posts can share files. MCP deletes references only, even for its own uploads.
  return !getBusinessContext()
}
