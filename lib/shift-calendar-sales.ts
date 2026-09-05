import { createHash } from 'node:crypto'
import { SHIFT_EC_SALE_OPTIONS, normalizeShiftEcSaleIds, normalizeShiftEcSaleTimes, type ShiftEcSaleOption, type ShiftEcSaleTimes } from './shift-sales'

export type CalendarSaleEvent = {
  title: string
  starts_at: string
  ends_at: string
  all_day: boolean
}

export type CalendarSaleState = { automatic: ShiftEcSaleTimes; suppressed: string[] }

export function calendarSaleName(title: string) {
  return title.normalize('NFKC').replace(/\((?:設定済み?|登録済み?|設定完了)\)/g, '').trim().slice(0, 100)
}

export function calendarSaleKey(title: string) {
  return calendarSaleName(title).toLowerCase().replace(/sall/g, 'sale').replace(/付く/g, 'つく').replace(/\s+/g, '')
}

export function isCalendarSale(title: string) {
  return /sale|sall|セール|お買い物マラソン|プライムデー|black\s*friday|ブラックフライデー|爆買|超paypay|5の(?:付|つ)く日|プレミアムな日曜日|月末市|真ん中市|販促日/i.test(title)
}

export function resolveCalendarSale(title: string, options: ShiftEcSaleOption[]): ShiftEcSaleOption | null {
  const label = calendarSaleName(title)
  const key = calendarSaleKey(label)
  const original = SHIFT_EC_SALE_OPTIONS.find(option => calendarSaleKey(option.label) === key)
  const match = options.find(option => calendarSaleKey(option.label) === key)
    || (original && options.find(option => option.id === original.id))
  if (match) return match.is_active ? match : null
  if (!isCalendarSale(label)) return null
  const id = `calendar_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
  const existing = options.find(option => option.id === id)
  if (existing) return existing.is_active ? existing : null
  return { id, label, color: /amazon|アマゾン/i.test(label) ? 'green' : /楽天|rakuten|ブランド館/i.test(label) ? 'red' : 'orange', start_time: null, end_time: null, sort_order: 200, is_active: true }
}

const DAY_MS = 86_400_000
const jstDate = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10)
const jstTime = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(11, 16)

export function calendarSalesByDay(events: CalendarSaleEvent[], options: ShiftEcSaleOption[], start: string, end: string) {
  const days: Record<string, ShiftEcSaleTimes> = {}
  for (let ms = Date.parse(`${start}T00:00:00+09:00`); ms <= Date.parse(`${end}T00:00:00+09:00`); ms += DAY_MS) {
    const date = jstDate(ms)
    days[date] = {}
    for (const event of events) {
      const from = Date.parse(event.starts_at), to = Date.parse(event.ends_at)
      if (!(from < ms + DAY_MS && to > ms)) continue
      const option = resolveCalendarSale(event.title, options)
      if (!option) continue
      const time = {
        start_time: !event.all_day && jstDate(from) === date ? jstTime(from) : null,
        end_time: !event.all_day && jstDate(to) === date ? jstTime(to) : null,
      }
      const previous = days[date][option.id]
      // One cell per sale: repeated/overlapping occurrences use the outer boundaries.
      days[date][option.id] = previous ? {
        start_time: previous.start_time && time.start_time ? [previous.start_time, time.start_time].sort()[0] : null,
        end_time: previous.end_time && time.end_time ? [previous.end_time, time.end_time].sort().at(-1)! : null,
      } : time
    }
  }
  return days
}

function timeAt(times: ShiftEcSaleTimes, id: string) {
  return { start_time: times[id]?.start_time || null, end_time: times[id]?.end_time || null }
}

export function reconcileCalendarSales(tags: unknown, rawTimes: unknown, rawState: unknown, next: ShiftEcSaleTimes) {
  const selected = new Set(normalizeShiftEcSaleIds(tags))
  const times = normalizeShiftEcSaleTimes(rawTimes, [...selected])
  const state = rawState && typeof rawState === 'object' ? rawState as Partial<CalendarSaleState> : {}
  const suppressed = new Set(normalizeShiftEcSaleIds(state.suppressed))
  const previous = state.automatic && typeof state.automatic === 'object' ? state.automatic : {}
  for (const id of Object.keys(previous)) {
    if (!selected.has(id)) { suppressed.add(id); continue }
    if (JSON.stringify(timeAt(times, id)) !== JSON.stringify(timeAt(previous, id))) continue
    selected.delete(id)
    delete times[id]
  }
  const automatic: ShiftEcSaleTimes = {}
  for (const [id, time] of Object.entries(next)) {
    if (selected.has(id)) { suppressed.delete(id); continue }
    if (suppressed.has(id)) continue
    selected.add(id)
    automatic[id] = time
    if (time.start_time || time.end_time) times[id] = time
  }
  return { ec_sale_tags: [...selected], ec_sale_times: times, calendar_sale_state: { automatic, suppressed: [...suppressed] } }
}
