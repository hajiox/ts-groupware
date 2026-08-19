import { adminClient } from '@/lib/supabase/admin'

export function getDeviceIdFromRequest(request: Request) {
  const deviceId = request.headers.get('x-tsg-device-id')?.trim() || ''
  return /^[a-zA-Z0-9_-]{8,128}$/.test(deviceId) ? deviceId : null
}

// 同じアカウントで開いた全端末に既読状態を共有する。
export async function markGroupRead(userId: string, groupId: string) {
  const lastReadAt = new Date().toISOString()

  const { error } = await adminClient
    .from('gw_read_status')
    .upsert({
      user_id: userId,
      group_id: groupId,
      last_read_at: lastReadAt,
    }, { onConflict: 'user_id,group_id' })

  if (error) {
    console.error('[Read status update error]', error)
  }
}
