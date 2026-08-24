import { adminClient } from '@/lib/supabase/admin'

export function getDeviceIdFromRequest(request: Request) {
  const deviceId = request.headers.get('x-tsg-device-id')?.trim() || ''
  return /^[a-zA-Z0-9_-]{8,128}$/.test(deviceId) ? deviceId : null
}

async function upsertUserReadStatus(rows: { user_id: string; group_id: string; last_read_at: string }[]) {
  const { error } = await adminClient
    .from('gw_read_status')
    .upsert(rows, { onConflict: 'user_id,group_id' })

  if (error) {
    console.error('[Read status update error]', error)
  }

  return error
}

// 既読は同じアカウントの全端末で共有する。device_idはPush購読だけに使う。
export async function markGroupsRead(userId: string, groupIds: string[]) {
  const uniqueGroupIds = [...new Set(groupIds)].filter(Boolean)
  const lastReadAt = new Date().toISOString()

  if (uniqueGroupIds.length === 0) {
    return { count: 0, lastReadAt, error: null }
  }

  const error = await upsertUserReadStatus(uniqueGroupIds.map(groupId => ({
      user_id: userId,
      group_id: groupId,
      last_read_at: lastReadAt,
  })))

  return {
    count: uniqueGroupIds.length,
    lastReadAt,
    error: error?.message || null,
  }
}

export async function markGroupRead(userId: string, groupId: string) {
  return markGroupsRead(userId, [groupId])
}
