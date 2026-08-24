import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { sendPushNotificationToUser } from '@/lib/web-push'

type DeviceRow = {
  id: string
  code?: string | null
  name?: string | null
  location?: string | null
}

type AdminUserRow = {
  id: string
}

function isRoadsideStationDevice(device: DeviceRow) {
  const marker = `${device.code || ''} ${device.name || ''} ${device.location || ''}`
  return marker.includes('michinoeki') || marker.includes('道の駅')
}

async function getDevice(deviceKey: string) {
  const { data, error } = await adminClient
    .from('gw_attendance_devices')
    .select('id, code, name, location, device_key, is_active')
    .eq('device_key', deviceKey)
    .eq('is_active', true)
    .single()

  if (error || !data) return null
  return data as DeviceRow
}

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ deviceKey: string }> },
) {
  const { deviceKey } = await context.params
  const device = await getDevice(deviceKey)
  if (!device) {
    return NextResponse.json({ error: 'タイムレコーダー端末が見つかりません' }, { status: 404 })
  }

  if (!isRoadsideStationDevice(device)) {
    return NextResponse.json({ error: 'SOS通知は道の駅端末のみ利用できます' }, { status: 403 })
  }

  const { data: admins, error: adminError } = await adminClient
    .from('gw_users')
    .select('id')
    .eq('status', 'approved')
    .in('role', ['executive', 'admin'])

  if (adminError) {
    return NextResponse.json({ error: adminError.message }, { status: 500 })
  }

  const adminRows = (admins || []) as AdminUserRow[]
  const tagBase = `tsg-time-clock-sos-${device.id}-${Date.now()}`
  const results = await Promise.allSettled(
    adminRows.map((admin) =>
      sendPushNotificationToUser(admin.id, {
        title: 'TSG SOS',
        body: '道の駅タイムレコーダーでSOSが押されました。',
        url: '/admin',
        tag: tagBase,
        icon: '/icon-192.png?v=20260618-tsg',
      }),
    ),
  )

  const failed = results.filter((result) => result.status === 'rejected').length
  return NextResponse.json({
    ok: true,
    notified: adminRows.length - failed,
    failed,
  })
}
