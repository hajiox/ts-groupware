import { adminClient } from '@/lib/supabase/admin'
import { getGoogleCalendarId } from '@/lib/google-calendar'
import { isAutoGoogleCalendarSyncEnabled, syncGoogleCalendarRange } from '@/lib/google-calendar-import'
import { calendarSalesByDay, reconcileCalendarSales, resolveCalendarSale, type CalendarSaleEvent } from '@/lib/shift-calendar-sales'
import type { ShiftEcSaleOption } from '@/lib/shift-sales'
import { isDeepStrictEqual } from 'node:util'

type Period = { id: string; department: string; status: string; start_date: string; end_date: string }

export async function syncFloorShiftSales(period: Period, requestedBy: string, force = false) {
  if (period.department !== 'フロア' || ['confirmed', 'exported', 'archived'].includes(period.status)) return null
  const calendarId = getGoogleCalendarId()
  const rangeStart = `${period.start_date}T00:00:00+09:00`
  const rangeEnd = new Date(Date.parse(`${period.end_date}T00:00:00+09:00`) + 86_400_000).toISOString()
  let warning: string | null = null
  let syncedAt: string | null = null
  if (isAutoGoogleCalendarSyncEnabled()) {
    try {
      const result = await syncGoogleCalendarRange({ rangeStart, rangeEnd, requestedBy, force })
      syncedAt = result.synced_at || null
      if (result.sync_in_progress) warning = 'カレンダー同期中です。保存済みのセール情報を表示しています'
    } catch {
      warning = 'カレンダーの最新情報を取得できませんでした。前回の情報を保持しています。再読込で再試行します'
    }
  } else {
    warning = 'カレンダー自動同期が停止中です。保存済みのセール情報を表示しています'
  }

  // An incomplete or failed refresh cannot remove previously assigned sales.
  if (warning) return { calendar_id: calendarId, synced_at: syncedAt, warning, changed_days: 0 }
  const events: CalendarSaleEvent[] = []
  for (let offset = 0; ; offset += 1000) {
    const page = await adminClient.from('gw_calendar_events')
      .select('title, starts_at, ends_at, all_day').eq('source', 'google_calendar')
      .like('external_id', `${calendarId}:%`).lt('starts_at', rangeEnd).gt('ends_at', rangeStart)
      .order('id').range(offset, offset + 999)
    if (page.error) throw page.error
    events.push(...(page.data || []))
    if ((page.data || []).length < 1000) break
  }
  const master = await adminClient.from('gw_shift_ec_sales').select('id,label,color,start_time,end_time,sort_order,is_active')
  if (master.error) throw master.error
  const options = (master.data || []) as ShiftEcSaleOption[]
  const additions = new Map<string, ShiftEcSaleOption>()
  for (const event of events) {
    const option = resolveCalendarSale(event.title, options)
    if (option && !options.some(existing => existing.id === option.id)) additions.set(option.id, option)
  }
  if (additions.size) {
    const added = await adminClient.from('gw_shift_ec_sales').upsert([...additions.values()], { onConflict: 'id', ignoreDuplicates: true })
    if (added.error) throw added.error
    // Read back active/renamed values in case another editor changed the master.
    const refreshed = await adminClient.from('gw_shift_ec_sales').select('id,label,color,start_time,end_time,sort_order,is_active')
    if (refreshed.error) throw refreshed.error
    options.splice(0, options.length, ...(refreshed.data || []) as ShiftEcSaleOption[])
  }
  const daily = calendarSalesByDay(events, options, period.start_date, period.end_date)
  const requirements = await adminClient.from('gw_shift_requirements')
    .select('work_date,ec_sale_tags,ec_sale_times,calendar_sale_state').eq('period_id', period.id)
  if (requirements.error) throw requirements.error
  const changes = (requirements.data || []).flatMap(row => {
    const next = reconcileCalendarSales(row.ec_sale_tags, row.ec_sale_times, row.calendar_sale_state, daily[row.work_date] || {})
    if (isDeepStrictEqual([row.ec_sale_tags, row.ec_sale_times, row.calendar_sale_state], [next.ec_sale_tags, next.ec_sale_times, next.calendar_sale_state])) return []
    return [{ work_date: row.work_date, previous_tags: row.ec_sale_tags, previous_times: row.ec_sale_times, previous_state: row.calendar_sale_state, ...next }]
  })
  let changed = 0
  if (changes.length) {
    const result = await adminClient.rpc('gw_apply_shift_calendar_sales', { p_period_id: period.id, p_rows: changes })
    if (result.error) throw result.error
    changed = Number(result.data || 0)
  }
  return { calendar_id: calendarId, synced_at: syncedAt, warning, changed_days: changed }
}
