export type ShiftEcSaleColor = 'red' | 'green' | 'orange'

export type ShiftEcSaleOption = {
  id: string
  label: string
  color: ShiftEcSaleColor
  start_time: string | null
  end_time: string | null
  sort_order: number
  is_active: boolean
}

export type ShiftEcSaleTime = {
  start_time: string | null
  end_time: string | null
}

export type ShiftEcSaleTimes = Record<string, ShiftEcSaleTime>

export const RETIRED_EC_SALE_FROM = '2026-10-01'

// This policy applies only to EC sale labels, never to general TikTok SNS work.
export function isShiftEcSaleOperational(option: Pick<ShiftEcSaleOption, 'id' | 'label'>, date: string) {
  const label = option.label.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '')
    .replace(/^(?:ec|ecセール|通販)[：:]/, '')
  const id = option.id.toLowerCase()
  if (/^(?:makeshop|メイクショップ)/.test(label) || id === 'makeshop') return false
  const retired = /^(?:メルカリ|mercari(?:shops)?|qoo10|キューテン|tiktok(?:shop|ショップ)|ティックトックショップ)/.test(label)
    || ['mercari', 'qoo10', 'tiktok', 'tiktok_shop'].includes(id)
  return !retired || date < RETIRED_EC_SALE_FROM
}

export function visibleShiftEcSaleIds(value: unknown, options: ShiftEcSaleOption[], date: string, automaticIds: string[] = []) {
  const automatic = new Set(automaticIds)
  const byId = new Map(options.map(option => [option.id, option]))
  return normalizeShiftEcSaleIds(value).filter(id => {
    const option = byId.get(id)
    // Previously saved manual notes remain visible; only retired automatic notes are hidden.
    return !option || !automatic.has(id) || isShiftEcSaleOperational(option, date)
  })
}

export function shiftEcSalePickerOptions(options: ShiftEcSaleOption[], date: string, selectedIds: string[], automaticIds: string[] = []) {
  const selected = new Set(visibleShiftEcSaleIds(selectedIds, options, date, automaticIds))
  return options.filter(option => (option.is_active && isShiftEcSaleOperational(option, date)) || selected.has(option.id))
}

export const SHIFT_EC_SALE_OPTIONS: ShiftEcSaleOption[] = [
  { id: 'brand_hall_store_sale', label: 'ブランド館店舗SALE', color: 'red', start_time: null, end_time: null, sort_order: 5, is_active: true },
  { id: 'rakuten_marathon', label: '楽天お買い物マラソン', color: 'red', start_time: null, end_time: null, sort_order: 10, is_active: true },
  { id: 'rakuten_super_sale', label: '楽天スーパーSALL', color: 'red', start_time: null, end_time: null, sort_order: 20, is_active: true },
  { id: 'rakuten_black_friday', label: '楽天BLACKFRIDAY', color: 'red', start_time: null, end_time: null, sort_order: 30, is_active: true },
  { id: 'amazon_smile_sale', label: 'AmazonスマイルSALL', color: 'green', start_time: null, end_time: null, sort_order: 40, is_active: true },
  { id: 'amazon_prime_day', label: 'Amazonプライムデー', color: 'green', start_time: null, end_time: null, sort_order: 50, is_active: true },
  { id: 'amazon_black_friday', label: 'Amazonブラックフライデー', color: 'green', start_time: null, end_time: null, sort_order: 60, is_active: true },
  { id: 'yahoo_five_day', label: 'Yahoo 5の付く日', color: 'orange', start_time: null, end_time: null, sort_order: 70, is_active: true },
  { id: 'yahoo_premium_sunday', label: 'Yahooプレミアムな日曜日', color: 'orange', start_time: null, end_time: null, sort_order: 80, is_active: true },
  { id: 'yahoo_super_paypay', label: 'Yahoo超PayPay祭り', color: 'orange', start_time: null, end_time: null, sort_order: 90, is_active: true },
  { id: 'yahoo_bakugai_week', label: 'Yahoo爆買いWEEK', color: 'orange', start_time: null, end_time: null, sort_order: 100, is_active: true },
]

export function normalizeShiftSaleTime(value: unknown) {
  const time = typeof value === 'string' ? value.trim().slice(0, 5) : ''
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : null
}

export function normalizeShiftEcSaleTimes(value: unknown, selectedIds?: string[]): ShiftEcSaleTimes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const selected = selectedIds ? new Set(normalizeShiftEcSaleIds(selectedIds)) : null
  const normalized: ShiftEcSaleTimes = {}
  for (const [rawId, rawTime] of Object.entries(value).slice(0, 50)) {
    const id = rawId.trim().slice(0, 80)
    if (!id || id === '__proto__' || id === 'constructor' || id === 'prototype' || (selected && !selected.has(id))) continue
    if (!rawTime || typeof rawTime !== 'object' || Array.isArray(rawTime)) continue
    const time = rawTime as Record<string, unknown>
    const startTime = normalizeShiftSaleTime(time.start_time)
    const endTime = normalizeShiftSaleTime(time.end_time)
    if (startTime || endTime) normalized[id] = { start_time: startTime, end_time: endTime }
  }
  return normalized
}

export function shiftEcSaleTimeLabel(option: Pick<ShiftEcSaleOption, 'start_time' | 'end_time'>) {
  const start = normalizeShiftSaleTime(option.start_time)
  const end = normalizeShiftSaleTime(option.end_time)
  if (start && end) return `${start}〜${end}`
  if (start) return `${start}〜`
  if (end) return `〜${end}`
  return ''
}

export function shiftEcSaleDisplayLabel(option: Pick<ShiftEcSaleOption, 'label' | 'start_time' | 'end_time'>) {
  return [option.label, shiftEcSaleTimeLabel(option)].filter(Boolean).join(' ')
}

export function normalizeShiftEcSaleIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, 80))
    .filter(Boolean))]
}

export function shiftEcSaleLabels(value: unknown, options: ShiftEcSaleOption[] = SHIFT_EC_SALE_OPTIONS, times: unknown = {}, date?: string, automaticIds: string[] = []) {
  const occurrenceTimes = normalizeShiftEcSaleTimes(times)
  const labels = new Map(options.map((option) => {
    const occurrence = occurrenceTimes[option.id]
    return [option.id, shiftEcSaleDisplayLabel({
      label: option.label,
      start_time: occurrence?.start_time || null,
      end_time: occurrence?.end_time || null,
    })]
  }))
  const ids = date ? visibleShiftEcSaleIds(value, options, date, automaticIds) : normalizeShiftEcSaleIds(value)
  return ids.map((id) => labels.get(id) || id)
}
