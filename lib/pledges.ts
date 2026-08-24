export type PledgeCheckItem = {
  id: string
  text: string
}

export function compactPledgeName(value: string | null | undefined) {
  return (value || '').replace(/[\s\u3000]/g, '')
}

export function normalizePledgeItems(value: unknown): PledgeCheckItem[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    const text = typeof row.text === 'string' ? row.text.trim().slice(0, 500) : ''
    if (!text) return []
    const candidate = typeof row.id === 'string' ? row.id.trim().slice(0, 80) : ''
    const id = candidate || `item-${index + 1}`
    if (seen.has(id)) return []
    seen.add(id)
    return [{ id, text }]
  })
}

export function jstDateText(value: Date | string = new Date()) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(typeof value === 'string' ? new Date(value) : value)
}

