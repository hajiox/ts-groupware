import { adminClient } from '@/lib/supabase/admin'

export function getDeviceIdFromRequest(request: Request) {
  const deviceId = request.headers.get('x-tsg-device-id')?.trim() || ''
  return /^[a-zA-Z0-9_-]{8,128}$/.test(deviceId) ? deviceId : null
}

function isMissingDeviceReadTable(error: { code?: string; message?: string } | null) {
  if (!error) return false
  return error.code === '42P01'
    || error.code === 'PGRST205'
    || /gw_device_read_status|schema cache|does not exist/i.test(error.message || '')
}

export async function markGroupRead(userId: string, groupId: string, deviceId?: string | null) {
  const lastReadAt = new Date().toISOString()

  const userReadPromise = adminClient
    .from('gw_read_status')
    .upsert({
      user_id: userId,
      group_id: groupId,
      last_read_at: lastReadAt,
    }, { onConflict: 'user_id,group_id' })
    .then(undefined, e => console.error('[Read status update error]', e))

  if (!deviceId) {
    await userReadPromise
    return
  }

  const { error } = await adminClient
    .from('gw_device_read_status')
    .upsert({
      user_id: userId,
      group_id: groupId,
      device_id: deviceId,
      last_read_at: lastReadAt,
    }, { onConflict: 'user_id,group_id,device_id' })

  if (error && !isMissingDeviceReadTable(error)) {
    console.error('[Device read status update error]', error)
  }

  await userReadPromise
}

export async function seedDeviceReadStatus(userId: string, deviceId?: string | null) {
  if (!deviceId) return

  const { data: existing, error: existingError } = await adminClient
    .from('gw_device_read_status')
    .select('group_id')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .limit(1)

  if (existingError) {
    if (!isMissingDeviceReadTable(existingError)) {
      console.error('[Device read seed check error]', existingError)
    }
    return
  }
  if (existing && existing.length > 0) return

  const { data: userStatuses, error: userStatusError } = await adminClient
    .from('gw_read_status')
    .select('group_id, last_read_at')
    .eq('user_id', userId)

  if (userStatusError || !userStatuses?.length) return

  const { error } = await adminClient
    .from('gw_device_read_status')
    .upsert(userStatuses.map(row => ({
      user_id: userId,
      group_id: row.group_id,
      device_id: deviceId,
      last_read_at: row.last_read_at,
    })), { onConflict: 'user_id,group_id,device_id' })

  if (error && !isMissingDeviceReadTable(error)) {
    console.error('[Device read seed error]', error)
  }
}

export function shouldFallbackDeviceRead(error: { code?: string; message?: string } | null) {
  return isMissingDeviceReadTable(error)
}
