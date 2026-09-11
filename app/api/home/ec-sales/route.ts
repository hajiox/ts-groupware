import { NextResponse } from 'next/server'
import { getUserSession } from '@/lib/session'
import { adminClient } from '@/lib/supabase/admin'
import { getGoogleCalendarId } from '@/lib/google-calendar'
import { isAutoGoogleCalendarSyncEnabled, syncGoogleCalendarRange } from '@/lib/google-calendar-import'
import { calendarSalesByDay, resolveCalendarSale, type CalendarSaleEvent } from '@/lib/shift-calendar-sales'
import { shiftEcSaleDisplayLabel, type ShiftEcSaleOption } from '@/lib/shift-sales'

export const maxDuration = 60

export async function GET() {
  const user = await getUserSession()
  if (!user) return NextResponse.json({ error: '認証が必要です' }, { status: 401 })

  const date = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)
  const rangeStart = `${date}T00:00:00+09:00`
  const rangeEnd = new Date(Date.parse(rangeStart) + 86_400_000).toISOString()
  let warning: string | null = null
  let syncedAt: string | null = null

  try {
    if (isAutoGoogleCalendarSyncEnabled()) {
      try {
        const result = await syncGoogleCalendarRange({ rangeStart, rangeEnd, requestedBy: user.id })
        syncedAt = result.synced_at || null
        if (result.sync_in_progress) warning = 'カレンダー同期中です。保存済みの情報を表示しています。'
      } catch {
        warning = '最新情報を取得できませんでした。保存済みの情報を表示しています。'
      }
    } else {
      warning = 'カレンダー自動同期が停止中です。保存済みの情報を表示しています。'
    }

    const events: CalendarSaleEvent[] = []
    for (let offset = 0; ; offset += 1000) {
      const page = await adminClient.from('gw_calendar_events')
        .select('title,starts_at,ends_at,all_day').eq('source', 'google_calendar')
        .like('external_id', `${getGoogleCalendarId()}:%`)
        .lt('starts_at', rangeEnd).gt('ends_at', rangeStart).order('id').range(offset, offset + 999)
      if (page.error) throw page.error
      events.push(...(page.data || []))
      if ((page.data || []).length < 1000) break
    }
    const master = await adminClient.from('gw_shift_ec_sales')
      .select('id,label,color,start_time,end_time,sort_order,is_active')
    if (master.error) throw master.error
    const options = (master.data || []) as ShiftEcSaleOption[]
    const resolved = new Map(events.flatMap(event => {
      const sale = resolveCalendarSale(event.title, options)
      return sale ? [[sale.id, sale] as const] : []
    }))
    const daily = calendarSalesByDay(events, options, date, date)[date] || {}
    const sales = [...resolved.values()].filter(sale => daily[sale.id])
      .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label, 'ja'))
      .map(sale => ({ id: sale.id, color: sale.color, label: shiftEcSaleDisplayLabel({ ...sale, ...daily[sale.id] }) }))

    return NextResponse.json({ date, sales, warning, syncedAt }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ error: 'ECセール情報を取得できませんでした。' }, { status: 503 })
  }
}
