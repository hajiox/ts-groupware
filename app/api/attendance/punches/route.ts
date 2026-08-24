import { NextRequest, NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'

type PunchType = 'clock_in' | 'clock_out'

type PunchRow = {
  id: string
  user_id: string | null
  device_id: string | null
  punch_type: PunchType
  work_date: string
  punched_at: string
  source_type: string | null
  is_voided: boolean
  memo: string | null
  private_vehicle_place?: string | null
  private_vehicle_distance_km?: number | string | null
  break_override_minutes?: number | null
  void_reason?: string | null
}

type DeviceRow = {
  id: string
  name: string | null
  location: string | null
}

const THIRTY_MINUTE_BREAK_NOTE = '30分休憩'

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

function cleanMonth(value: string | null) {
  const fallback = getJstDate().slice(0, 7)
  return value && /^\d{4}-\d{2}$/.test(value) ? value : fallback
}

function monthRange(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  const start = new Date(Date.UTC(year, monthNumber - 1, 1))
  const end = new Date(Date.UTC(year, monthNumber, 0))
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  }
}

function stripBreakMemoPrefix(value: string | null | undefined, hasThirtyMinuteBreak: boolean) {
  const memo = (value || '').trim()
  if (!hasThirtyMinuteBreak) return memo
  if (memo === THIRTY_MINUTE_BREAK_NOTE) return ''
  if (memo.startsWith(`${THIRTY_MINUTE_BREAK_NOTE} / `)) {
    return memo.slice(`${THIRTY_MINUTE_BREAK_NOTE} / `.length).trim()
  }
  if (memo.startsWith(`${THIRTY_MINUTE_BREAK_NOTE}\n`)) {
    return memo.slice(`${THIRTY_MINUTE_BREAK_NOTE}\n`.length).trim()
  }
  return memo
}

export async function GET(request: NextRequest) {
  const user = await getUserSession()
  if (!user) {
    return NextResponse.json({ error: 'ログインが必要です' }, { status: 401 })
  }

  const month = cleanMonth(request.nextUrl.searchParams.get('month'))
  const includeVoided = request.nextUrl.searchParams.get('include_voided') === '1'
  const { startDate, endDate } = monthRange(month)

  let query = adminClient
    .from('gw_attendance_punches')
    .select('id, user_id, device_id, punch_type, work_date, punched_at, source_type, is_voided, memo, private_vehicle_place, private_vehicle_distance_km, break_override_minutes, void_reason')
    .eq('user_id', user.id)
    .gte('work_date', startDate)
    .lte('work_date', endDate)
    .order('punched_at', { ascending: false })
    .limit(500)

  if (!includeVoided) query = query.eq('is_voided', false)

  const { data: punches, error: punchesError } = await query
  if (punchesError) {
    return NextResponse.json({ error: punchesError.message }, { status: 500 })
  }

  const punchRows = (punches || []) as PunchRow[]
  const deviceIds = Array.from(new Set(punchRows.map((punch) => punch.device_id).filter((id): id is string => Boolean(id))))
  const devicesById: Record<string, DeviceRow> = {}

  if (deviceIds.length > 0) {
    const { data: devices, error: devicesError } = await adminClient
      .from('gw_attendance_devices')
      .select('id, name, location')
      .in('id', deviceIds)

    if (devicesError) {
      return NextResponse.json({ error: devicesError.message }, { status: 500 })
    }

    for (const device of (devices || []) as DeviceRow[]) {
      devicesById[device.id] = device
    }
  }

  return NextResponse.json({
    month,
    startDate,
    endDate,
    includeVoided,
    user: {
      id: user.id,
      display_name: user.display_name,
      real_name: user.real_name || null,
      department: user.department || null,
    },
    punches: punchRows.map((punch) => {
      const hasThirtyMinuteBreak = punch.break_override_minutes === 30
      return {
        ...punch,
        memo: stripBreakMemoPrefix(punch.memo, hasThirtyMinuteBreak) || null,
        has_thirty_minute_break: hasThirtyMinuteBreak,
        device: punch.device_id ? devicesById[punch.device_id] || null : null,
      }
    }),
    summary: {
      total: punchRows.length,
      active: punchRows.filter((punch) => !punch.is_voided).length,
      voided: punchRows.filter((punch) => punch.is_voided).length,
    },
  })
}
