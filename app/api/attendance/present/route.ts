import { NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'
import { normalizeLinePictureUrl } from '@/lib/line-picture'

type PunchType = 'clock_in' | 'clock_out'

type PunchRow = {
  id: string
  user_id: string
  device_id: string | null
  punch_type: PunchType
  punched_at: string
  work_date: string
  created_at: string
}

type UserRow = {
  id: string
  display_name: string
  real_name: string | null
  picture_url: string | null
  department: string | null
  status: string | null
}

type DeviceRow = {
  id: string
  name: string
  location: string
}

const departmentOrder: Record<string, number> = {
  フロア: 0,
  製造: 1,
  道の駅: 2,
}

function getJstDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  return `${year}-${month}-${day}`
}

export async function GET() {
  const sessionUser = await getUserSession()
  if (!sessionUser) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 })
  }

  const workDate = getJstDate()
  const [
    { data: punches, error: punchesError },
    { data: users, error: usersError },
    { data: devices, error: devicesError },
  ] = await Promise.all([
    adminClient
      .from('gw_attendance_punches')
      .select('id, user_id, device_id, punch_type, punched_at, work_date, created_at')
      .eq('work_date', workDate)
      .eq('is_voided', false)
      .order('punched_at', { ascending: true })
      .order('created_at', { ascending: true }),
    adminClient
      .from('gw_users')
      .select('id, display_name, real_name, picture_url, department, status')
      .eq('status', 'approved'),
    adminClient
      .from('gw_attendance_devices')
      .select('id, name, location'),
  ])

  const dbError = punchesError || usersError || devicesError
  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  const lastPunchByUser = new Map<string, PunchRow>()
  for (const punch of (punches || []) as PunchRow[]) {
    lastPunchByUser.set(punch.user_id, punch)
  }

  const userMap = new Map(((users || []) as UserRow[]).map((user) => [user.id, user]))
  const deviceMap = new Map(((devices || []) as DeviceRow[]).map((device) => [device.id, device]))

  const present = Array.from(lastPunchByUser.values())
    .filter((punch) => punch.punch_type === 'clock_in')
    .map((punch) => {
      const user = userMap.get(punch.user_id)
      if (!user) return null
      const device = punch.device_id ? deviceMap.get(punch.device_id) || null : null
      return {
        userId: user.id,
        displayName: user.real_name || user.display_name,
        pictureUrl: normalizeLinePictureUrl(user.picture_url),
        department: user.department || '製造',
        clockedInAt: punch.punched_at,
        deviceName: device?.name || null,
        location: device?.location || null,
      }
    })
    .filter((row): row is NonNullable<typeof row> => !!row)
    .sort((a, b) => {
      const departmentDiff = (departmentOrder[a.department] ?? 99) - (departmentOrder[b.department] ?? 99)
      if (departmentDiff !== 0) return departmentDiff
      return a.displayName.localeCompare(b.displayName, 'ja')
    })

  return NextResponse.json({
    workDate,
    serverNow: new Date().toISOString(),
    count: present.length,
    present,
  })
}
