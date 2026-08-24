type PaperDeliveryIdentity = {
  id: string
  sent_at: string
}

function tokyoDateToken(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '00000000'
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const byType = new Map(parts.map((part) => [part.type, part.value]))
  return `${byType.get('year') || '0000'}${byType.get('month') || '00'}${byType.get('day') || '00'}`
}

export function pledgePaperNumber(delivery: PaperDeliveryIdentity) {
  const idToken = delivery.id.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase()
  return `TSG-PLG-${tokyoDateToken(delivery.sent_at)}-${idToken}`
}

export function normalizePledgePaperNumber(value: string | null | undefined) {
  return (value || '').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

